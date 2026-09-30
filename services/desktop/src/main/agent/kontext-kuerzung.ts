// Kontext-Kuerzung (docs/PLAN_CHAT_DATEIEN_KONTEXT.md, K1 + K3, 2026-09-30).
//
// Befund aus dem Betzemeier-Test: jeder Zug schickte den kompletten Verlauf
// inklusive aller Werkzeugergebnisse ans Modell, ohne Obergrenze. 100.000
// Tokens fuer Drei-Satz-Antworten. Zwei Massnahmen, beide anbieterneutral:
//
//   K1 `ergebnisBegrenzen`: ein einzelnes Werkzeugergebnis wird ab
//      MAX_ERGEBNIS_ZEICHEN gekuerzt, mit Hinweis, gezielter zu fragen.
//   K3 `verlaufFuerModell`: Werkzeugergebnisse, die aelter als N Nutzerzuege
//      sind, gehen nur als Platzhalter ans Modell. Die gespeicherte
//      Unterhaltung bleibt vollstaendig (Protokoll, Replay).
//
// Anthropics `clear_tool_uses` macht dasselbe serverseitig, ist Beta,
// bricht den Prompt-Cache und hilft bei OpenAI/Gemini/Ollama nicht.

import type { AgentMessage } from "../../shared/types";

export const MAX_ERGEBNIS_ZEICHEN = 40_000;
/** Nach so vielen Nutzerzuegen wird ein Werkzeugergebnis zum Platzhalter. */
export const ALTERUNG_ZUEGE = 2;
/** Datei-Inhalte (datei_lesen) und Uploads bleiben laenger. */
export const ALTERUNG_ZUEGE_DATEI = 4;
const DATEI_WERKZEUGE = new Set(["datei_lesen", "datei_info", "datei_suchen"]);

export function ergebnisBegrenzen(content: string, max = MAX_ERGEBNIS_ZEICHEN): { content: string; gekuerzt: boolean } {
  if (content.length <= max) return { content, gekuerzt: false };
  const hinweis = JSON.stringify({
    gekuerzt: true,
    originalZeichen: content.length,
    hinweis: "Ergebnis gekürzt. Frag gezielter (Filter, Seite, weniger Einträge, ansicht: 'kompakt') statt es erneut ungekürzt zu laden.",
  });
  // Auf JSON-Text-Ebene schneiden; das Modell kann mit dem abgeschnittenen
  // Anfang arbeiten, der Hinweis am Ende bleibt gueltiges JSON.
  return { content: `${content.slice(0, max)}\n…\n${hinweis}`, gekuerzt: true };
}

/**
 * Verlauf, wie er ans Modell geht: alte Werkzeugergebnisse als Platzhalter.
 * "Alter" zaehlt in Nutzerzuegen ab dem Ende des Verlaufs.
 */
export function verlaufFuerModell(messages: AgentMessage[], opts?: { zuege?: number; dateiZuege?: number }): AgentMessage[] {
  const zuege = opts?.zuege ?? ALTERUNG_ZUEGE;
  const dateiZuege = opts?.dateiZuege ?? ALTERUNG_ZUEGE_DATEI;
  // Werkzeugname je toolCallId aus den Assistant-Nachrichten.
  const nameJeCall = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) for (const c of m.toolCalls) nameJeCall.set(c.id, c.name);
  }
  // Nutzerzuege vom Ende her zaehlen: Index i hat "alter" = Zahl der
  // echten Nutzer-Nachrichten NACH i.
  const alterAb = new Array<number>(messages.length);
  let gesehen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    alterAb[i] = gesehen;
    const m = messages[i]!;
    if (m.role === "user" && !m.id.startsWith("__")) gesehen++;
  }
  let ersetzt = 0;
  const out = messages.map((m, i) => {
    if (m.role !== "tool" || m.content.length < 400) return m;
    const name = nameJeCall.get(m.toolCallId ?? "") ?? "";
    const grenze = DATEI_WERKZEUGE.has(name) ? dateiZuege : zuege;
    if ((alterAb[i] ?? 0) < grenze) return m;
    ersetzt++;
    return {
      ...m,
      content: JSON.stringify({
        ersetzt: `Ergebnis von ${name || "Werkzeug"} (${m.content.length} Zeichen) ist nicht mehr im Kontext. Bei Bedarf erneut aufrufen.`,
      }),
    };
  });
  return ersetzt > 0 ? out : messages;
}
