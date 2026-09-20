// Buying Center, BC5 — was der Heartbeat ueber Fokuskunden wissen muss
// (docs/PLAN_BUYING_CENTER.md, Abschnitte 4 und 9).
//
// Zwei Fragen, beide ans Gateway, beide bewusst sparsam:
//   1. Welche Firmen sind gerade Fokuskunden? Fuer den Alarmweg: Dort geht
//      nichts in die Tageszusammenfassung, und nichts kommt leiser als
//      "warn" — ein Positionswechsel im Buying Center ist keine Randnotiz.
//   2. Welche Buying Center sind seit einem Monat unveraendert? Dann fragt
//      AVA einmal nach, ob es noch stimmt, und vermerkt das im Gateway,
//      damit die Frage nicht taeglich wiederkommt.

import type { GatewayClient } from "../agent/gateway-client";

interface BcKopf { id: string; companyId: string; status: string; updatedAt: string }

const FOKUS_CACHE_MS = 5 * 60_000;
let fokusCache: { firmen: Set<string>; bis: number } | null = null;

/** Firmen mit einem eigenen aktiven Buying Center. Ohne Netz: leer, nie ein Fehler. */
export async function fokusFirmen(gateway: GatewayClient): Promise<Set<string>> {
  const jetzt = Date.now();
  if (fokusCache && fokusCache.bis > jetzt) return fokusCache.firmen;
  try {
    const r = await gateway.request<{ items: BcKopf[] }>("/v1/buying-center", { query: { status: "aktiv" } });
    const firmen = new Set(r.items.map((b) => b.companyId));
    fokusCache = { firmen, bis: jetzt + FOKUS_CACHE_MS };
    return firmen;
  } catch {
    return fokusCache?.firmen ?? new Set();
  }
}

/** Nach einer Aenderung (anlegen, abschliessen) sofort neu lesen. */
export function fokusVergessen(): void {
  fokusCache = null;
}

export interface FaelligeNachfrage {
  buyingCenterId: string;
  companyId: string;
  companyName: string;
  /** Tage seit der letzten Aenderung. */
  tage: number;
}

/**
 * Buying Center, bei denen die monatliche Nachfrage ansteht. Wer hier
 * zurueckkommt, gilt als gefragt — der Aufrufer muss die Meldung also
 * wirklich anlegen. Firmennamen werden einzeln nachgeladen; das sind
 * wenige Aufrufe im Monat, kein Grund fuer eine eigene Route.
 */
export async function faelligeNachfragen(gateway: GatewayClient, jetzt: Date): Promise<FaelligeNachfrage[]> {
  const r = await gateway.request<{ items: BcKopf[] }>("/v1/buying-center", { query: { faellig: "true" } });
  const aus: FaelligeNachfrage[] = [];
  for (const b of r.items.slice(0, 10)) {
    let companyName = "";
    try {
      const firma = await gateway.request<{ name?: string; legalName?: string }>(`/v1/companies/${encodeURIComponent(b.companyId)}`);
      companyName = firma.name ?? firma.legalName ?? "";
    } catch {
      /* Ohne Namen bleibt die Kennung — die Meldung ist trotzdem richtig. */
    }
    await gateway.request(`/v1/buying-center/${encodeURIComponent(b.id)}/nachgefragt`, { method: "POST", body: {} });
    aus.push({
      buyingCenterId: b.id,
      companyId: b.companyId,
      companyName,
      tage: Math.max(1, Math.round((jetzt.getTime() - new Date(b.updatedAt).getTime()) / 86_400_000)),
    });
  }
  return aus;
}
