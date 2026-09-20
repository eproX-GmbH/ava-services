// Suche über die Ansprechpartner einer Firma.
//
// Die Kontakte liegen bereits vollständig im Fenster — es lohnt also keine
// Abfrage, und eine unscharfe Suche ist ohne Kosten zu haben. Sie darf
// deshalb großzügig sein: Wer "vertrieb" tippt, will auch
// "Vertriebsinnendienst" sehen, und wer sich vertippt, soll trotzdem finden.
//
// Bewusst ohne fremde Bibliothek: Der gesuchte Umfang sind ein paar hundert
// Einträge im Speicher, und die Regeln sollen nachvollziehbar bleiben —
// insbesondere die Umlaut-Faltung, die hier dieselbe ist wie bei der
// Kontakt-Zuordnung im Gateway ("Müller" findet "Mueller" und umgekehrt).

/** Vergleichsform: Kleinschreibung, Umlaute ausgeschrieben, Akzente ab. */
export function faltung(v: string): string {
  return v
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Enthält `text` die Buchstaben von `suche` der Reihe nach?
 *
 * Fängt Tippfehler und Abkürzungen ab: "vrtrb" findet "Vertrieb",
 * "gschftsf" findet "Geschäftsführer". Bewusst nur als letzte Stufe — für
 * sich genommen trifft das viel zu viel.
 */
export function istTeilfolge(text: string, suche: string): boolean {
  if (suche.length === 0) return true;
  let i = 0;
  for (const z of text) {
    if (z === suche[i]) i++;
    if (i === suche.length) return true;
  }
  return false;
}

/**
 * Punktzahl eines einzelnen Begriffs gegen einen einzelnen Wert.
 * 0 bedeutet: kein Treffer.
 *
 * Die Abstufung bildet ab, wie sicher der Treffer ist: Ein Wortanfang wiegt
 * schwerer als ein Vorkommen mitten im Wort, und beides schwerer als eine
 * bloße Buchstabenfolge.
 */
export function punkte(wert: string, begriff: string): number {
  if (!wert || !begriff) return 0;
  const w = faltung(wert);
  const b = faltung(begriff);
  if (!w || !b) return 0;
  if (w === b) return 100;
  if (w.startsWith(b)) return 80;
  // Anfang eines Wortes im Wert — "sales" in "Regional Sales Director".
  if (w.includes(` ${b}`)) return 70;
  if (w.includes(b)) return 50;
  if (b.length >= 3 && istTeilfolge(w, b)) return 20;
  return 0;
}

/** Ein durchsuchbares Feld mit seinem Gewicht. */
export interface Feld {
  wert: string | null | undefined;
  /** Höheres Gewicht = der Treffer zählt mehr. Name schlägt Abteilung. */
  gewicht: number;
}

/**
 * Punktzahl eines Eintrags für die gesamte Eingabe.
 *
 * Mehrere Begriffe werden UND-verknüpft: "meier vertrieb" findet nur, wer
 * beides erfüllt — der eine Begriff im Namen, der andere in der Position.
 * Genau so sucht man einen bestimmten Menschen in einer langen Liste.
 */
export function bewerte(felder: Feld[], eingabe: string): number {
  const begriffe = faltung(eingabe).split(" ").filter(Boolean);
  if (begriffe.length === 0) return 1;
  let summe = 0;
  for (const begriff of begriffe) {
    let bester = 0;
    for (const f of felder) {
      const p = punkte(f.wert ?? "", begriff) * f.gewicht;
      if (p > bester) bester = p;
    }
    if (bester === 0) return 0; // ein Begriff ohne Treffer — Eintrag fällt raus
    summe += bester;
  }
  return summe;
}
