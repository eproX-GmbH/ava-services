// Buying Center, BC7 — Sichtfreigabe (docs/PLAN_BUYING_CENTER.md, 8.3).
//
// Der Nutzer sagt "gib das Henning frei" — und meint ein Mitglied seiner
// Organisation. Hier wird aus dem Wort ein Mitglied: erst E-Mail oder
// Kennung exakt, dann der volle Name (Titel, Umlaute, Reihenfolge egal),
// dann ein Teil davon. Mehrere Treffer gehen zurueck an den Aufrufer, der
// dann nachfragt — eine Freigabe an den Falschen gibt Einschaetzungen ueber
// Menschen an den Falschen.

import { gleicherName } from "./interaktionen";

export interface OrgMitglied {
  actorId: string;
  email: string | null;
  name: string | null;
}

export function findeMitglied<T extends OrgMitglied>(mitglieder: T[], suche: string): T[] {
  const roh = suche.trim();
  const s = roh.toLowerCase();
  if (!s) return [];
  const exakt = mitglieder.filter((m) => m.actorId === roh || (m.email ?? "").toLowerCase() === s);
  if (exakt.length) return exakt;
  const namen = mitglieder.filter((m) => m.name !== null && gleicherName(m.name, roh));
  if (namen.length) return namen;
  return mitglieder.filter((m) => (m.name ?? "").toLowerCase().includes(s) || (m.email ?? "").toLowerCase().includes(s));
}

/** Wie ein Mitglied in Rueckfragen und Antworten heisst. */
export function mitgliedAnzeige(m: OrgMitglied): string {
  if (m.name && m.email) return `${m.name} (${m.email})`;
  return m.name ?? m.email ?? m.actorId;
}
