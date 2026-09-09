// v0.1.593 — Vorgangs-Watcher (Operator 2026-09-09): Der Nutzer wird
// benachrichtigt, wenn ein Import/Vorgang fuer alle Firmen durchgelaufen
// ist — mit kurzer Uebersicht (fertig / fehlgeschlagen / Fehlerquellen).
// Zusaetzlich ist das die Quelle fuer das Workflow-Ereignis
// `import.finished` (je abgeschlossener Firma ein Ereignis).
//
// Es gibt kein zentrales Abschluss-Signal je Vorgang, daher Polling der
// juengsten eigenen Vorgaenge im Minutentakt; gesehene Vorgaenge werden
// unter <userData>/transaction-watcher.json gemerkt.

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alert } from "../shared/types";
import { fetchAllTransactionEntities } from "./transaction-entities";

const TICK_MS = 60_000;
const FIRST_TICK_MS = 45_000;
const MAX_AGE_MS = 3 * 86_400_000;

interface TxRow {
  id: string;
  name?: string | null;
  startTime?: string | null;
  companyCount?: number | null;
  shared?: unknown;
}
interface EntityRow {
  companyId: string;
  state?: string;
}
interface ErrorRow {
  companyId?: string;
  producer?: string;
  stage?: string;
  message?: string;
  errorMessage?: string;
}

export interface TransactionWatcherDeps {
  gatewayRequest: <T>(path: string) => Promise<T>;
  isSignedIn: () => boolean;
  addAlert: (input: { kind: Alert["kind"]; severity: Alert["severity"]; headline: string; rationale: string; sourceRef: string }) => Alert | null;
  notify: (alert: Alert) => void;
  onCompleted: (tx: { transactionId: string; name: string | null }, companies: Array<{ companyId: string; state: string }>) => void;
  audit: (entry: { summary: string; severity: "info" | "warning"; metadata: Record<string, unknown> }) => void;
}

export class TransactionWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;
  private seen: Set<string> | null = null;
  private running = false;

  constructor(private readonly deps: TransactionWatcherDeps, dir?: string) {
    this.path = join(dir ?? app.getPath("userData"), "transaction-watcher.json");
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), FIRST_TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private load(): Set<string> {
    if (this.seen) return this.seen;
    try {
      this.seen = existsSync(this.path) ? new Set(JSON.parse(readFileSync(this.path, "utf8")) as string[]) : new Set();
    } catch {
      this.seen = new Set();
    }
    return this.seen;
  }

  private persist(): void {
    try {
      writeFileSync(this.path, JSON.stringify([...this.load()].slice(-500)), "utf8");
    } catch {
      /* best-effort */
    }
  }

  /** Beim ersten Start: bereits fertige alte Vorgaenge nicht nachtraeglich melden. */
  private async tick(): Promise<void> {
    if (this.running || !this.deps.isSignedIn()) return;
    this.running = true;
    try {
      const seen = this.load();
      const erstlauf = !existsSync(this.path);
      let items: TxRow[] = [];
      try {
        const r = await this.deps.gatewayRequest<{ items?: TxRow[] }>("/v1/transactions?page=1&pageSize=20");
        items = r.items ?? [];
      } catch {
        return;
      }
      const grenze = Date.now() - MAX_AGE_MS;
      let changed = false;
      for (const tx of items) {
        if (!tx.id || seen.has(tx.id)) continue;
        if (tx.startTime && Date.parse(tx.startTime) < grenze) {
          seen.add(tx.id);
          changed = true;
          continue;
        }
        let entities: EntityRow[] = [];
        try {
          entities = await fetchAllTransactionEntities(this.deps.gatewayRequest, tx.id);
        } catch (err) {
          this.deps.audit({ summary: `Vorgangs-Watcher: Firmen von ${tx.id.slice(0, 8)} nicht ladbar: ${err instanceof Error ? err.message : String(err)}`, severity: "warning", metadata: { transactionId: tx.id } });
          continue;
        }
        if (entities.length === 0) continue;
        const fertig = entities.every((e) => e.state === "completed" || e.state === "failed" || e.state === "skipped");
        if (!fertig) continue;
        seen.add(tx.id);
        changed = true;
        if (erstlauf) continue; // Altbestand still uebernehmen
        await this.melden(tx, entities);
        this.deps.onCompleted(
          { transactionId: tx.id, name: tx.name ?? null },
          entities.map((e) => ({ companyId: e.companyId, state: e.state ?? "unknown" })),
        );
      }
      if (changed || erstlauf) this.persist();
    } finally {
      this.running = false;
    }
  }

  private async melden(tx: TxRow, entities: EntityRow[]): Promise<void> {
    const ok = entities.filter((e) => e.state === "completed").length;
    const failed = entities.filter((e) => e.state === "failed").length;
    const skipped = entities.filter((e) => e.state === "skipped").length;
    let fehlerZeilen: string[] = [];
    if (failed > 0) {
      try {
        const r = await this.deps.gatewayRequest<{ items?: ErrorRow[] }>(`/v1/transactions/${encodeURIComponent(tx.id)}/errors`);
        const rows = r.items ?? [];
        const jeQuelle = new Map<string, number>();
        for (const e of rows) {
          const q = e.producer ?? e.stage ?? "unbekannt";
          jeQuelle.set(q, (jeQuelle.get(q) ?? 0) + 1);
        }
        fehlerZeilen = [...jeQuelle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([q, n]) => `${q}: ${n}`);
        const beispiel = rows.find((e) => e.message || e.errorMessage);
        if (beispiel) fehlerZeilen.push(`z. B. ${String(beispiel.message ?? beispiel.errorMessage).slice(0, 160)}`);
      } catch {
        /* Fehlerdetails optional */
      }
    }
    const name = tx.name ? `„${tx.name}“` : tx.id.slice(0, 8);
    const headline = failed === 0 ? `Vorgang ${name} abgeschlossen: ${ok} von ${entities.length} Firmen fertig` : `Vorgang ${name} abgeschlossen: ${ok} fertig, ${failed} fehlgeschlagen`;
    const rationale = [
      `Firmen: ${entities.length} · fertig ${ok}${failed ? ` · fehlgeschlagen ${failed}` : ""}${skipped ? ` · uebersprungen ${skipped}` : ""}.`,
      ...(fehlerZeilen.length > 0 ? ["Fehlerquellen: " + fehlerZeilen.join(" · ")] : []),
      "Details unter Vorgaenge → Alle Vorgaenge.",
    ].join("\n");
    const alert = this.deps.addAlert({
      kind: "import-finished",
      severity: failed > 0 ? "warn" : "info",
      headline: headline.slice(0, 120),
      rationale,
      sourceRef: `transaction:${tx.id}:finished`,
    });
    if (alert) this.deps.notify(alert);
    this.deps.audit({
      summary: `Vorgang ${name} abgeschlossen: ${ok}/${entities.length} fertig, ${failed} fehlgeschlagen`,
      severity: failed > 0 ? "warning" : "info",
      metadata: { transactionId: tx.id, ok, failed, skipped, fehlerquellen: fehlerZeilen },
    });
  }
}
