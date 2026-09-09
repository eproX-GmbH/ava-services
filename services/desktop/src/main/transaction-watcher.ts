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
import { bewertePipeline, beschreibeBefund, fetchPipeline, type VorgangsBefund } from "./transaction-pipeline";

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
  onCompleted: (tx: { transactionId: string; name: string | null }, companies: Array<{ companyId: string; state: string; fehlgeschlageneStufen: string[] }>) => void;
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
        // v0.1.602 — Abschluss = Firmenprofil je Firma im Endzustand (Pipeline-Matrix),
        // nicht der Roll-up-Status der Entities (der meldet Teilfehler als Totalausfall).
        let befund: VorgangsBefund | null = null;
        try {
          befund = bewertePipeline(await fetchPipeline(this.deps.gatewayRequest, tx.id));
        } catch (err) {
          // Fallback: Entities-Roll-up (aeltere Vorgaenge ohne Matrix).
          try {
            const entities: EntityRow[] = await fetchAllTransactionEntities(this.deps.gatewayRequest, tx.id);
            if (entities.length === 0) continue;
            if (!entities.every((e) => e.state === "completed" || e.state === "failed" || e.state === "skipped")) continue;
            befund = {
              abgeschlossen: true, gesamt: entities.length,
              profilFertig: entities.filter((e) => e.state === "completed").length,
              profilFehlgeschlagen: entities.filter((e) => e.state === "failed").length,
              profilOffen: 0, vollstaendig: entities.length, teilfehler: {}, beispiele: {},
              firmen: entities.map((e) => ({ companyId: e.companyId, state: (e.state ?? "pending") as VorgangsBefund["firmen"][number]["state"], vollstaendig: true, fehlgeschlageneStufen: [], fehler: {} })),
            };
          } catch {
            this.deps.audit({ summary: `Vorgangs-Watcher: Vorgang ${tx.id.slice(0, 8)} nicht ladbar: ${err instanceof Error ? err.message : String(err)}`, severity: "warning", metadata: { transactionId: tx.id } });
            continue;
          }
        }
        if (!befund || !befund.abgeschlossen) continue;
        seen.add(tx.id);
        changed = true;
        if (erstlauf) continue; // Altbestand still uebernehmen
        this.melden(tx, befund);
        this.deps.onCompleted(
          { transactionId: tx.id, name: tx.name ?? null },
          befund.firmen.map((f) => ({ companyId: f.companyId, state: f.state, fehlgeschlageneStufen: f.fehlgeschlageneStufen })),
        );
      }
      if (changed || erstlauf) this.persist();
    } finally {
      this.running = false;
    }
  }

  private melden(tx: TxRow, b: VorgangsBefund): void {
    const name = tx.name ? `„${tx.name}“` : tx.id.slice(0, 8);
    const { headline, zeilen, warnung } = beschreibeBefund(b);
    const rationale = [...zeilen, "Details unter Vorgaenge → Alle Vorgaenge."].join("\n");
    const alert = this.deps.addAlert({
      kind: "import-finished",
      severity: warnung ? "warn" : "info",
      headline: headline(name).slice(0, 120),
      rationale,
      sourceRef: `transaction:${tx.id}:finished`,
    });
    if (alert) this.deps.notify(alert);
    this.deps.audit({
      summary: `Vorgang ${name} abgeschlossen: ${b.profilFertig}/${b.gesamt} Profile fertig, ${b.profilFehlgeschlagen} fehlgeschlagen`,
      severity: warnung ? "warning" : "info",
      metadata: { transactionId: tx.id, ...b, firmen: undefined },
    });
  }
}
