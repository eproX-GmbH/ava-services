// Website-Walker, Schicht 3: Signalbewertung je Block und Zweck
// (docs/PLAN_WEBSITE_WALKER.md §2). Billige Regeln, kein Modell: Nur Blöcke
// über der Schwelle gehen ins Modell, je Lauf gedeckelt.

import type { Block } from "./bloecke";

export type SignalZweck = "stellen" | "referenzen" | "personen";

const SIGNALE: Record<SignalZweck, Array<{ re: RegExp; gewicht: number }>> = {
  stellen: [
    { re: /\(\s*[mwdfx]\s*[\/|]\s*[mwdfx]\s*([\/|]\s*[mwdfx*]\s*)?\)|\(gn\)|\(all genders\)/gi, gewicht: 4 },
    { re: /\b(vollzeit|teilzeit|full[- ]time|part[- ]time|remote|hybrid|homeoffice|unbefristet|festanstellung)\b/gi, gewicht: 2 },
    { re: /\b(bewerb|apply|bewirb dich|jetzt bewerben|deine aufgaben|ihre aufgaben|your tasks|das bringst du mit|dein profil|ihr profil|wir bieten|we offer|requirements|qualifikation)/gi, gewicht: 3 },
    { re: /\b(stellenangebot|stellenanzeige|offene stellen|open positions|job|vacanc|ausbildung|werkstudent|praktikum|trainee|consultant|developer|entwickler|ingenieur|engineer|manager|techniker|monteur|fachkraft|mitarbeiter)\b/gi, gewicht: 1 },
  ],
  referenzen: [
    { re: /\b(referenz|kunden|customers|clients|vertrauen uns|trust us|case stud|erfolgsgeschicht|success stor|projektbericht|zusammenarbeit mit)\b/gi, gewicht: 3 },
    { re: /\b(gmbh|ag|kg|se|ltd|inc|group|holding)\b/gi, gewicht: 1 },
  ],
  personen: [
    { re: /\b(geschäftsführ|geschaeftsfuehr|ceo|cto|cfo|coo|leiter|leitung|head of|director|vertrieb|sales|einkauf|prokurist|inhaber|gründer|gruender|ansprechpartner)\b/gi, gewicht: 3 },
    { re: /\b[A-ZÄÖÜ][a-zäöüß]+\s+[A-ZÄÖÜ][a-zäöüß-]+\b/g, gewicht: 1 },
    { re: /@|tel\.?|telefon|phone|\+49/gi, gewicht: 1 },
  ],
};

/** Signaldichte: gewichtete Treffer je 1.000 Zeichen, plus Bonus fuer kurze, dichte Bloecke. */
export function bewerte(block: Block, zweck: SignalZweck): number {
  let punkte = 0;
  const treffer: number[] = [];
  for (const s of SIGNALE[zweck]) {
    const n = (block.text.match(s.re) ?? []).length;
    treffer.push(n);
    punkte += Math.min(n, 12) * s.gewicht;
  }
  // Personen: ohne Rolle oder Kontaktangabe zaehlt ein Block nicht, sonst
  // gewinnt jeder Marketingabsatz mit zwei Grossbuchstaben-Woertern.
  if (zweck === "personen" && (treffer[0] ?? 0) === 0 && (treffer[2] ?? 0) === 0) return 0;
  // Stellen: ohne (m/w/d)-Kennzeichen, Arbeitsmodell oder Bewerbungsaufruf kein Treffer.
  if (zweck === "stellen" && (treffer[0] ?? 0) === 0 && (treffer[1] ?? 0) === 0 && (treffer[2] ?? 0) === 0) return 0;
  const pfad = block.pfad.join(" ").toLowerCase();
  if (zweck === "stellen" && /karriere|career|jobs|stellen|aufgaben|profil|bieten/.test(pfad)) punkte += 3;
  if (zweck === "referenzen" && /referenz|kunden|customers|clients|projekte/.test(pfad)) punkte += 3;
  if (zweck === "personen" && /team|ansprechpartner|kontakt|geschäftsführung|management|über uns/.test(pfad)) punkte += 3;
  return (punkte * 1000) / Math.max(400, block.text.length);
}

/**
 * Blöcke ueber der Schwelle, nach Dichte sortiert, bis zum Zeichenbudget.
 * Reihenfolge der Seite bleibt im Ergebnis erhalten (Fundstellen lesbar).
 */
export function waehle(bloecke: Block[], zweck: SignalZweck, opts: { schwelle?: number; budgetZeichen?: number; maxBloecke?: number } = {}): Block[] {
  const schwelle = opts.schwelle ?? 6;
  const budget = opts.budgetZeichen ?? 12_000;
  const maxBloecke = opts.maxBloecke ?? 40;
  const bewertet = bloecke.map((b) => ({ b, p: bewerte(b, zweck) })).filter((x) => x.p >= schwelle);
  // Mit Schwelle: dichteste zuerst ins Budget. Ohne Schwelle (ganze Anzeige): Lesereihenfolge.
  if (schwelle > 0) bewertet.sort((a, c) => c.p - a.p);
  const gewaehlt: Block[] = [];
  let zeichen = 0;
  for (const { b } of bewertet) {
    if (gewaehlt.length >= maxBloecke || zeichen + b.text.length > budget) continue;
    gewaehlt.push(b);
    zeichen += b.text.length;
  }
  return gewaehlt.sort((a, b) => (a.url === b.url ? a.pos - b.pos : a.url.localeCompare(b.url)));
}
