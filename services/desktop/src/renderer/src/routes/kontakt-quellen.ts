// Woher ein Kontakt stammt — die Angabe an der Personenkarte.
//
// Anlass (2026-09-18): Ein Kollege versuchte wiederholt, eine Firma neu
// verarbeiten zu lassen, weil die gefundenen Ansprechpartner nicht passten.
// Ob ein Kontakt aus dem LinkedIn-Abruf oder nur aus der Websuche stammt,
// war in der App nirgends zu sehen — dabei ist das fast immer die erste
// Frage, wenn ein Kontakt nicht stimmt.
//
// Die Quellwerte des Producers sind fuer die Oberflaeche zu kleinteilig
// (agent:website, agent:website_people, search, search:linkedin_lookup,
// valueserp:google, apify:company-profile, agent:datenschutz). Sie werden
// deshalb zu wenigen verstaendlichen Gruppen zusammengefasst.

/**
 * Quellwert des Producers → Gruppe fuer die Anzeige.
 *
 * Unbekannte Werte geben bewusst null: lieber keine Angabe als eine
 * falsche. Neue Quellwerte im Producer muessen hier ergaenzt werden.
 */
export function quellenGruppe(source: string | null | undefined): string | null {
  if (!source) return null;
  if (source.startsWith("apify:")) return "LinkedIn";
  if (source.startsWith("search") || source.startsWith("valueserp:")) return "Websuche";
  // Vor agent: pruefen — die Datenschutzerklaerung ist zwar Teil der
  // Website, als Fundstelle fuer eine Person aber etwas ganz anderes.
  if (source === "agent:datenschutz") return "Datenschutzerklärung";
  if (source.startsWith("agent:")) return "Firmenwebsite";
  // "pattern:" bleibt aussen vor: das sind abgeleitete Adressen, die schon
  // ein eigenes Abzeichen an der Karte haben.
  return null;
}

/** Feste Reihenfolge, damit die Angabe zwischen zwei Karten vergleichbar
 *  bleibt und nicht mit der Sortierung der Fakten springt. */
const REIHENFOLGE = ["LinkedIn", "Firmenwebsite", "Websuche", "Datenschutzerklärung"];

/**
 * Alle Gruppen hinter den Fakten einer Person, ohne Wiederholung.
 *
 * `lastObsId` an einem Fakt zeigt auf die Beobachtung, die ihn zuletzt
 * bestaetigt hat; deren `source` ist die gesuchte Herkunft. Eine Person
 * hat mehrere Fakten und damit oft mehrere Quellen (rund ein Siebtel der
 * Kontakte im Bestand).
 */
export function quellenDerFakten(
  facts: ReadonlyArray<{ lastObsId?: unknown; [k: string]: unknown }>,
  quellen: Map<string, string> | undefined,
): string[] {
  if (!quellen || quellen.size === 0) return [];
  const gefunden = new Set<string>();
  for (const f of facts) {
    const obsId = typeof f.lastObsId === "string" ? f.lastObsId : null;
    const gruppe = quellenGruppe(obsId ? quellen.get(obsId) : null);
    if (gruppe) gefunden.add(gruppe);
  }
  return REIHENFOLGE.filter((g) => gefunden.has(g));
}

/**
 * Wie quellenDerFakten, aber je Gruppe mit der Belegseite (2026-09-24):
 * "Firmenwebsite" soll anklickbar sein und auf die Seite fuehren, auf der
 * die Person gefunden wurde. Je Gruppe die Seite des zuerst genannten
 * Fakts mit Beleg; ohne Beleg bleibt die Gruppe ein blosser Text.
 */
export function quellenMitBelegen(
  facts: ReadonlyArray<{ lastObsId?: unknown; [k: string]: unknown }>,
  quellen: Map<string, string> | undefined,
  belege: Map<string, string> | undefined,
): Array<{ gruppe: string; url: string | null }> {
  if (!quellen || quellen.size === 0) return [];
  const urlJe = new Map<string, string | null>();
  for (const f of facts) {
    const obsId = typeof f.lastObsId === "string" ? f.lastObsId : null;
    const gruppe = quellenGruppe(obsId ? quellen.get(obsId) : null);
    if (!gruppe) continue;
    const url = (obsId && belege?.get(obsId)) || null;
    if (!urlJe.has(gruppe) || (url && !urlJe.get(gruppe))) urlJe.set(gruppe, url);
  }
  return REIHENFOLGE.filter((g) => urlJe.has(g)).map((g) => ({ gruppe: g, url: urlJe.get(g) ?? null }));
}
