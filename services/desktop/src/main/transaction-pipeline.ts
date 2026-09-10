// v0.1.602 — Abschluss eines Vorgangs anhand der Pipeline-Matrix je Stufe
// (Operator 2026-09-09): Der Entity-Status des Gateways ist ein Roll-up
// (failed > skipped > completed) und meldet eine Firma schon als
// "fehlgeschlagen", wenn nur Handelsregister/Jahresabschluss scheiterten,
// obwohl Website/Profil/Kontakt noch laufen. Massgeblich ist das Firmenprofil:
// Ist es je Firma im Endzustand, ist die Verarbeitung im Wesentlichen durch.
// Teilfehler anderer Stufen werden als Ursache genannt, nicht als Totalausfall.

import { KEY_STAGE, STAGE_LABELS, type PipelineStage } from "../shared/workflow-dependencies";

export type StageState = "completed" | "failed" | "skipped" | "pending" | "in_progress";
export type Stage = PipelineStage;
export { KEY_STAGE, STAGE_LABELS };

export interface PipelineCell {
  state: StageState;
  errorMessage?: string | null;
  updatedAt?: string | null;
}
export interface PipelineRow {
  companyId: string;
  cells: Partial<Record<Stage, PipelineCell>>;
}
export interface PipelineSnapshot {
  transactionId: string;
  totalCompanies: number;
  stages: Stage[];
  unavailableStages?: Stage[];
  rows: PipelineRow[];
}

const TERMINAL = new Set<StageState>(["completed", "failed", "skipped"]);

export interface FirmenBefund {
  companyId: string;
  /** Zustand des Firmenprofils (massgeblich). */
  state: StageState;
  /** Alle Stufen fertig (inkl. Kontakte/Bewertung)? */
  vollstaendig: boolean;
  fehlgeschlageneStufen: Stage[];
  fehler: Partial<Record<Stage, string>>;
  /** Alle geforderten Stufen im Endzustand? */
  stufenFertig: boolean;
  /** Geforderte Stufen, die noch laufen. */
  offeneStufen: Stage[];
}

export interface VorgangsBefund {
  /** Alle Firmen: Profil im Endzustand (bzw. alle verfuegbaren Stufen, wenn das Profil nicht verfuegbar ist). */
  abgeschlossen: boolean;
  gesamt: number;
  profilFertig: number;
  profilFehlgeschlagen: number;
  profilOffen: number;
  vollstaendig: number;
  /** Teilfehler je Stufe (Anzahl Firmen). */
  teilfehler: Partial<Record<Stage, number>>;
  /** Beispiel-Fehlermeldung je Stufe. */
  beispiele: Partial<Record<Stage, string>>;
  firmen: FirmenBefund[];
}

/** @param stufen Geforderte Stufen (Default: Firmenprofil). Abschluss = alle im Endzustand. */
export function bewertePipeline(p: PipelineSnapshot, stufen: Stage[] = [KEY_STAGE]): VorgangsBefund {
  const unavailable = new Set(p.unavailableStages ?? []);
  const keyVerfuegbar = !unavailable.has(KEY_STAGE);
  const gefordert = stufen.filter((s) => !unavailable.has(s));
  const firmen: FirmenBefund[] = p.rows.map((r) => {
    const cells = r.cells;
    const key = cells[KEY_STAGE];
    const fehlgeschlagen: Stage[] = [];
    const fehler: Partial<Record<Stage, string>> = {};
    let alleFertig = true;
    for (const [stage, cell] of Object.entries(cells) as Array<[Stage, PipelineCell | undefined]>) {
      if (!cell || unavailable.has(stage)) continue;
      if (!TERMINAL.has(cell.state)) alleFertig = false;
      if (cell.state === "failed") {
        fehlgeschlagen.push(stage);
        if (cell.errorMessage) fehler[stage] = cell.errorMessage;
      }
    }
    // Operator 2026-09-09: "uebersprungen" (bereits verarbeitet / keine Daten
    // vorhanden) gilt als erfolgreich — Workflows machen direkt weiter.
    const roh: StageState = keyVerfuegbar ? (key?.state ?? "pending") : alleFertig ? (fehlgeschlagen.length > 0 ? "failed" : "completed") : "pending";
    const state: StageState = roh === "skipped" ? "completed" : roh;
    const offeneStufen = gefordert.filter((s) => !TERMINAL.has(cells[s]?.state ?? "pending"));
    return { companyId: r.companyId, state, vollstaendig: alleFertig, fehlgeschlageneStufen: fehlgeschlagen, fehler, stufenFertig: offeneStufen.length === 0, offeneStufen };
  });
  const teilfehler: Partial<Record<Stage, number>> = {};
  const beispiele: Partial<Record<Stage, string>> = {};
  for (const f of firmen) {
    for (const s of f.fehlgeschlageneStufen) {
      teilfehler[s] = (teilfehler[s] ?? 0) + 1;
      if (!beispiele[s] && f.fehler[s]) beispiele[s] = f.fehler[s]!;
    }
  }
  const profilFertig = firmen.filter((f) => f.state === "completed").length;
  const profilFehlgeschlagen = firmen.filter((f) => f.state === "failed").length;
  const profilOffen = firmen.filter((f) => !TERMINAL.has(f.state) || !f.stufenFertig).length;
  const gesamt = Math.max(firmen.length, p.totalCompanies ?? 0);
  return {
    abgeschlossen: firmen.length > 0 && firmen.length >= (p.totalCompanies || firmen.length) && profilOffen === 0,
    gesamt,
    profilFertig,
    profilFehlgeschlagen,
    profilOffen,
    vollstaendig: firmen.filter((f) => f.vollstaendig).length,
    teilfehler,
    beispiele,
    firmen,
  };
}

/** Technische Fehlertexte (Selenium/Chrome) fuer Nutzer lesbar machen. */
export function lesbarerFehler(roh: string): string {
  let t = roh.replace(/\s*\(Session info:[^)]*\)/g, "").replace(/\n\s*Stacktrace:[\s\S]*$/i, "").replace(/\s+/g, " ").trim();
  if (/stale element|detached|not attached to the page/i.test(t)) t = "Seite hat sich während des Zugriffs geändert (Element veraltet) — wird wiederholt.";
  else if (/no such element|unable to locate element/i.test(t)) t = "Erwartetes Seitenelement nicht gefunden (Seitenaufbau geändert?).";
  else if (/net::ERR_|ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(t)) t = "Netzwerkfehler beim Abruf der Quelle.";
  return t.slice(0, 180);
}

/** Kurztext fuer Meldungen/Telegram: Ergebnis + konkrete Ursachen. */
export function beschreibeBefund(b: VorgangsBefund): { headline: (name: string) => string; zeilen: string[]; warnung: boolean } {
  const teil = (Object.entries(b.teilfehler) as Array<[Stage, number]>).sort((x, y) => y[1] - x[1]);
  const zeilen: string[] = [];
  zeilen.push(`Firmen: ${b.gesamt} · Profil fertig ${b.profilFertig}${b.profilFehlgeschlagen ? ` · Profil fehlgeschlagen ${b.profilFehlgeschlagen}` : ""}${b.profilOffen ? ` · offen ${b.profilOffen}` : ""}${b.vollstaendig < b.gesamt ? ` · alle Stufen fertig ${b.vollstaendig}` : ""}.`);
  if (teil.length > 0) {
    zeilen.push("Teilfehler: " + teil.map(([s, n]) => `${STAGE_LABELS[s] ?? s} ${n}/${b.gesamt}`).join(" · "));
    for (const [s] of teil.slice(0, 2)) {
      const bsp = b.beispiele[s];
      if (bsp) zeilen.push(`${STAGE_LABELS[s] ?? s}: ${lesbarerFehler(bsp)}`);
    }
    const quellen = teil.filter(([s, n]) => (s === "structuredContent" || s === "companyPublication") && n >= Math.max(2, Math.ceil(b.gesamt * 0.6)));
    if (quellen.length > 0) {
      zeilen.push("Vermutlich ist die Quelle (Handelsregister/Unternehmensanzeiger) gerade nicht erreichbar. Die Schritte lassen sich spaeter unter Vorgaenge → „Schritt erneut starten“ wiederholen.");
    }
  }
  const warnung = b.profilFehlgeschlagen > 0 || teil.length > 0;
  const headline = (name: string): string => {
    if (b.profilFehlgeschlagen === 0 && teil.length === 0) return `Vorgang ${name} abgeschlossen: ${b.profilFertig} von ${b.gesamt} Firmen fertig`;
    if (b.profilFehlgeschlagen === 0) return `Vorgang ${name} abgeschlossen: ${b.profilFertig} von ${b.gesamt} Firmenprofile fertig, Teilfehler bei ${teil.map(([s]) => STAGE_LABELS[s] ?? s).join(", ")}`;
    return `Vorgang ${name} abgeschlossen: ${b.profilFertig} Firmenprofile fertig, ${b.profilFehlgeschlagen} fehlgeschlagen`;
  };
  return { headline, zeilen, warnung };
}

export async function fetchPipeline(gatewayRequest: <T>(path: string) => Promise<T>, transactionId: string): Promise<PipelineSnapshot> {
  return gatewayRequest<PipelineSnapshot>(`/v1/transactions/${encodeURIComponent(transactionId)}/pipeline`);
}
