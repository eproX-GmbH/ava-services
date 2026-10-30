// Website-Themen (docs/PLAN_THEMEN.md): wonach der Website-Producer bei jeder
// Firma zusaetzlich sucht. Lokal je Nutzer gespeichert, per Datei an den
// Producer gereicht. Nicht zu verwechseln mit den Nachrichtenthemen (`topics`)
// im Nutzerprofil.

export interface ThemaBegriff {
  text: string;
  /** nutzer = vom Nutzer eingetragen, ava = von AVA ergaenzt. */
  quelle: "nutzer" | "ava";
}

export interface Thema {
  id: string;
  /** Slug aus dem Namen, Schluessel des Befunds in der Website-DB. */
  schluessel: string;
  name: string;
  beschreibung: string;
  /** Wozu der Nutzer das Thema braucht; fliesst in das Urteil ein. */
  warum: string;
  begriffe: ThemaBegriff[];
  aktiv: boolean;
  quelle: "nutzer" | "icp";
  createdAt: string;
  updatedAt: string;
}

export interface ThemaEingabe {
  id?: string;
  name: string;
  beschreibung?: string;
  warum?: string;
  /** Begriffe des Nutzers (ersetzen die bisherigen Nutzer-Begriffe). */
  begriffe?: string[];
  aktiv?: boolean;
  quelle?: "nutzer" | "icp";
}

export const MAX_AKTIVE_THEMEN = 5;
export const MAX_THEMEN = 20;

/** Slug: "Betriebliche Altersvorsorge" → "betriebliche-altersvorsorge". */
export function themaSchluessel(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
