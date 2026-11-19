// Erstansprache (docs/PLAN_ERSTANSPRACHE.md, A1/A3): reine Logik ohne Netz und Speicher.
//
//   aufhaengerBilden   aus den gesammelten Firmendaten die drei bis fuenf staerksten Anlaesse,
//                      je mit Quelle, Datum und Pruefschluesseln (Rangfolge nach Frische und
//                      Staerke, siehe Plan 3.).
//   anspracheTextPruefen deterministische Pruefung eines Entwurfs: Fakten aus der Vorbereitung,
//                      Bezug im Einstieg, Laenge je Kanal, Floskeln, Platzhalter, Ueberwachungston.
//
// Kein KI-Aufruf: kostet nichts, ist erklaerbar und in Tests festzuhalten (Entscheidung 2).

export type Kanal = "mail" | "linkedin";

export interface Aufhaenger {
  art: "personal" | "meldung" | "expansion" | "fokus" | "stellen" | "finanzen" | "fluktuation" | "kunden" | "produkte" | "linkedin";
  /** Ein Satz, so wie er in der Antwort ueber dem Entwurf steht. */
  fakt: string;
  quelle: string | null;
  datum: string | null;
  /** 1 (Hintergrund) bis 5 (frischer, persoenlicher Anlass). */
  staerke: number;
  /** Woerter und Zahlen, an denen die Pruefung erkennt, dass die Mail den Fakt nutzt. */
  schluessel: string[];
}

export interface AnspracheRohdaten {
  heute: Date;
  empfaengerName?: string | null;
  ereignisse: Array<{ art: string; person?: string | null; rolleVorher?: string | null; rolle?: string | null; bereich?: string | null; zeitpunkt: string; zeitpunktArt?: string | null; quelle?: string | null; url?: string | null }>;
  meldungen: Array<{ kind: string; headline: string; createdAt: string; url?: string | null }>;
  expansion: Array<{ art?: string | null; titel?: string | null; datum?: string | null; wert?: string | null; quelle?: string | null }>;
  stellen: { anzahl: number; titel: string[] };
  fokus: Array<{ thema: string; status: string; zitat?: string | null; quelle?: string | null }>;
  finanzen: Array<{ jahr: number | string | null; umsatz?: string | null; mitarbeiter?: number | null }>;
  fluktuation: string[];
  kunden: string[];
  produkte: string | null;
  linkedin: Array<{ authorName?: string | null; summary?: string | null; postedAt?: string | null; permalink?: string | null; signalStrength?: number | null }>;
}

const TAG = 86_400_000;
const tage = (iso: string | null | undefined, heute: Date): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (heute.getTime() - t) / TAG : null;
};
const monat = (iso: string | null | undefined): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` : null;
};
const falten = (s: string) => s.toLocaleLowerCase("de-DE").normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ß/g, "ss");

/** Pruefschluessel: Zahlen (ab zwei Stellen), Eigennamen und lange Woerter eines Texts. */
export function schluesselAus(...texte: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const t of texte) {
    if (!t) continue;
    for (const z of t.match(/\d[\d.,]*\d|\d{2,}/g) ?? []) out.add(z.replace(/[.,]$/, ""));
    for (const w of t.split(/[^\p{L}\d-]+/u)) {
      if (w.length >= 6 && !STOPP.has(falten(w))) out.add(w);
    }
  }
  return [...out].slice(0, 12);
}
const STOPP = new Set(["unternehmen", "gmbh", "mitarbeiter", "mitarbeitende", "leitung", "manager", "management", "bereich", "deutschland", "aktuell", "zusammen", "insgesamt"].map(falten));

/** Umsatz-Text („12.345.678 EUR“) zu einer Zahl. */
export function betragZahl(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/\s/g, "").match(/-?[\d.]+(,\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const mio = (n: number) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Mio. EUR` : `${Math.round(n).toLocaleString("de-DE")} EUR`);

export function aufhaengerBilden(d: AnspracheRohdaten, max = 5): Aufhaenger[] {
  const liste: Aufhaenger[] = [];
  const empf = d.empfaengerName ? falten(d.empfaengerName) : null;

  // Personalwechsel: frisch und beim Empfaenger am staerksten.
  for (const e of d.ereignisse) {
    const alter = tage(e.zeitpunkt, d.heute);
    if (alter === null || alter > 365) continue;
    const beimEmpfaenger = Boolean(empf && e.person && falten(e.person).split(/\s+/).some((w) => w.length > 2 && empf.includes(w)));
    const wer = e.person ?? "Eine Person";
    const fakt =
      e.art === "neu" ? `${wer} ist neu als ${e.rolle ?? "Führungskraft"}`
      : e.art === "verlassen" ? `${wer} (${e.rolleVorher ?? "?"}) hat die Firma verlassen`
      : `${wer}: ${e.rolleVorher ?? "?"} → ${e.rolle ?? "?"}`;
    const wann = e.zeitpunktArt === "laut_profil" ? `seit ${monat(e.zeitpunkt)} laut Profil` : `bemerkt ${monat(e.zeitpunkt)}`;
    liste.push({
      art: "personal",
      fakt: `${fakt} (${wann})`,
      quelle: e.url ?? e.quelle ?? null,
      datum: e.zeitpunkt.slice(0, 10),
      staerke: beimEmpfaenger ? 5 : alter <= 180 ? 4 : 3,
      schluessel: schluesselAus(e.person, e.rolle, e.rolleVorher),
    });
  }

  // Meldungen der letzten 90 Tage (vom Nutzer schon als wichtig bewertet).
  for (const m of d.meldungen) {
    const alter = tage(m.createdAt, d.heute);
    if (alter === null || alter > 90 || m.kind === "workflow" || m.kind === "import-finished" || m.kind === "reminder") continue;
    liste.push({ art: "meldung", fakt: m.headline, quelle: m.url ?? null, datum: m.createdAt.slice(0, 10), staerke: alter <= 30 ? 4 : 3, schluessel: schluesselAus(m.headline) });
  }

  for (const x of d.expansion) {
    const alter = tage(x.datum, d.heute);
    if (alter !== null && alter > 365) continue;
    const titel = x.titel?.trim();
    if (!titel) continue;
    liste.push({ art: "expansion", fakt: `${x.art ? `${x.art}: ` : ""}${titel}${x.wert ? ` (${x.wert})` : ""}`, quelle: x.quelle ?? null, datum: x.datum ?? null, staerke: alter !== null && alter <= 180 ? 4 : 3, schluessel: schluesselAus(titel, x.wert) });
  }

  for (const f of d.fokus.filter((t) => t.status === "gefunden")) {
    liste.push({ art: "fokus", fakt: `${f.thema}${f.zitat ? `: „${f.zitat.slice(0, 160)}“` : ""}`, quelle: f.quelle ?? null, datum: null, staerke: 4, schluessel: schluesselAus(f.thema, f.zitat) });
  }

  for (const p of d.linkedin.filter((x) => (x.signalStrength ?? 0) >= 3).slice(0, 2)) {
    const alter = tage(p.postedAt, d.heute);
    if (alter !== null && alter > 120) continue;
    if (!p.summary) continue;
    liste.push({ art: "linkedin", fakt: `${p.authorName ? `${p.authorName} auf LinkedIn: ` : "LinkedIn: "}${p.summary.slice(0, 180)}`, quelle: p.permalink ?? null, datum: p.postedAt?.slice(0, 10) ?? null, staerke: 3, schluessel: schluesselAus(p.summary) });
  }

  if (d.stellen.anzahl > 0) {
    const titel = d.stellen.titel.slice(0, 3);
    liste.push({ art: "stellen", fakt: `${d.stellen.anzahl} offene ${d.stellen.anzahl === 1 ? "Stelle" : "Stellen"}${titel.length ? `, u. a. ${titel.join(", ")}` : ""}`, quelle: null, datum: null, staerke: 3, schluessel: schluesselAus(...titel) });
  }

  for (const h of d.fluktuation.slice(0, 1)) liste.push({ art: "fluktuation", fakt: h, quelle: null, datum: null, staerke: 2, schluessel: schluesselAus(h) });

  // Finanzen: juengstes Jahr, mit Entwicklung zum Vorjahr, wenn beide Umsaetze da sind.
  const [j0, j1] = d.finanzen;
  if (j0 && (j0.umsatz || j0.mitarbeiter)) {
    const u0 = betragZahl(j0.umsatz);
    const u1 = betragZahl(j1?.umsatz);
    const pct = u0 !== null && u1 !== null && u1 > 0 ? Math.round(((u0 - u1) / u1) * 100) : null;
    const teile = [
      u0 !== null ? `Umsatz ${mio(u0)}${pct !== null ? ` (${pct >= 0 ? "+" : ""}${pct} % zum Vorjahr)` : ""}` : null,
      j0.mitarbeiter ? `${j0.mitarbeiter.toLocaleString("de-DE")} Mitarbeitende` : null,
    ].filter(Boolean);
    const auffaellig = pct !== null && Math.abs(pct) >= 10;
    liste.push({ art: "finanzen", fakt: `${teile.join(", ")} laut Jahresabschluss ${j0.jahr ?? ""}`.trim(), quelle: "Jahresabschluss", datum: j0.jahr ? String(j0.jahr) : null, staerke: auffaellig ? 3 : 2, schluessel: schluesselAus(teile.join(" "), j0.mitarbeiter ? String(j0.mitarbeiter) : null) });
  }

  if (d.kunden.length > 0) {
    const k = d.kunden.slice(0, 4);
    liste.push({ art: "kunden", fakt: `Nennt als Kunden/Referenzen: ${k.join(", ")}`, quelle: "Website", datum: null, staerke: 2, schluessel: k });
  }

  if (d.produkte) liste.push({ art: "produkte", fakt: d.produkte.slice(0, 220), quelle: "Firmenprofil", datum: null, staerke: 1, schluessel: schluesselAus(d.produkte) });

  // Staerke, dann Frische; je Art hoechstens zwei, damit nicht fuenf Personalwechsel alles fuellen.
  const sortiert = liste.sort((a, b) => b.staerke - a.staerke || (b.datum ?? "").localeCompare(a.datum ?? ""));
  const jeArt = new Map<string, number>();
  const aus: Aufhaenger[] = [];
  for (const a of sortiert) {
    const n = jeArt.get(a.art) ?? 0;
    if (n >= 2) continue;
    jeArt.set(a.art, n + 1);
    aus.push(a);
    if (aus.length >= max) break;
  }
  return aus;
}

// ---- Pruefung --------------------------------------------------------------

export const LAENGE: Record<Kanal, { min: number; max: number }> = {
  mail: { min: 60, max: 200 },
  linkedin: { min: 25, max: 110 },
};

const FLOSKELN = [
  "ich hoffe, diese mail erreicht sie gut", "ich hoffe, es geht ihnen gut", "ich hoffe, sie hatten", "innovative lösung", "innovativen lösung",
  "synergie", "win-win", "ganzheitlich", "maßgeschneiderte lösung", "massgeschneiderte loesung", "state of the art", "best in class",
  "auf ihre rückmeldung freue ich mich", "zögern sie nicht", "zoegern sie nicht", "ich möchte mich kurz vorstellen", "mein name ist",
  "wie geht es ihnen", "game changer", "gamechanger", "revolutionär", "mehrwert bieten", "nächste level", "naechste level",
];
const UEBERWACHUNG = /\b(haben|habe|hat|wurde|wurden)\b[^.!?]{0,60}\b(ausgewertet|analysiert|überwacht|ueberwacht|getrackt|beobachtet|gescannt)\b/i;
const PLATZHALTER = /\[[^\]\n]{2,40}\]|\{\{|\}\}|\bXXX\b|\bTODO\b|<[A-ZÄÖÜ][^>]{1,30}>/;

export interface Pruefergebnis {
  bestanden: boolean;
  woerter: number;
  genutzteAufhaenger: string[];
  maengel: string[];
  hinweise: string[];
}

/** Text ohne Anrede-/Grusszeilen fuer Laenge und Einstieg. */
function kern(text: string): { saetze: string[]; woerter: number } {
  const zeilen = text.split(/\n+/).map((z) => z.trim()).filter(Boolean);
  const ohne = zeilen.filter((z, i) => !(i === 0 && /^(hallo|guten tag|sehr geehrte|liebe|lieber|hi|moin|servus)\b/i.test(z)) && !/^(beste|viele|freundliche|mit freundlichen|herzliche|liebe) gr(ü|ue)(ß|ss)e/i.test(z));
  // Alles nach der Grussformel faellt weg (Signatur).
  const gruss = ohne.findIndex((z) => /^(beste|viele|freundliche|mit freundlichen|herzliche) gr/i.test(z));
  const rumpf = (gruss >= 0 ? ohne.slice(0, gruss) : ohne).join(" ");
  const saetze = rumpf.split(/(?<=[.!?])\s+/).filter(Boolean);
  return { saetze, woerter: rumpf.split(/\s+/).filter(Boolean).length };
}

export function anspracheTextPruefen(text: string, aufhaenger: Aufhaenger[], o: { kanal?: Kanal; empfaengerName?: string | null; minFakten?: number; betreff?: string | null } = {}): Pruefergebnis {
  const kanal = o.kanal ?? "mail";
  const maengel: string[] = [];
  const hinweise: string[] = [];
  // Fakten zaehlen auch im Betreff; Laenge und Einstieg nur im Text.
  const f = falten(`${o.betreff ?? ""}\n${text}`);
  const { saetze, woerter } = kern(text);

  const trifft = (a: Aufhaenger) => a.schluessel.some((s) => s.length >= 2 && f.includes(falten(s)));
  const genutzt = aufhaenger.filter(trifft);
  const mindestens = Math.min(o.minFakten ?? 2, aufhaenger.length);
  if (genutzt.length < mindestens) maengel.push(`Nutzt ${genutzt.length} von mindestens ${mindestens} Fakten aus der Vorbereitung; baue die stärksten Aufhänger konkret ein (Namen, Zahlen, Daten).`);

  const einstieg = falten(saetze.slice(0, 2).join(" "));
  if (aufhaenger.length > 0 && !aufhaenger.some((a) => a.schluessel.some((s) => s.length >= 2 && einstieg.includes(falten(s))))) {
    maengel.push("Der Einstieg (erste zwei Sätze) hat keinen konkreten Bezug zur Firma; beginne mit dem stärksten Anlass statt mit einer Vorstellung.");
  }

  const { min, max } = LAENGE[kanal];
  if (woerter > max) maengel.push(`Zu lang: ${woerter} Wörter, höchstens ${max} (${kanal === "mail" ? "Mail" : "LinkedIn-Nachricht"}). Kürze auf Anlass, These, Nutzen, Vorschlag, eine Frage.`);
  if (woerter < min) hinweise.push(`Sehr kurz: ${woerter} Wörter.`);

  const floskeln = FLOSKELN.filter((x) => f.includes(falten(x)));
  if (floskeln.length) maengel.push(`Floskeln streichen: ${floskeln.map((x) => `„${x}“`).join(", ")}.`);
  if (PLATZHALTER.test(text)) maengel.push("Enthält Platzhalter; fülle sie aus der Vorbereitung oder frage den Nutzer einmal gebündelt.");
  if (UEBERWACHUNG.test(text)) hinweise.push("Klingt nach Überwachung („ausgewertet“, „analysiert“). Besser: „Mir ist aufgefallen, dass …“. Nur behalten, wenn der Nutzer das so will.");

  const fragen = (text.match(/\?/g) ?? []).length;
  if (fragen === 0) hinweise.push("Keine Frage am Ende; eine konkrete Frage erleichtert die Antwort.");
  if (fragen > 2) hinweise.push(`${fragen} Fragen; eine reicht.`);

  if (o.empfaengerName) {
    const nachname = o.empfaengerName.trim().split(/\s+/).pop() ?? "";
    if (nachname.length > 1 && !f.includes(falten(nachname))) hinweise.push(`Der Empfänger (${o.empfaengerName}) wird nicht mit Namen angesprochen.`);
  }

  return { bestanden: maengel.length === 0, woerter, genutzteAufhaenger: genutzt.map((a) => a.fakt), maengel, hinweise };
}
