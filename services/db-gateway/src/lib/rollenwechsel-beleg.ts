// Rollenwechsel aus Signalen (PERSON_JOB_CHANGED): Ist "alter Titel -> neuer Titel" ein belegter
// Wechsel, den AVA mitbekommen hat? Genutzt von den Meldungen (alerts-neuheiten.ts) und der
// Firmenhistorie (firmen-ereignisse.ts).
//
// Befund Joyce 2026-11-27 (Nils Diermann, SEMA Systemtechnik): "Technischer Produktdesigner ->
// Werkstudent", als Stellenwechsel von heute gemeldet. Der alte Titel stammte nur aus einem
// undatierten XING-Suchtreffer, erstmals gelesen am 28.10.; laut LinkedIn ist er seit 09/2026
// Werkstudent. AVA hat den alten Stand also nie gesehen, solange er galt.

/** Nur Buchstaben, klein: „Geschäftsleitung“ ≙ „Geschaeftsleitung“, "A; B" ≙ "A und B". */
export function schreibweise(v: string | null | undefined): string {
  return (v ?? "")
    .toLowerCase()
    // Umlaute wie ausgeschrieben (vorher wurde „ä“ zu „a“, „ae“ blieb „ae“: kein Treffer)
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\b(und|and|sowie)\b|&/g, " ")
    .replace(/[^a-z]/g, "");
}

export interface Sichtung {
  value: string | null;
  am: string | Date | number;
  quelle: string | null;
}

export type WechselAbgelehnt = "alter_stand_nur_suchtreffer" | "neue_rolle_aelter_als_alter_stand";

/** Suchtreffer (Google, XING-/LinkedIn-Schnipsel) tragen kein Datum und zeigen oft einen alten Stand. */
export function istSuchtreffer(quelle: string | null | undefined): boolean {
  return (quelle ?? "").toLowerCase().startsWith("search");
}

/**
 * Prueft einen gemeldeten Rollenwechsel gegen alle Sichtungen des Felds.
 *
 * - Der alte Titel ist nur aus Suchtreffern bekannt: Wann er galt, ist offen; er taugt nicht als
 *   "vorher" (dieselbe Regel gilt schon fuer einen neuen Titel aus Suchtreffern).
 * - Die neue Rolle begann laut Profil schon, bevor AVA den alten Titel zum ersten Mal sah: Der
 *   alte Stand war beim Lesen schon ueberholt, AVA hat keinen Wechsel beobachtet.
 *
 * `beginnNeu` nur uebergeben, wenn er sicher zur neuen Rolle gehoert (siehe `beginnFuerTitel`).
 * Ohne Sichtungen des alten Titels bleibt es beim Signal (nichts zu pruefen).
 */
export function rollenwechselBeleg(a: {
  vorher: string | null;
  sichtungen: Sichtung[];
  beginnNeu: Date | string | null | undefined;
  signalAm: Date | string | number;
}): { belegt: true } | { belegt: false; grund: WechselAbgelehnt } {
  const altNorm = schreibweise(a.vorher);
  const signalAm = new Date(a.signalAm).getTime();
  const alt = a.sichtungen.filter((s) => altNorm && schreibweise(s.value) === altNorm && new Date(s.am).getTime() <= signalAm);
  if (alt.length === 0) return { belegt: true };
  if (alt.every((s) => istSuchtreffer(s.quelle))) return { belegt: false, grund: "alter_stand_nur_suchtreffer" };
  if (a.beginnNeu) {
    const beginn = new Date(a.beginnNeu).getTime();
    const ersteAlt = Math.min(...alt.map((s) => new Date(s.am).getTime()));
    if (Number.isFinite(beginn) && beginn <= ersteAlt) return { belegt: false, grund: "neue_rolle_aelter_als_alter_stand" };
  }
  return { belegt: true };
}

/** Beginn laut Profil nur, wenn die Beschaeftigung, die ihn traegt, auch den neuen Titel hat. */
export function beginnFuerTitel(titelBeschaeftigung: string | null | undefined, beginn: Date | string | null | undefined, titelNeu: string | null | undefined): Date | null {
  if (!beginn || !titelNeu) return null;
  if (schreibweise(titelBeschaeftigung) !== schreibweise(titelNeu)) return null;
  const d = new Date(beginn);
  return Number.isFinite(d.getTime()) ? d : null;
}
