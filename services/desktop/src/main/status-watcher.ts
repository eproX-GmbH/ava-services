// Firmenstatus-Waechter: meldet, wenn eine Firma des Nutzers ("Meine Firmen")
// insolvent wird, geloescht wird, eine Loeschung angekuendigt ist oder in
// Liquidation geht. Quelle: /v1/companies/matrix (registerStatus,
// insolvencyStatus aus master-data). Snapshot je Firma unter
// userData/status-watcher.json; jede Aenderung meldet genau einmal
// (sourceRef = status:<companyId>:<schluessel>). Beim Erstlauf werden
// bestehende Warnungen einmalig gemeldet, damit nichts unbemerkt bleibt.

import { app } from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alert } from "../shared/types";
import { firmenStatusWarnungen, landText, type StatusWarnung } from "./firmen-status";
import { featureEnabled } from "./org-policy";

const TICK_MS = 6 * 60 * 60_000;
const FIRST_TICK_MS = 2 * 60_000;
const SEITEN_MAX = 10; // 10 × 200 Firmen

type MatrixRow = { companyId: string; name: string; registerStatus?: string; insolvencyStatus?: string; country?: string; registerType?: string; registerNumber?: string; gesellschafterStand?: string | null };

type Beteiligung = { typ: "PERSON" | "FIRMA"; personName: string | null; gesellschafterFirmaText: string | null; gesellschafterCompanyId: string | null; prozent: number | null };
type Veraenderungen = { vorherigeListeDatum: string; neu: Beteiligung[]; weg: Beteiligung[]; geaendert: Array<{ vorher: Beteiligung; nachher: Beteiligung }> };

export interface StatusWatcherDeps {
  gatewayRequest: <T>(path: string) => Promise<T>;
  isSignedIn: () => boolean;
  tenantId: () => string | null;
  addAlert: (input: { companyId: string; companyName: string; kind: Alert["kind"]; severity: Alert["severity"]; headline: string; rationale: string; sourceRef: string }) => Alert | null;
  notify: (alert: Alert) => void;
  audit: (entry: { summary: string; severity: "info" | "warning"; metadata: Record<string, unknown> }) => void;
}

type Snapshot = Record<string, string>; // companyId → "reg|ins"

export class StatusWatcher {
  private timer: NodeJS.Timeout | null = null;
  private readonly path: string;
  private running = false;

  constructor(private readonly deps: StatusWatcherDeps, dir?: string) {
    this.path = join(dir ?? app.getPath("userData"), "status-watcher.json");
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

  /** Manuell (Chat-Tool, Einstellungen). */
  async pruefeJetzt(): Promise<{ geprueft: number; gemeldet: number }> {
    return this.tick(true);
  }

  private load(): Snapshot {
    try {
      return existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as Snapshot) : {};
    } catch {
      return {};
    }
  }

  private persist(s: Snapshot): void {
    try {
      writeFileSync(this.path, JSON.stringify(s), "utf8");
    } catch {
      /* best-effort */
    }
  }

  private async tick(manuell = false): Promise<{ geprueft: number; gemeldet: number }> {
    if (this.running || !this.deps.isSignedIn()) return { geprueft: 0, gemeldet: 0 };
    this.running = true;
    try {
      const alt = this.load();
      const erstlauf = !existsSync(this.path);
      const rows: MatrixRow[] = [];
      for (let page = 1; page <= SEITEN_MAX; page++) {
        let r: { items?: MatrixRow[]; rows?: MatrixRow[]; total?: number };
        try {
          r = await this.deps.gatewayRequest(`/v1/companies/matrix?page=${page}&pageSize=200`);
        } catch {
          break;
        }
        const seite = r.items ?? r.rows ?? [];
        rows.push(...seite);
        if (seite.length < 200) break;
      }
      const neu: Snapshot = {};
      let gemeldet = 0;
      for (const row of rows) {
        if (!row.companyId) continue;
        const warnungen = firmenStatusWarnungen({ name: row.name, registerStatus: row.registerStatus, insolvencyStatus: row.insolvencyStatus, country: row.country });
        const key = warnungen.map((w) => w.schluessel).join(",") || "ok";
        neu[row.companyId] = key;
        if (alt[row.companyId] === key) continue; // unveraendert
        if (warnungen.length === 0) continue; // Entwarnung: still (Status in der App sichtbar)
        // Nur die neuen Schluessel melden (beim Erstlauf alle).
        const vorher = new Set((alt[row.companyId] ?? "").split(","));
        const frisch = erstlauf || manuell ? warnungen : warnungen.filter((w) => !vorher.has(w.schluessel));
        if (frisch.length === 0) continue;
        if (this.melde(row, frisch)) gemeldet++;
      }
      // Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §7 V7): Gesellschafterwechsel.
      // Der Schluessel "<listeDatum>|<Hash>" kommt aus master-data; aendert er sich,
      // holen wir die Veraenderungen (neu, weggefallen, andere Quote) und melden einmal.
      if (featureEnabled("verflechtungen")) {
        for (const row of rows) {
          if (!row.companyId) continue;
          const gk = `g:${row.companyId}`;
          const stand = row.gesellschafterStand ?? "";
          neu[gk] = stand;
          if (!stand || alt[gk] === stand) continue;
          if (erstlauf || !alt[gk]) continue; // erste Liste ist kein Wechsel
          if (await this.meldeGesellschafterwechsel(row)) gemeldet++;
        }
      }
      this.persist(neu);
      if (gemeldet > 0 || manuell) {
        this.deps.audit({ summary: `Firmenstatus geprüft: ${rows.length} Firmen, ${gemeldet} Meldungen`, severity: "info", metadata: { firmen: rows.length, gemeldet, erstlauf } });
      }
      return { geprueft: rows.length, gemeldet };
    } finally {
      this.running = false;
    }
  }

  private async meldeGesellschafterwechsel(row: MatrixRow): Promise<boolean> {
    let v: Veraenderungen | null = null;
    try {
      const r = await this.deps.gatewayRequest<{ veraenderungen?: Veraenderungen | null }>(`/v1/companies/${encodeURIComponent(row.companyId)}/shareholders`);
      v = r.veraenderungen ?? null;
    } catch {
      return false;
    }
    if (!v || (v.neu.length === 0 && v.weg.length === 0 && v.geaendert.length === 0)) return false;
    const nenne = (b: Beteiligung) => `${b.typ === "FIRMA" ? (b.gesellschafterFirmaText ?? b.gesellschafterCompanyId ?? "Firma") : (b.personName ?? "Person")}${b.prozent != null ? ` (${b.prozent.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %)` : ""}`;
    const zeilen = [
      ...v.neu.map((b) => `- Neu: ${nenne(b)}`),
      ...v.weg.map((b) => `- Ausgeschieden: ${nenne(b)}`),
      ...v.geaendert.map((g) => `- Geändert: ${nenne(g.nachher)}, vorher ${g.vorher.prozent != null ? `${g.vorher.prozent.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %` : "ohne Quote"}`),
    ];
    const alert = this.deps.addAlert({
      companyId: row.companyId,
      companyName: row.name,
      kind: "profile-change",
      severity: v.weg.length > 0 ? "warn" : "info",
      headline: `Gesellschafterwechsel: ${row.name}`.slice(0, 120),
      rationale: [
        `**${row.name}** (${row.companyId})`,
        "",
        `Neue Gesellschafterliste im Handelsregister (vorher Liste vom ${new Date(v.vorherigeListeDatum).toLocaleDateString("de-DE")}).`,
        "",
        ...zeilen,
        "",
        "Quelle: Gesellschafterliste aus dem Registerordner, gelesen mit deinem KI-Modell. Details im Reiter Verflechtungen der Firma.",
      ].join("\n"),
      sourceRef: `gesellschafter:${row.companyId}:${row.gesellschafterStand ?? ""}`,
    });
    if (!alert) return false;
    this.deps.notify(alert);
    return true;
  }

  private melde(row: MatrixRow, warnungen: StatusWarnung[]): boolean {
    const schwerste = warnungen[0];
    if (!schwerste) return false;
    const severity: Alert["severity"] = schwerste.stufe === "urgent" ? "urgent" : "warn";
    const headline = `${schwerste.kurz.charAt(0).toUpperCase()}${schwerste.kurz.slice(1)}: ${row.name}`.slice(0, 120);
    const land = landText(row);
    const quelle =
      row.country === "AT"
        ? "Quelle: Firmenbuch (JustizOnline) und Ediktsdatei über das Register-Delta."
        : "Quelle: Handelsregister und Insolvenzbekanntmachungen über das Register-Delta.";
    const rationale = [
      `**${row.name}** (${row.companyId})`,
      ...(land ? [land] : []),
      "",
      ...warnungen.map((w) => `- ${w.text}`),
      "",
      `${quelle} Prüfe vor Ansprache, Angebot oder größerem Projekt die Details in den Firmendetails.`,
    ].join("\n");
    const alert = this.deps.addAlert({
      companyId: row.companyId,
      companyName: row.name,
      kind: "status",
      severity,
      headline,
      rationale,
      sourceRef: `status:${row.companyId}:${warnungen.map((w) => w.schluessel).join(",")}`,
    });
    if (!alert) return false;
    this.deps.notify(alert);
    return true;
  }
}
