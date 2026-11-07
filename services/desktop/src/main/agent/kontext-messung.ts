// L0 (docs/PLAN_LOESUNGSKARTEN.md): Woraus besteht der Kontext eines Modellaufrufs?
// Je Schritt eine Zeile "[kontext] {…}" ins Protokoll: Systemprompt (mit den
// groessten Abschnitten), Werkzeugliste im Prompt, Werkzeug-Schemas, Verlauf je
// Rolle, und — sobald der Anbieter sie meldet — die echten Eingabe-Tokens. Die
// Schaetzung (Zeichen / 3,6 fuer deutschen Text) wird damit je Lauf geeicht.

import type { AgentMessage } from "../../shared/types";
import type { OllamaToolSpec } from "./types";

const ZEICHEN_JE_TOKEN = 3.6;

export function tok(zeichen: number): number {
  return Math.round(zeichen / ZEICHEN_JE_TOKEN);
}

export interface KontextMessung {
  schritt: number;
  system: number;
  werkzeugliste: number;
  abschnitte: Array<[string, number]>;
  schemas: number;
  schemaAnzahl: number;
  verlauf: { user: number; assistant: number; tool: number; nachrichten: number };
  geschaetzt: number;
  echt?: { input: number; cache: number };
}

/** Abschnitte des Systemprompts: Absatz, dessen erste Zeile wie eine Ueberschrift aussieht. */
export function promptAbschnitte(system: string): Array<[string, number]> {
  const teile = system.split(/\n\n(?=(?:#+ |[A-ZÄÖÜ][^\n]{0,90}:\s*\n|[A-ZÄÖÜ][^\n]{0,90}\n))/);
  const summe = new Map<string, number>();
  for (const t of teile) {
    const kopf = t.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 48).trim() || "(ohne Titel)";
    summe.set(kopf, (summe.get(kopf) ?? 0) + tok(t.length));
  }
  return [...summe.entries()].sort((a, b) => b[1] - a[1]);
}

export function kontextMessen(opts: { schritt: number; system: string; tools?: OllamaToolSpec[]; verlauf: AgentMessage[] }): KontextMessung {
  const listeStart = opts.system.indexOf("\nVerfügbare Tools");
  const werkzeugliste = listeStart >= 0 ? tok(opts.system.length - listeStart) : 0;
  const v = { user: 0, assistant: 0, tool: 0, nachrichten: opts.verlauf.length };
  for (const m of opts.verlauf) {
    const z = (m.content?.length ?? 0) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0);
    if (m.role === "user" || m.role === "assistant" || m.role === "tool") v[m.role] += tok(z);
  }
  const schemas = opts.tools ? tok(JSON.stringify(opts.tools).length) : 0;
  const system = tok(opts.system.length);
  const alle = promptAbschnitte(opts.system);
  const top = alle.slice(0, 10);
  const rest = alle.slice(10).reduce((s, [, n]) => s + n, 0);
  return {
    schritt: opts.schritt,
    system,
    werkzeugliste,
    abschnitte: rest > 0 ? [...top, ["(übrige Abschnitte)", rest]] : top,
    schemas,
    schemaAnzahl: opts.tools?.length ?? 0,
    verlauf: v,
    geschaetzt: system + schemas + v.user + v.assistant + v.tool,
  };
}

export function kontextProtokollieren(m: KontextMessung): void {
  try {
    console.info(`[kontext] ${JSON.stringify(m)}`);
  } catch {
    /* Messung darf nie stoeren */
  }
}
