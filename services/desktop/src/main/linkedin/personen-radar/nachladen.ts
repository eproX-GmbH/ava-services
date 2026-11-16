// PM-2026-0052 — „Alle Kommentare nachladen“: Kostenhinweis vor dem Start und Start im
// Hintergrund (ein Nachlade-Lauf dauert bei grossen Posts mehrere Minuten). Oberflaeche und
// Chat-Werkzeug nutzen denselben Text.

import type { GatewayClient } from "../../agent/gateway-client";
import { NACHLADEN_BUDGET, NACHLADEN_MAX_KOMMENTARE, type PersonenRadarSupervisor } from "./supervisor";
import type { PersonenRadarStore } from "./store";

interface Preis {
  schluessel: string;
  centsJe1000: number;
  centsJeLauf: number;
}

let preisCache: { at: number; preise: Preis[] } | null = null;

async function preise(gateway: GatewayClient): Promise<Preis[]> {
  if (preisCache && Date.now() - preisCache.at < 6 * 3600_000) return preisCache.preise;
  try {
    const r = await gateway.request<{ preise: Preis[] }>("/v1/plaene/linkedin-preise");
    preisCache = { at: Date.now(), preise: r.preise ?? [] };
    return preisCache.preise;
  } catch {
    return preisCache?.preise ?? [];
  }
}

function eur(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/** Kostenhinweis in Nutzersprache; ohne Preistabelle ein Satz ohne Zahlen. */
export async function nachladenKostenHinweis(gateway: GatewayClient, store: PersonenRadarStore, postUrl: string): Promise<string> {
  const stand = store.getConfig().postStand[postUrl];
  if (stand?.vollGeladenAt) {
    return `Die Kommentare dieses Posts wurden am ${new Date(stand.vollGeladenAt).toLocaleDateString("de-DE")} schon vollständig geholt. Jetzt kommen nur neue Kommentare dazu, und bis zu ${NACHLADEN_BUDGET} wartende Personen werden ihrer Firma zugeordnet. Das kostet nur wenig.`;
  }
  const p = await preise(gateway);
  const kommentar = p.find((x) => x.schluessel === "POST_COMMENTS");
  const profil = p.find((x) => x.schluessel === "PROFILE_SCRAPER");
  const grund = `AVA holt alle Kommentare dieses Posts samt Antworten (höchstens ${NACHLADEN_MAX_KOMMENTARE.toLocaleString("de-DE")}) und ordnet bis zu ${NACHLADEN_BUDGET} neue Personen ihrer Firma zu. Der Rest wartet und wird bei den nächsten Läufen zugeordnet.`;
  if (!kommentar || !profil) return `${grund} Das wird nach Verbrauch auf dein LinkedIn-Limit angerechnet.`;
  const bei500 = Math.round((kommentar.centsJe1000 * 500) / 1000 + (profil.centsJe1000 * NACHLADEN_BUDGET) / 1000 + kommentar.centsJeLauf);
  return `${grund} Kosten: etwa ${eur(kommentar.centsJe1000 / 10)} je 100 Kommentare und ${eur(profil.centsJe1000 / 10)} je 100 zugeordnete Personen, bei rund 500 Kommentaren also etwa ${eur(bei500)}. Das wird auf dein LinkedIn-Limit angerechnet.`;
}

/** Startet das Nachladen im Hintergrund; das Ergebnis kommt als Meldung und im Laufstand. */
export function nachladenStarten(sup: PersonenRadarSupervisor, postUrl: string): string {
  if (sup.isRunning()) return "Gerade läuft schon eine Prüfung der beobachteten Posts. Bitte nach deren Ende erneut starten.";
  void sup.runNow("manuell", { nachladen: postUrl }).catch(() => undefined);
  return "Nachladen gestartet. Bei großen Posts dauert das einige Minuten; neue Leads erscheinen unter LinkedIn → Leads, und du bekommst eine Meldung.";
}
