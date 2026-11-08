// Loesungskarten L4 (docs/PLAN_LOESUNGSKARTEN.md): Knoepfe unter der Antwort.
// Antwortet AVA aus einer Karte, schreibt sie als letzte Zeile "[Karte: <id>]".
// Die Markierung verlaesst den Hauptprozess nie (Strom, Verlauf, Telegram, App):
// MarkierungsFilter haelt sie im Token-Strom zurueck, markierungEntfernen nimmt
// sie aus dem fertigen Text. Die Knoepfe kommen nur von Karten, die tool_search
// in dieser Anfrage wirklich geliefert hat.

import type { AgentKartenAktion } from "../../shared/types";
import { vorlageFuer } from "../../shared/dienst-vorlagen";
import type { Karte } from "./format";

const MARKIERUNG_RE = /[ \t]*\n*[ \t]*\[Karte:\s*([a-z0-9][a-z0-9-]{1,80})\s*\]/g;
const ANFANG = "[Karte:";
const MAX_HALTEN = 100;

function ersetzen(text: string, ids: string[]): string {
  return text.replace(MARKIERUNG_RE, (_m, id: string) => {
    if (!ids.includes(id)) ids.push(id);
    return "";
  });
}

/** Fertiger Text: Markierungen raus, auch eine abgebrochene am Ende. */
export function markierungEntfernen(text: string): { text: string; ids: string[] } {
  const ids: string[] = [];
  const rein = ersetzen(text, ids);
  const ohneRest = rein.replace(/\s*\[Karte:[^\]\n]*$/, "");
  return { text: ids.length || ohneRest !== rein ? ohneRest.trimEnd() : text, ids };
}

/** Haelt im Token-Strom alles ab einem moeglichen "[Karte:" zurueck, bis klar ist, ob es eine Markierung ist. */
export class MarkierungsFilter {
  private puffer = "";

  push(delta: string): string {
    this.puffer += delta;
    const text = ersetzen(this.puffer, []);
    const ab = this.halteAb(text);
    this.puffer = text.slice(ab);
    return text.slice(0, ab);
  }

  /** Rest am Ende der Antwort (unvollstaendige Markierung faellt weg). */
  flush(): string {
    const rest = this.puffer;
    this.puffer = "";
    return /^\s*\[Karte:/.test(rest) ? "" : rest;
  }

  private halteAb(text: string): number {
    const i = text.lastIndexOf("[");
    if (i < 0 || text.length - i > MAX_HALTEN) return text.length;
    const rest = text.slice(i);
    const passt = rest.length <= ANFANG.length ? ANFANG.startsWith(rest) : rest.startsWith(ANFANG) && /^\[Karte:\s*[a-z0-9-]*\s*$/.test(rest);
    if (!passt) return text.length;
    // fuehrende Leerzeilen vor der Markierung gleich mit zurueckhalten
    let j = i;
    while (j > 0 && /[\s]/.test(text[j - 1]!)) j--;
    return j;
  }
}

/** Karten-IDs aus einem tool_search-Ergebnis (JSON mit wissen[].karte). */
export function kartenAusErgebnis(inhalt: string): string[] {
  try {
    const j = JSON.parse(inhalt) as { wissen?: Array<{ karte?: unknown }> };
    return (j.wissen ?? []).map((w) => w.karte).filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

/** Knopf aus einem app_oeffnen-/navigate-Ergebnis ({ knopf: { label, pfad } }). */
export function knopfAusErgebnis(inhalt: string): AgentKartenAktion | null {
  try {
    const k = (JSON.parse(inhalt) as { knopf?: { label?: unknown; pfad?: unknown } }).knopf;
    if (!k || typeof k.label !== "string" || typeof k.pfad !== "string" || !k.pfad.startsWith("/")) return null;
    return { art: "app_oeffnen", label: k.label, pfad: k.pfad };
  } catch {
    return null;
  }
}

export interface AusgefuehrteAktion {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Knoepfe der markierten Karten. Nur Karten, die in dieser Anfrage geliefert
 * wurden; ein Zugang, den AVA schon selbst angefordert hat, faellt weg.
 * `angeboten` = Knoepfe aus app_oeffnen/navigate in dieser Anfrage; gleiche
 * Seite nur einmal (die Kartenbeschriftung gewinnt).
 */
export function aktionenAufloesen(opts: {
  ids: string[];
  geliefert: Set<string>;
  karten: (id: string) => Karte | undefined;
  ausgefuehrt: AusgefuehrteAktion[];
  pfadFuer: (ziel: string, dienst?: string) => string | null;
  angeboten?: AgentKartenAktion[];
}): AgentKartenAktion[] {
  const out: AgentKartenAktion[] = [];
  const zugangSchon = opts.ausgefuehrt.some((a) => a.name === "zugang_anfordern");
  for (const id of opts.ids.slice(0, 2)) {
    if (!opts.geliefert.has(id)) continue;
    const k = opts.karten(id);
    if (!k) continue;
    for (const a of k.aktionen) {
      if (a.art === "app_oeffnen") {
        if (!a.ziel) continue;
        const pfad = opts.pfadFuer(a.ziel, a.dienst);
        if (pfad) out.push({ art: "app_oeffnen", label: a.label, pfad });
      } else if (a.art === "zugang_anfordern") {
        if (zugangSchon) continue;
        const v = a.dienst ? vorlageFuer(a.dienst) : undefined;
        out.push({ art: "zugang_anfordern", label: a.label, ...(a.dienst ? { dienst: v?.name ?? a.dienst } : {}), ...(v ? { vorlage: v.id } : {}) });
      } else if (a.art === "chat_vorschlag" && a.ziel) {
        out.push({ art: "chat_vorschlag", label: a.label, auftrag: a.ziel });
      }
    }
  }
  out.push(...(opts.angeboten ?? []));
  const gesehen = new Set<string>();
  return out
    .filter((a) => {
      const s = `${a.art}|${a.pfad ?? a.auftrag ?? a.dienst ?? ""}`;
      if (gesehen.has(s)) return false;
      gesehen.add(s);
      return true;
    })
    .slice(0, 4);
}
