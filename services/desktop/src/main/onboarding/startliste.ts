// Onboarding O3 (docs/PLAN_ONBOARDING.md): nach dem ersten Radar-Lauf die besten
// Treffer in "Meine Firmen" uebernehmen (Joyce 2026-11-08: automatisch ueber einen
// sichtbaren, loeschbaren Start-Workflow) und die Mail "Deine Top 10" anstossen.
//
// Der Workflow wird bei einem neuen Konto genau einmal angelegt; nach dem Loeschen
// kommt er nie wieder (Marke startWorkflowAngelegt). Das Ereignis radar.erstlauf
// faellt ebenfalls genau einmal (Marke erstlaufGemeldet).

import type { GatewayClient } from "../agent/gateway-client";
import type { MatchStore } from "../discovery/match-store";
import { listCandidatesWithMatches } from "../discovery/list";
import { decideCandidates } from "../discovery/decide";
import { markeLesen, markeSetzen, onboardingDatei } from "./marke";
import { bewertePipeline, fetchPipeline } from "../transaction-pipeline";
import { DEFAULT_WORKFLOW_SETTINGS } from "../../shared/workflow-types";
import type { WorkflowService } from "../workflows";

export const START_WORKFLOW_NAME = "Start: Top-10-Firmen übernehmen";
export const MINDEST_SCORE = 60;

export interface StartlisteErgebnis {
  importiert: number;
  firmen: Array<{ name: string; ort: string | null; branche: string | null; score: number; grund: string }>;
  transactionId: string | null;
  hinweis?: string;
}

/** Die besten noch nicht uebernommenen Treffer mit Ort importieren; die Mail wartet auf die Verarbeitung. */
export async function startlisteUebernehmen(
  deps: { gateway: GatewayClient; matchStore: MatchStore; datei?: string },
  opts: { anzahl?: number; mindestScore?: number } = {},
): Promise<StartlisteErgebnis | { error: string }> {
  const anzahl = Math.min(10, Math.max(1, opts.anzahl ?? 10));
  const mindest = opts.mindestScore ?? MINDEST_SCORE;
  const rows = await listCandidatesWithMatches(deps.gateway, deps.matchStore, { limit: 200 });
  const auswahl = rows
    .filter((r) => !r.bereitsInAva && r.matchScore !== null && r.matchScore >= mindest && !!r.ort)
    .slice(0, anzahl);
  if (auswahl.length === 0) return { importiert: 0, firmen: [], transactionId: null, hinweis: `Noch kein Treffer ab Score ${mindest} mit Ort.` };
  // Bewusst auch Treffer, die im Free-Plan in der Radar-Tabelle verdeckt sind (Joyce
  // 2026-11-08: die 10 Besten als Geschenk); als Startpaket zaehlen sie nicht aufs Kontingent.
  const d = await decideCandidates(deps.gateway, auswahl.map((r) => ({ discoveryId: r.discoveryId, decision: "imported" as const, reason: "Start-Workflow: Top-Treffer nach dem ersten Radar-Lauf" })), { startpaket: true });
  if ("error" in d) return { error: d.error };
  const firmen = auswahl.map((r) => ({ name: r.name, ort: r.ort, branche: r.kategorie ?? null, score: r.matchScore ?? 0, grund: (r.matchBegruendung ?? "").slice(0, 300) }));
  const datei = deps.datei ?? onboardingDatei();
  if (d.transactionId && !markeLesen(datei).top10Mail) markeSetzen(datei, { top10Mail: { transactionId: d.transactionId, firmen, seit: new Date().toISOString() } });
  return {
    importiert: d.importiert, firmen, transactionId: d.transactionId,
    hinweis: "Die Firmen werden jetzt verarbeitet. Sobald sie fertig sind, geht die Liste per Mail raus (wenn der Nutzer Mails bestätigt hat).",
  };
}

/**
 * Mail "Deine Top 10" genau einmal, sobald der Import fertig verarbeitet ist
 * (Profil-Stufe aller Firmen fertig) oder nach 24 Stunden mit dem Stand von dann.
 * So zeigen die Firmenlinks in der Mail auf gefuellte Seiten.
 */
export async function top10MailPruefen(deps: { gateway: GatewayClient; datei?: string }): Promise<void> {
  const datei = deps.datei ?? onboardingDatei();
  const offen = markeLesen(datei).top10Mail;
  if (!offen || offen.erledigt) return;
  const alt = Date.now() - Date.parse(offen.seit) > 24 * 3600_000;
  if (!alt) {
    const befund = bewertePipeline(await fetchPipeline((p) => deps.gateway.request(p), offen.transactionId));
    if (!befund.abgeschlossen) return;
  }
  const r = await deps.gateway.request<{ gesendet?: boolean; grund?: string }>("/v1/onboarding/mail/top10", { method: "POST", body: { transactionId: offen.transactionId, firmen: offen.firmen } });
  markeSetzen(datei, { top10Mail: { ...offen, erledigt: new Date().toISOString(), ergebnis: r.gesendet ? "gesendet" : (r.grund ?? "nicht gesendet") } });
}

/** Neues Konto: Start-Workflow vormerken und anlegen, sobald der Workflow-Dienst bereit ist. */
export function startWorkflowVormerken(datei: string): void {
  if (!markeLesen(datei).startWorkflowFaellig) markeSetzen(datei, { startWorkflowFaellig: new Date().toISOString() });
}

/** Start-Workflow genau einmal je Installation anlegen (nie nach dem Loeschen erneut). */
export function startWorkflowAnlegen(
  datei: string,
  service: Pick<WorkflowService, "save"> | null,
): string | null {
  const m = markeLesen(datei);
  if (!service || !m.startWorkflowFaellig || m.startWorkflowAngelegt) return null;
  const { workflow } = service.save(
    {
      name: START_WORKFLOW_NAME,
      description:
        "Einmalig nach dem ersten Radar-Lauf: Die bis zu 10 am besten passenden Firmen (Score ab 60) kommen in „Meine Firmen“. Sind sie verarbeitet, bekommst du die Liste per Mail. Danach meldet AVA Veränderungen zu diesen Firmen. Du kannst den Workflow jederzeit löschen.",
      enabled: true,
      trigger: { kind: "event", event: "radar.erstlauf" },
      nodes: [
        { id: "start", name: "Start", type: "trigger", position: [0, 0], parameters: {} },
        { id: "top10", name: "Top 10 übernehmen", type: "tool", position: [260, 0], mode: "allItems", confirmed: true, parameters: { tool: "onboarding_startliste", args: { anzahl: 10, mindestScore: MINDEST_SCORE } } },
      ],
      connections: { Start: { main: [[{ node: "Top 10 übernehmen", index: 0 }]] } },
      settings: { ...DEFAULT_WORKFLOW_SETTINGS, scope: "none", notifyOnFinish: true },
    },
    { createdBy: "agent" },
  );
  markeSetzen(datei, { startWorkflowAngelegt: new Date().toISOString() });
  return workflow.id;
}

/**
 * Nach jedem Match aufgerufen: loest radar.erstlauf genau einmal aus, sobald der
 * erste richtige Lauf Ergebnisse hat (mind. 10 Treffer ab Mindestscore oder ein
 * voller Lauf mit mind. 20 Bewertungen). Nur fuer Konten mit Start-Workflow.
 */
export function erstlaufPruefen(datei: string, ergebnisse: Array<{ score: number }>, ausloesen: (payload: Record<string, unknown>) => void): boolean {
  const m = markeLesen(datei);
  if (!m.startWorkflowFaellig || m.erstlaufGemeldet) return false;
  const passend = ergebnisse.filter((r) => r.score >= MINDEST_SCORE).length;
  if (passend === 0 || (passend < 10 && ergebnisse.length < 20)) return false;
  markeSetzen(datei, { erstlaufGemeldet: new Date().toISOString() });
  ausloesen({ bewertet: ergebnisse.length, passend });
  return true;
}
