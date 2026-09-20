// Relevanz: die Rechnung (docs/PLAN_RELEVANZ.md, Abschnitt 5).
//
// Reine Funktionen, keine Datenbank, keine Uhr ausser der uebergebenen —
// damit das Herzstueck pruefbar bleibt. Wer hier etwas aendert, aendert,
// was Nutzer als "heiss" und "kalt" erleben; die Tabelle in scripts/
// test-relevanz.mjs haelt die Erwartungen fest.
//
// Zwei Groessen, die getrennt bleiben:
//   Naehe   aus Verhalten, mit Halbwertszeit — misst Aufmerksamkeit.
//   Gewicht aus ICP, Firmenstatus, Pipeline — misst Passung.
// Der Rang mischt sie. Die Trennung ist Absicht: Eine nie angesehene Firma
// kann trotzdem wichtig sein, und ohne den zweiten Wert entstuende eine
// Rueckkopplung, die genau solche Firmen nie wieder sichtbar macht.

/** Ein Rohsignal, so wie es in der Datenbank liegt. */
export interface Signal {
  art: string;
  punkte: number;
  /** Halbwertszeit in Tagen. */
  halbwertT: number;
  zeitpunkt: Date;
}

/** Ab diesem Rohwert ist die Naehe 10. */
export const SAETTIGUNG = 30;
/** Zuschlag je weiterem Tag, an dem ein Signal fiel. */
export const WIEDERKEHR_PRO_TAG = 4;
/** Mehr als so viele zusaetzliche Tage zaehlen nicht (Deckel +20). */
export const WIEDERKEHR_MAX_TAGE = 5;
/** Ab dieser Naehe gilt ein Ziel als "warm" (Aggregat, Alarmstufen). */
export const WARM_AB = 6;

const TAG_MS = 86_400_000;

/** Abnahme eines Signals: 1 beim Eintreffen, 0,5 nach einer Halbwertszeit. */
export function verfall(signal: Signal, jetzt: Date): number {
  const alterTage = (jetzt.getTime() - signal.zeitpunkt.getTime()) / TAG_MS;
  if (alterTage <= 0) return 1; // Uhrversatz: wie eben eingetroffen behandeln
  if (signal.halbwertT <= 0) return 0;
  return Math.pow(2, -alterTage / signal.halbwertT);
}

/**
 * Wiederkehr: der wichtigste Teil der Rechnung.
 *
 * Ein einzelner Aufruf heisst wenig — vielleicht hat jemand danebengeklickt.
 * Wer an einem zweiten und dritten Tag zurueckkommt, hat sich entschieden.
 * Gezaehlt werden deshalb verschiedene TAGE, nicht verschiedene Aufrufe:
 * zehnmal neuladen ist kein Interesse, am naechsten Morgen wiederkommen
 * schon.
 *
 * Der Zuschlag verfaellt mit dem juengsten Signal. Sonst bliebe eine vor
 * einem Jahr intensiv bearbeitete Firma fuer immer warm.
 */
export function wiederkehr(signale: Signal[], jetzt: Date): number {
  if (signale.length === 0) return 0;
  const tage = new Set(signale.map((s) => s.zeitpunkt.toISOString().slice(0, 10)));
  const zusatz = Math.min(WIEDERKEHR_MAX_TAGE, tage.size - 1);
  if (zusatz <= 0) return 0;
  const juengstes = signale.reduce((a, b) => (a.zeitpunkt > b.zeitpunkt ? a : b));
  return WIEDERKEHR_PRO_TAG * zusatz * verfall(juengstes, jetzt);
}

/** Summe der abgeklungenen Signale plus Wiederkehr. Nie unter 0. */
export function rohwert(signale: Signal[], jetzt: Date): number {
  let summe = 0;
  for (const s of signale) summe += s.punkte * verfall(s, jetzt);
  return Math.max(0, summe + wiederkehr(signale, jetzt));
}

/**
 * Rohwert auf 1..10 abbilden. Logarithmisch, weil die Rohwerte stark
 * rechtsschief sind: Wenige Ziele sammeln sehr viel, und linear waere
 * alles andere ununterscheidbar nah an 1.
 */
export function naeheAusRohwert(roh: number): number {
  if (roh <= 0) return 1;
  const anteil = Math.min(1, Math.log(1 + roh) / Math.log(1 + SAETTIGUNG));
  return Math.round((1 + 9 * anteil) * 10) / 10;
}

export function naehe(signale: Signal[], jetzt: Date): number {
  return naeheAusRohwert(rohwert(signale, jetzt));
}

/**
 * Was die Naehe am staerksten treibt — hoechstens drei Eintraege.
 *
 * Ohne diese Erklaerung ist eine Zahl zwischen 1 und 10 eine Zumutung:
 * Der Nutzer soll nachlesen koennen, warum AVA eine Firma fuer heiss haelt.
 */
export function begruendung(
  signale: Signal[],
  jetzt: Date,
): Array<{ art: string; anteil: number; anzahl: number }> {
  const nachArt = new Map<string, { anteil: number; anzahl: number }>();
  for (const s of signale) {
    const bisher = nachArt.get(s.art) ?? { anteil: 0, anzahl: 0 };
    bisher.anteil += s.punkte * verfall(s, jetzt);
    bisher.anzahl += 1;
    nachArt.set(s.art, bisher);
  }
  const zusatz = wiederkehr(signale, jetzt);
  if (zusatz > 0) nachArt.set("wiederkehr", { anteil: zusatz, anzahl: 1 });
  return Array.from(nachArt.entries())
    .map(([art, v]) => ({ art, anteil: Math.round(v.anteil * 10) / 10, anzahl: v.anzahl }))
    .sort((a, b) => Math.abs(b.anteil) - Math.abs(a.anteil))
    .slice(0, 3);
}

/**
 * Rang fuer die Arbeitsvorschau des Heartbeats.
 *
 * `tageSeitBeobachtung` beugt dem Verhungern vor: Was lange nicht
 * angesehen wurde, steigt langsam — sonst bliebe ein Ziel mit mittlerem
 * Wert fuer immer hinter den heissen liegen.
 */
export function rang(
  naeheWert: number,
  gewichtWert: number,
  tageSeitBeobachtung: number | null,
): number {
  const alterung =
    tageSeitBeobachtung === null || tageSeitBeobachtung <= 30
      ? 0
      : Math.min(3, (tageSeitBeobachtung - 30) / 30);
  return Math.round((0.6 * naeheWert + 0.4 * gewichtWert + alterung) * 100) / 100;
}

/** Personen erben die halbe Naehe ihrer Firma als Untergrenze. Wer eine
 *  Firma heiss findet, findet ihre Geschaeftsfuehrung nicht kalt. */
export function naeheMitVererbung(eigene: number, firmenNaehe: number | null): number {
  if (firmenNaehe === null) return eigene;
  return Math.max(eigene, Math.round((firmenNaehe / 2) * 10) / 10);
}

/** Untergrenze der Naehe fuer Fokuskunden und ihre Buying-Center-Mitglieder. */
export const FOKUS_NAEHE = 7;

/**
 * Buying-Center-Mitgliedschaft ist das staerkste Personensignal, und ein
 * Fokuskunde ist per Definition eine Firma, an der gearbeitet wird
 * (docs/PLAN_BUYING_CENTER.md, Abschnitt 4). Beides hebt die Naehe auf
 * mindestens 7 — nie darunter, auch wenn lange niemand geklickt hat.
 */
export function naeheMitFokus(eigene: number, fokus: boolean): number {
  return fokus ? Math.max(eigene, FOKUS_NAEHE) : eigene;
}
