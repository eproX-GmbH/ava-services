// Startvorschlaege fuer ein Buying Center aus dem, was AVA schon weiss
// (docs/PLAN_BUYING_CENTER.md, Abschnitt 6).
//
// Nur ROLLE und EINFLUSS werden aus dem Titel vorgeschlagen. Einstellung
// bleibt reine Nutzerangabe: Aus einem Titel oder einem Repost laesst sich
// Engagement ablesen, nicht Wohlwollen uns gegenueber — und es ist die
// Dimension, die in einer Auskunft am heikelsten ist.
//
// Jeder Vorschlag traegt seinen Grund im Klartext. Das ist kein Schmuck:
// Die Seitenleiste zeigt ihn, und der Nutzer entscheidet an ihm entlang.
//
// Reine Funktionen, damit sie pruefbar bleiben.

export const ROLLEN = ["E", "B", "N", "R", "S", "EK", "GK"] as const;
export type Rolle = (typeof ROLLEN)[number];
export const EINSTELLUNGEN = ["C", "+", "=", "-", "F"] as const;
export const KONTAKTE = ["0", "S", "R", "I"] as const;
export const EINFLUESSE = ["G", "M", "H"] as const;
export const KANTEN_ARTEN = ["EINFLUSS", "VERTRAUT", "ANIMOSITAET"] as const;

export interface Vorschlag {
  dimension: "rolle" | "einfluss";
  wert: string;
  grund: string;
}

/**
 * Aus einem Titel ableiten, was sich ableiten laesst.
 *
 * Das Buch warnt ausdruecklich: Die Stellung in der Hierarchie laesst nicht
 * auf den Einfluss schliessen. Deshalb bekommt der Geschaeftsfuehrer
 * Einfluss "H" nur als VORSCHLAG mit genau dieser Begruendung — der
 * Nutzer soll ihn bewusst annehmen oder durch sein Wissen ersetzen.
 */
export function vorschlaegeAusTitel(titel: string | null | undefined): Vorschlag[] {
  const t = (titel ?? "").toLowerCase();
  if (!t.trim()) return [];
  const aus: Vorschlag[] = [];
  const grund = (was: string) => `Titel "${titel}": ${was}`;

  // Assistenz ZUERST: "Assistentin der Geschaeftsfuehrung" enthaelt
  // "Geschaeftsfuehrung" und wuerde sonst zur Entscheiderin — genau die
  // Verwechslung, vor der das Buch beim Gatekeeper warnt.
  if (/assisten|sekret|office manag|empfang|vorzimmer/.test(t)) {
    aus.push({ dimension: "rolle", wert: "GK", grund: grund("Assistenz oeffnet oder verschliesst den Zugang") });
    return aus;
  }

  if (/gesch(ä|ae)ftsf|managing director|\bceo\b|\bcfo\b|\bcoo\b|vorstand|inhaber|\bowner\b|founder|gr(ü|ue)nder/.test(t)) {
    aus.push({ dimension: "rolle", wert: "E", grund: grund("Geschaeftsleitung trifft in der Regel die Entscheidung") });
    aus.push({ dimension: "einfluss", wert: "H", grund: grund("Geschaeftsleitung — nur ein Vorschlag, Hierarchie ist nicht gleich Einfluss") });
    return aus;
  }
  if (/prokurist/.test(t)) {
    aus.push({ dimension: "rolle", wert: "R", grund: grund("Prokura zeichnet Entscheidungen ab") });
    return aus;
  }
  if (/eink(a|ä|ae)uf|purchas|procurement|beschaffung/.test(t)) {
    aus.push({ dimension: "rolle", wert: "EK", grund: grund("Einkauf fuehrt den Einkaufsvorgang und die Verhandlung") });
    return aus;
  }
  if (/\bcto\b|\bcio\b|leiter it|it-leit|head of it|it leit|technischer leiter|technical director/.test(t)) {
    aus.push({ dimension: "rolle", wert: "S", grund: grund("Technische Leitung erstellt in der Regel die Spezifikation") });
    aus.push({ dimension: "rolle", wert: "B", grund: grund("Technische Leitung beeinflusst die Entscheidung") });
    return aus;
  }
  if (/leit|\bhead\b|direktor|director|bereichs|abteilungs/.test(t)) {
    aus.push({ dimension: "rolle", wert: "B", grund: grund("Leitungsebene beeinflusst die Entscheidung") });
    aus.push({ dimension: "einfluss", wert: "M", grund: grund("Leitungsebene — nur ein Vorschlag") });
    return aus;
  }
  if (/controll|finanz|buchhalt|qualit(ä|ae)t|\bqm\b/.test(t)) {
    aus.push({ dimension: "rolle", wert: "B", grund: grund("Controlling/Qualitaet wirkt als interner Beeinflusser") });
    return aus;
  }
  // Alles Uebrige: vermutlich Anwender. Bewusst KEIN Einfluss-Vorschlag —
  // gerade hier sitzen die "Schluesselnutzer", die das Buch beschreibt, und
  // die erkennt nur der Nutzer.
  aus.push({ dimension: "rolle", wert: "N", grund: grund("Fachkraft, vermutlich Anwender der Loesung") });
  return aus;
}

/** Leitfrage 1: Welche Rollen sind noch unbesetzt? */
export function unbesetzteRollen(mitglieder: Array<{ rollen: string[] }>): Rolle[] {
  const besetzt = new Set(mitglieder.flatMap((m) => m.rollen));
  // GK und R fehlen oft zu Recht; sie werden nicht angemahnt.
  return (["E", "B", "N", "S", "EK"] as Rolle[]).filter((r) => !besetzt.has(r));
}

/** Leitfrage 3: Zu wem fehlt jeder Kontakt? */
export function ohneKontakt(mitglieder: Array<{ name: string; kontakt: string | null }>): string[] {
  return mitglieder.filter((m) => m.kontakt === null || m.kontakt === "0").map((m) => m.name);
}

/** Namen vergleichbar machen: Titel weg, Umlaute aufloesen, nur Buchstaben. */
export function falteName(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    .replace(/\b(dr|prof|dipl|ing|mba|ba|ma|msc|bsc)\.?\s*/g, "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/\p{M}+/gu, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * BC5 — Verknuepfen freier Personen mit dem Bestand: gleicher Name, auch
 * in anderer Reihenfolge ("Rafflenbeul Joyce"). Nur bei mindestens zwei
 * Namensteilen, damit "Meier" nicht jeden Meier trifft.
 */
export function gleicherName(a: string, b: string): boolean {
  const fa = falteName(a), fb = falteName(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const ta = fa.split(" "), tb = fb.split(" ");
  return ta.length >= 2 && tb.length >= 2 && [...ta].sort().join(" ") === [...tb].sort().join(" ");
}
