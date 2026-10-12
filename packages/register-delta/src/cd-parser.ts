// Chronologischer Abdruck (CD) des Registerportals → dieselben Felder wie der
// strukturierte Registerinhalt (si-parser.ts). Fallback, wenn das Portal fuer
// ein Blatt keinen SI liefert (docs/PLAN_STAMMDATEN_DELTA.md S9, 2026-10-12).
//
// Der CD ist eine Text-PDF (iTextSharp), keine gescannte Seite. Sie zeigt die
// Registertabelle mit sechs (HRA) oder sieben (HRB) Spalten; jede Eintragung ist
// eine Zeile mit laufender Nummer, und jede Eintragung nennt nur die Felder, die
// sich geaendert haben. Der aktuelle Stand ist also je Feld der Wert aus der
// juengsten Eintragung, die das Feld fuehrt.
//
// Deterministisch, ohne Modell: Spalten ueber die Kopfzeile und die linken
// Kanten der Inhalte, Abschnitte ueber die Marken a)/b)/c), Personen ueber das
// feste Muster "Nachname, Vorname, Ort, *TT.MM.JJJJ". Was sich so nicht lesen
// laesst, bleibt leer — lieber keine Daten als falsche.

import type { SiGeschaeftsfuehrer, StrukturierterInhalt } from "./si-parser";

/** Ein Textstueck der PDF mit seiner Position (Punkt, Ursprung oben links). */
export type CdText = { x: number; y: number; s: string };
export type CdSeite = { breite: number; hoehe: number; texte: CdText[] };

export type Spalte = "nummer" | "firma" | "kapital" | "vertretung" | "prokura" | "rechtsform" | "tag" | "sonstiges";
type Abschnitt = "a" | "b" | "c" | "-";

/** Eine Eintragung: je Spalte und Abschnitt die Zeilen in Lesereihenfolge. */
export type CdEintrag = {
  nummer: number;
  zellen: Partial<Record<Spalte, Partial<Record<Abschnitt, string[]>>>>;
};

const SPALTEN_KOPF: Array<[Spalte, RegExp]> = [
  ["nummer", /^Num-?$|^Nummer/],
  ["firma", /^(a\)\s*)?Firma$/],
  ["kapital", /Grund- oder|Stammkapital|Grundkapital|Kapital/],
  ["vertretung", /Vertretung/],
  ["prokura", /^Prokura/],
  ["rechtsform", /Rechtsform/],
  ["tag", /Tag der Ein/],
];

/**
 * Kopfzeile der Tabelle: die Zeile mit "Firma". Die Portale setzen den Kopf
 * verschieden: "a) Firma" als ein Textstueck (NRW, Niedersachsen) oder "a)" und
 * "Firma" getrennt, mit Silbentrennung ("Num- mer der Ein- tragung", Berlin).
 */
export function kopfZeile(seite: CdSeite): { y: number; x: number } | null {
  const firma = seite.texte.find((t) => /^(a\)\s*)?Firma$/.test(t.s.trim()) && t.y < seite.hoehe * 0.3);
  if (!firma) return null;
  // Linke Kante der Nummernspalte: kleinstes x in der Kopfzone.
  const zone = seite.texte.filter((t) => t.y >= firma.y - 4 && t.y <= firma.y + 70 && t.x < firma.x);
  const x = zone.length ? Math.min(...zone.map((t) => t.x)) : Math.max(0, firma.x - 40);
  return { y: firma.y, x };
}

/** Sieht der Text nach einem Registerabdruck aus? */
export function istCdSeite(seite: CdSeite): boolean {
  const kopf = seite.texte.filter((t) => t.y < seite.hoehe * 0.2).map((t) => t.s).join(" ");
  return /Handelsregister|Genossenschaftsregister|Partnerschaftsregister|Vereinsregister/.test(kopf) && /Nummer der Firma|Abdruck|Abruf vom/.test(kopf);
}

/**
 * Spaltengrenzen: linke Kante je Spalte, aus der Kopfzeile dieser Seite und den
 * Inhalten ALLER Seiten (eine Folgeseite mit drei Textstuecken hat zu wenig
 * Inhalt, um die zentrierten Ueberschriften zu korrigieren).
 */
export function spaltenErkennen(seite: CdSeite, alle: CdSeite[] = [seite]): Array<{ spalte: Spalte; x: number }> {
  const kopf = kopfZeile(seite);
  if (!kopf) return [];
  const kopfzeile = seite.texte.filter((t) => Math.abs(t.y - kopf.y) <= 3 || (t.y > kopf.y && t.y <= kopf.y + 70 && t.x < kopf.x + 30)).sort((a, b) => a.x - b.x);
  const koepfe: Array<{ spalte: Spalte; x: number }> = [{ spalte: "nummer", x: kopf.x }];
  let marke: number | null = null;
  for (const k of kopfzeile) {
    const text = k.s.trim();
    if (/^[abc]\)$/.test(text)) {
      marke = k.x;
      continue;
    }
    const treffer = SPALTEN_KOPF.find(([, re]) => re.test(text));
    if (treffer && !koepfe.some((x) => x.spalte === treffer[0])) koepfe.push({ spalte: treffer[0], x: marke != null && k.x - marke < 30 ? marke : k.x });
    marke = null;
  }
  if (koepfe.length < 3) return [];
  // Zentrierte Ueberschriften (Prokura, Kapital) stehen rechts von der linken
  // Kante ihres Inhalts: die Kante ist die kleinste Inhalts-x zwischen der
  // vorigen Spalte und der Ueberschrift, wenn sie mindestens zweimal vorkommt.
  // Nur echter Inhalt zaehlt als Kante: nicht die Spaltennummern-Zeile ("1 2 3 …",
  // auf jeder Seite, Befund Hamburg HRA 121775) und keine reinen Ziffern.
  const inhalt = alle.flatMap((s) => {
    const n = kopfZeile(s);
    return n ? s.texte.filter((t) => t.y > n.y + 80 && !/^\d{1,3}$/.test(t.s.trim())) : [];
  });
  const zaehl = new Map<number, number>();
  for (const t of inhalt) zaehl.set(t.x, (zaehl.get(t.x) ?? 0) + 1);
  return koepfe.map((k, i) => {
    const links = i === 0 ? -1 : koepfe[i - 1]!.x + 20;
    const kandidaten = [...zaehl.entries()].filter(([x, n]) => n >= 2 && x > links && x <= k.x + 2).map(([x]) => x);
    return { spalte: k.spalte, x: kandidaten.length ? Math.min(...kandidaten) : k.x };
  });
}

function spalteFuer(grenzen: Array<{ spalte: Spalte; x: number }>, x: number): Spalte {
  let s: Spalte = "sonstiges";
  for (const g of grenzen) if (x + 8 >= g.x) s = g.spalte;
  return s;
}

/** Zeilen einer Textmenge: gleiche Hoehe (±3 Punkt), nach x verbunden. */
function zeilen(texte: CdText[]): Array<{ y: number; s: string }> {
  const sortiert = [...texte].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Array<{ y: number; s: string; teile: CdText[] }> = [];
  for (const t of sortiert) {
    const z = out[out.length - 1];
    if (z && Math.abs(z.y - t.y) <= 3) z.teile.push(t);
    else out.push({ y: t.y, s: "", teile: [t] });
  }
  return out.map((z) => ({ y: z.y, s: z.teile.sort((a, b) => a.x - b.x).map((t) => t.s.trim()).filter(Boolean).join(" ") }));
}

/**
 * Alle Seiten zu Eintragungen zusammenfassen. Eine Eintragung beginnt mit ihrer
 * Nummer in der ersten Spalte; Text vor der ersten Nummer einer Folgeseite
 * gehoert zur letzten Eintragung der Seite davor.
 */
export function eintraegeBilden(seiten: CdSeite[]): CdEintrag[] {
  const eintraege: CdEintrag[] = [];
  let aktuell: CdEintrag | null = null;
  seiten.forEach((seite, seitenIndex) => {
    const grenzen = spaltenErkennen(seite, seiten);
    if (grenzen.length === 0) return;
    // Zeilen ueber Seiten hinweg in Lesereihenfolge halten: y um die Seitenhoehe versetzen.
    const versatz = seitenIndex * (seite.hoehe + 100);
    const kopfY = kopfZeile(seite)!.y;
    // Zeile mit den Spaltennummern (1 2 3 …) direkt unter dem Kopf ueberspringen.
    const inhalt = seite.texte.filter((t) => t.y > kopfY + 40 && t.y < seite.hoehe - 20);
    const zeilenAlle = zeilen(inhalt);
    const nummernZeile = zeilenAlle.find((z) => /^(\d\s+){2,}\d$/.test(z.s.trim()));
    const ab = nummernZeile ? nummernZeile.y + 1 : kopfY + 10;
    const rest = inhalt.filter((t) => t.y > ab);
    const nummern = rest
      .filter((t) => spalteFuer(grenzen, t.x) === "nummer" && /^\d{1,4}$/.test(t.s.trim()))
      .map((t) => ({ y: t.y, n: Number(t.s.trim()) }))
      .sort((a, b) => a.y - b.y);
    const bloecke: Array<{ eintrag: CdEintrag; von: number; bis: number }> = [];
    for (let i = 0; i < nummern.length; i++) {
      const e: CdEintrag = { nummer: nummern[i]!.n, zellen: {} };
      eintraege.push(e);
      bloecke.push({ eintrag: e, von: nummern[i]!.y - 4, bis: nummern[i + 1] ? nummern[i + 1]!.y - 4 : Infinity });
    }
    for (const t of rest) {
      if (spalteFuer(grenzen, t.x) === "nummer") continue;
      const b = bloecke.find((x) => t.y >= x.von && t.y < x.bis);
      const ziel = b ? b.eintrag : aktuell;
      if (!ziel) continue;
      const sp = spalteFuer(grenzen, t.x);
      const zelle = (ziel.zellen[sp] ??= {});
      ((zelle as Record<string, CdText[]>)["__roh"] ??= []).push({ ...t, y: t.y + versatz });
    }
    if (bloecke.length) aktuell = bloecke[bloecke.length - 1]!.eintrag;
  });
  // Rohtexte je Zelle in Zeilen und Abschnitte zerlegen.
  for (const e of eintraege) {
    for (const sp of Object.keys(e.zellen) as Spalte[]) {
      const zelle = e.zellen[sp] as Record<string, unknown>;
      const roh = (zelle["__roh"] as CdText[] | undefined) ?? [];
      delete zelle["__roh"];
      const bestehend = e.zellen[sp] as Partial<Record<Abschnitt, string[]>>;
      let abschnitt: Abschnitt = "-";
      for (const z of zeilen(roh)) {
        if (/^Seite \d+ von \d+$/.test(z.s.trim())) continue;
        const m = /^([abc])\)\s*(.*)$/.exec(z.s);
        if (m) {
          abschnitt = m[1] as Abschnitt;
          if (m[2]) (bestehend[abschnitt] ??= []).push(m[2]);
          else bestehend[abschnitt] ??= [];
          continue;
        }
        (bestehend[abschnitt] ??= []).push(z.s);
      }
    }
  }
  // Silbentrennung am Zeilenende (Berlin: "Mö-" + "beln", "Gesellschaft mit beschränkter" + "Haftung")
  // wieder zusammenfuegen, damit Regeln auf ganze Woerter treffen.
  for (const e of eintraege) {
    for (const sp of Object.keys(e.zellen) as Spalte[]) {
      const zelle = e.zellen[sp]!;
      for (const ab of Object.keys(zelle) as Abschnitt[]) zelle[ab] = glaetten(zelle[ab] ?? []);
    }
  }
  return eintraege.sort((a, b) => a.nummer - b.nummer);
}

/** Zeilen mit Trennstrich am Ende mit der Folgezeile verbinden (nur wenn die klein weitergeht). */
export function glaetten(zeilen: string[]): string[] {
  const out: string[] = [];
  for (const z of zeilen) {
    const vorige = out[out.length - 1];
    if (vorige && /[a-zäöüß]-$/.test(vorige) && /^[a-zäöüß]/.test(z)) out[out.length - 1] = vorige.slice(0, -1) + z;
    else out.push(z);
  }
  return out;
}

/**
 * Personenzeile, zwei Schreibweisen der Portale:
 *   "Nachname, Vorname, Ort, *TT.MM.JJJJ"           (NRW, Niedersachsen, …)
 *   "1. Nachname, Vorname, *TT.MM.JJJJ," + "Ort"     (Berlin: Ort in der Folgezeile)
 */
const PERSON_RE = /^(?:\d+\.\s*)?(?<nachname>[^,*:]+?),\s*(?<vorname>[^,*:]+?),\s*(?:(?<ort>[^,*:]+?)\s*,\s*\*(?<geb>\d{2}\.\d{2}\.\d{4})|\*(?<geb2>\d{2}\.\d{2}\.\d{4}),?\s*(?<ort2>[^,*:]*))/;
/** Abgangszeile ohne Geburtsdatum ("1. Wainstejn, Zachi" nach "Nicht mehr Geschaeftsfuehrer:"). */
const PERSON_KURZ_RE = /^(?:\d+\.\s*)?(?<nachname>[^,*:]+?),\s*(?<vorname>[^,*:]+?)\s*$/;
/** Aktionsueberschriften (enden mit ":"): Abgang … */
const ABGANG_RE = /^(ausgeschieden|nicht mehr|abberufen|gel[öo]scht|gestrichen|erloschen|verstorben|prokura erloschen|die bestellung .* beendet)/i;
/** … oder Zugang/Aenderung. Rollenueberschriften (Geschaeftsfuehrer:, Kommanditist:) aendern den Modus nicht. */
const ZUGANG_RE = /^(bestellt|neu bestellt|eingetreten|erteilt|einzelprokura|gesamtprokura|prokura|.*(ge[äa]ndert|berichtigt), nun|nun:|nach erteilung)/i;
const RECHTSFORM_NAME_RE = /Gesellschaft mit beschränkter Haftung|Unternehmergesellschaft \(haftungsbeschränkt\)|Kommanditgesellschaft auf Aktien|Kommanditgesellschaft|Aktiengesellschaft|Offene Handelsgesellschaft|Europäische (Aktien)?[Gg]esellschaft( \(SE\))?|Societas Europaea|[Ee]ingetragene Genossenschaft|Partnerschaftsgesellschaft( mit beschränkter Berufshaftung)?|Partnerschaft|Einzelkauf(mann|frau)|[Ee]ingetragener? Kauf(mann|frau)|Versicherungsverein auf Gegenseitigkeit|Stiftung|Verein/;
/** Rollenueberschrift ("Geschaeftsfuehrer:", "Kommanditist:"): beginnt einen neuen Zugangsblock (Berlin: nach "Nicht mehr …:" folgt "Geschaeftsfuehrer:" fuer die Neue). */
const ROLLE_RE = /^(gesch[äa]ftsf[üu]hr|vorstand|persönlich haftend|inhaber|liquidator|direktor|prokurist|kommanditist|partner|vertretungsberechtigt|mitglied)[^:]*:\s*$/i;
const LEGAL_FORM_RE = /gesellschaft mit beschr|gmbh|aktiengesellschaft|kommanditgesellschaft|offene handelsgesellschaft|unternehmergesellschaft|einzelkauf|eingetragene? (kauf|genossenschaft)|partnerschaft|societas europaea|\bSE\b|\bAG\b|\bKG\b|\bOHG\b|\be\.K\.|\bUG\b|stiftung|verein|limited|ltd\.?|s\.?à\.?r\.?l|b\.?v\.?|n\.?v\.?|anstalt|k[öo]rperschaft/i;

function isoDatum(d: string | undefined): string | null {
  const m = d ? /(\d{2})\.(\d{2})\.(\d{4})/.exec(d) : null;
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function betrag(s: string): number | null {
  const m = /(\d{1,3}(?:\.\d{3})*(?:,\d+)?|\d+(?:,\d+)?)\s*(EUR|€|DEM|DM)?/.exec(s);
  if (!m) return null;
  const n = Number(m[1]!.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // DM-Betraege (alte Blaetter) nicht als Euro ausgeben.
  if (m[2] && /DEM|DM/.test(m[2])) return null;
  return n;
}

const kappe = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Juengste Eintragung mit Inhalt in Spalte/Abschnitt. */
function letzte(eintraege: CdEintrag[], sp: Spalte, ab: Abschnitt): string[] | null {
  for (let i = eintraege.length - 1; i >= 0; i--) {
    const z = eintraege[i]!.zellen[sp]?.[ab];
    if (z && z.length) return z;
  }
  return null;
}

/** Aktueller Stand aus den Eintragungen. null, wenn nicht einmal die Firma lesbar ist. */
export function zustandAus(eintraege: CdEintrag[], erwarteterName?: string): StrukturierterInhalt | null {
  if (eintraege.length === 0) return null;
  // Ankuendigungen ("Firma geaendert, nun:") gehoeren nicht zum Namen.
  const name = (letzte(eintraege, "firma", "a") ?? []).filter((z) => !/:\s*$/.test(z)).join(" ").replace(/\s+/g, " ").trim();
  if (!name) return null;
  if (erwarteterName && !namenPassen(name, erwarteterName)) return null;

  // Sitz und Geschaeftsanschrift aus firma b), je der juengste Wert. Der Sitz
  // steht vor "Geschaeftsanschrift:", die Anschrift dahinter (ggf. umgebrochen).
  let sitz = "";
  let anschrift = "";
  for (const e of eintraege) {
    const b = e.zellen.firma?.b ?? [];
    let inAnschrift = false;
    const teile: string[] = [];
    for (const z of b) {
      if (/^Gesch[äa]ftsanschrift\s*:/i.test(z)) {
        inAnschrift = true;
        const rest = z.replace(/^Gesch[äa]ftsanschrift\s*:\s*/i, "");
        if (rest) teile.push(rest);
        continue;
      }
      if (/^(Zweigniederlassung|Empfangsberechtigte|Niederlassung|Inl[äa]ndische)/i.test(z)) {
        inAnschrift = false;
        continue;
      }
      if (inAnschrift) teile.push(z);
      else if (!/\d{5}\s+\S/.test(z)) sitz = z;
    }
    if (teile.length) anschrift = teile.join(" ").replace(/\s+/g, " ").trim();
  }
  // Zusaetze zwischen Hausnummer und PLZ ("…, Souterrain Seitenfl. rechts, 14199 Berlin") ueberspringen.
  const adr = /^(?<strasse>.+?)\s+(?<nr>\d+[\w\-\/]*)\s*(?:,[^,]*?)*,\s*(?<plz>\d{5})\s+(?<ort>.+)$/.exec(anschrift);
  const plzOrt = !adr ? /(?<plz>\d{5})\s+(?<ort>[^,]+)$/.exec(anschrift) : null;

  // Natuerliche Personen wie im SI (alle Beteiligungen: Organe, Prokuristen,
  // Kommanditisten): alle Eintragungen in Reihenfolge; eine Aktionsueberschrift
  // ("Ausgeschieden als …:", "Bestellt als …:", "… geaendert, nun:") setzt den
  // Modus fuer die folgenden Personenzeilen, Rollenueberschriften nicht.
  const personen = new Map<string, SiGeschaeftsfuehrer>();
  for (const e of eintraege) {
    const zeilenMitPersonen = [
      ...(e.zellen.vertretung?.a ?? []), ...(e.zellen.vertretung?.b ?? []), ...(e.zellen.vertretung?.["-"] ?? []),
      ...(e.zellen.prokura?.["-"] ?? []),
      ...(e.zellen.rechtsform?.c ?? []),
    ];
    let modus: "zu" | "ab" = "zu";
    for (let i = 0; i < zeilenMitPersonen.length; i++) {
      const z = zeilenMitPersonen[i]!;
      if (ABGANG_RE.test(z)) modus = "ab";
      else if (ZUGANG_RE.test(z) || ROLLE_RE.test(z)) modus = "zu";
      const m = PERSON_RE.exec(z);
      if (!m?.groups) {
        // Abgang ohne Geburtsdatum: alle gleichnamigen Personen entfernen.
        const k = modus === "ab" ? PERSON_KURZ_RE.exec(z) : null;
        if (k?.groups) {
          const praefix = `${k.groups.nachname}|${k.groups.vorname}|`.toLowerCase();
          for (const key of [...personen.keys()]) if (key.startsWith(praefix)) personen.delete(key);
        }
        continue;
      }
      const g = m.groups;
      const geb = g.geb ?? g.geb2 ?? "";
      let ort = (g.ort ?? g.ort2 ?? "").trim();
      // Berlin: Ort in der Folgezeile (ein Wort, ohne Komma/Doppelpunkt).
      const folge = zeilenMitPersonen[i + 1];
      if (!ort && folge && /^[A-ZÄÖÜ][^,:*]{1,60}$/.test(folge) && !ABGANG_RE.test(folge) && !ZUGANG_RE.test(folge)) {
        ort = folge.trim();
        i++;
      }
      const key = `${g.nachname}|${g.vorname}|${geb}`.toLowerCase();
      if (modus === "ab") personen.delete(key);
      else personen.set(key, { firstName: kappe(g.vorname!.trim(), 200), lastName: kappe(g.nachname!.trim(), 200), birthDay: isoDatum(geb), city: kappe(ort, 120) || null });
    }
  }

  // Rechtsform: die juengste a)-Zelle, die eine Rechtsform nennt (spaetere Eintraege
  // tragen oft nur Satzungsaenderungen). Erst die bekannte Bezeichnung im Text,
  // sonst die erste Zeile mit Rechtsform-Vokabular.
  let legalForm = "";
  for (let i = eintraege.length - 1; i >= 0 && !legalForm; i--) {
    const zeilen = eintraege[i]!.zellen.rechtsform?.a ?? [];
    const text = zeilen.join(" ").replace(/\s+/g, " ");
    const m = RECHTSFORM_NAME_RE.exec(text);
    if (m) legalForm = m[0].replace(/\s+/g, " ").trim();
    else {
      const z = zeilen.find((x) => LEGAL_FORM_RE.test(x) && !/^(Beginn|Gesellschaftsvertrag|Satzung|Musterprotokoll|Gr[üu]ndung|Errichtet|Die Gesellschafterversammlung)/i.test(x));
      if (z) legalForm = z.replace(/\s+/g, " ").trim();
    }
  }
  let jahr: number | null = null;
  for (const e of eintraege) {
    for (const z of [...(e.zellen.rechtsform?.a ?? []), ...(e.zellen.tag?.b ?? [])]) {
      const m = /(?:Beginn|Gesellschaftsvertrag vom|Satzung vom|Musterprotokoll vom|Gr[üu]ndung|errichtet am|Tag der ersten\s*Eintragung)\s*:?\s*(\d{2}\.\d{2}\.(\d{4}))/i.exec(z) ?? /Eintragung:\s*(\d{2}\.\d{2}\.(\d{4}))/.exec(z);
      if (m && jahr == null) jahr = Number(m[2]);
    }
  }
  if (jahr == null) {
    const erstesDatum = eintraege[0]!.zellen.tag?.a?.find((z) => /\d{2}\.\d{2}\.\d{4}/.test(z));
    const iso = isoDatum(erstesDatum);
    if (iso) jahr = Number(iso.slice(0, 4));
  }
  const letztesDatum = (() => {
    for (let i = eintraege.length - 1; i >= 0; i--) {
      const z = eintraege[i]!.zellen.tag?.a?.find((x) => /\d{2}\.\d{2}\.\d{4}/.test(x));
      if (z) return isoDatum(z);
    }
    return null;
  })();
  const kapitalZeile = (letzte(eintraege, "kapital", "-") ?? []).join(" ");
  const gegenstand = (letzte(eintraege, "firma", "c") ?? []).join(" ").replace(/\s+/g, " ").trim();

  return {
    name: kappe(name, 500),
    legalForm: kappe(legalForm, 200),
    street: kappe(adr?.groups?.strasse?.trim() ?? "", 200),
    houseNumber: kappe(adr?.groups?.nr?.trim() ?? "", 40),
    zipCode: kappe(adr?.groups?.plz ?? plzOrt?.groups?.plz ?? "", 20),
    city: kappe((adr?.groups?.ort ?? plzOrt?.groups?.ort ?? sitz).trim(), 120),
    foundingYear: jahr != null && jahr >= 1000 && jahr <= 2100 ? jahr : null,
    corporatePurpose: gegenstand ? kappe(gegenstand, 20_000) : null,
    shareCapital: kapitalZeile ? betrag(kapitalZeile) : null,
    lastRegisterEntry: letztesDatum,
    lastRegisterModification: letztesDatum,
    managingDirectors: [...personen.values()].slice(0, 200),
  };
}

/** Wie si-parser.namenPassen: gleiche Firma trotz Umlaut-/Rechtsform-Schreibweise. */
function namenPassen(a: string, b: string): boolean {
  const n = (s: string) =>
    s
      .toLowerCase()
      .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const x = n(a);
  const y = n(b);
  if (!x || !y) return false;
  if (x === y || x.includes(y) || y.includes(x)) return true;
  const wx = new Set(x.split(" ").filter((w) => w.length > 2));
  const wy = y.split(" ").filter((w) => w.length > 2);
  const gemeinsam = wy.filter((w) => wx.has(w)).length;
  return gemeinsam >= Math.min(2, wy.length) && gemeinsam / Math.max(1, Math.max(wx.size, wy.length)) >= 0.5;
}

/** Vollstaendiger Weg: Seiten → Eintragungen → Stand. */
export function parseChronologischerAbdruck(seiten: CdSeite[], erwarteterName?: string): StrukturierterInhalt | null {
  if (!seiten.length || !istCdSeite(seiten[0]!)) return null;
  return zustandAus(eintraegeBilden(seiten), erwarteterName);
}
