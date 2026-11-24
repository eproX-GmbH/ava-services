// Echte Aenderung oder nur andere Schreibweise? Gemeinsamer Vergleich fuer Registerwerte
// (ProfileChangeEvent, RegisterSnapshot, Firmen-Ereignisse, Neuigkeiten).
//
// Befund 2026-11-24 (lesende Prod-Probe, 1.303 ProfileChangeEvents, 47.350 Stammdaten):
//   * Kapital: 568 von 583 Ereignissen waren „25000.00 → 25000“. Der Bestand kommt als
//     numeric::text aus der DB, der neue Wert als Zahl vom Producer; verglichen wurde Text.
//     Weil jeder neue Lauf wieder „.00“ liest, kam das Ereignis bei jeder Auffrischung neu.
//   * Altbestand ohne Umlaute und ß: „Gesellschaft mit beschrankter Haftung“ (35.856 Firmen),
//     „Wohlertstrae“ (22.507 Strassen), „Vermogens“ (13.833 Gegenstaende), „Gunter“. Die erste
//     Auffrischung aus dem Register meldete dann Rechtsform, Sitz, Gegenstand und
//     Geschaeftsfuehrung als geaendert.
//   * Schreibvarianten: „(GmbH)“-Zusatz, Rechtsform-Codes („221110“), Mojibake
//     („beschrÃ¤nkter“), Trennstriche aus Zeilenumbruechen („Verwaltungs- und“ →
//     „Verwaltungsund“), abgeschnittene Gegenstaende, Satzreste aus Bekanntmachungen
//     („… GmbH die Konzeptionierung …“, Rechtsform „… mit Sitz in“).
//
// Alles hier ist rein (keine DB): Schreiben (Diff im Persist) und Lesen (Filter auf
// Altbestand in der Tabelle) nutzen dieselben Regeln.

/** UTF-8, das als Latin-1 gelesen wurde, zurueckdrehen: „beschrÃ¤nkter“ → „beschränkter“. */
export function mojibakeReparieren(s: string): string {
  if (!/[ÃÂ][\u0080-¿]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const r = Buffer.from(s, "latin1").toString("utf8");
  return r.includes("�") ? s : r;
}

/** Kleinbuchstaben ohne Akzente; ß, ø & Co. ausgeschrieben. Leerzeichen und Satzzeichen bleiben. */
export function falten(v: unknown): string {
  if (v == null) return "";
  return mojibakeReparieren(String(v))
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/[łđı]/g, (c) => ({ ł: "l", đ: "d", ı: "i" })[c] ?? c);
}

/**
 * Vergleichsschluessel fuer Freitext (Name, Gegenstand, Ort): ohne Akzente, ohne ss/ß
 * (der Altbestand hat ß ersatzlos gestrichen), ae/oe/ue wie a/o/u, nur Buchstaben und
 * Ziffern. Zwei Werte mit gleichem Schluessel sind dieselbe Angabe.
 */
export function schreibweiseSchluessel(v: unknown): string {
  return falten(v)
    .replace(/ss/g, "")
    .replace(/ae/g, "a")
    .replace(/oe/g, "o")
    .replace(/ue/g, "u")
    .replace(/[^a-z0-9]/g, "");
}

/** Zahl aus 25000, "25000.00", "25.000,00 EUR"; null, wenn keine Zahl erkennbar ist. */
export function zahlWert(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let t = String(v).replace(/\s+/g, "").replace(/(€|eur|euro)$/i, "");
  if (!t) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) || /^-?\d+,\d+$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---- Rechtsform ----------------------------------------------------------------

/**
 * XJustiz-Rechtsform-Codes (Codeliste GDS.Rechtsform). Der lesbare Name steht im Auszug nur
 * als Kommentar; fehlt er, landete bisher der Code im Bestand (769 Firmen am 2026-11-24).
 * Zuordnung aus Code, Registerart und Namenszusatz der betroffenen Firmen.
 */
export const RECHTSFORM_LABEL: Readonly<Record<string, string>> = {
  "111100": "Offene Handelsgesellschaft (OHG)",
  "112100": "Kommanditgesellschaft (KG)",
  "113000": "Europäische wirtschaftliche Interessenvereinigung (EWIV)",
  "113100": "Offene Handelsgesellschaft (OHG)",
  "123000": "eingetragene Gesellschaft bürgerlichen Rechts (eGbR)",
  "211000": "eingetragener Verein (e.V.)",
  "213100": "Versicherungsverein auf Gegenseitigkeit (VVaG)",
  "221110": "Gesellschaft mit beschränkter Haftung (GmbH)",
  "222110": "Aktiengesellschaft (AG)",
  "222200": "Europäische Aktiengesellschaft (SE)",
  "223100": "Kommanditgesellschaft auf Aktien (KGaA)",
  "251000": "eingetragene Genossenschaft (eG)",
  "260000": "juristische Person des öffentlichen Rechts",
  "411000": "eingetragener Kaufmann (e.K.)",
  "692310": "Rechtsform ausländischen Rechts",
  "692320": "Rechtsform ausländischen Rechts",
};

const RECHTSFORMEN: ReadonlyArray<[string, RegExp]> = [
  ["gmbh-co-kg", /\b(gmbh|gesellschaft mit beschrankter haftung)\s*(&|und|u\.)\s*co\.?\s*(kg|kommanditgesellschaft)\b/],
  ["kgaa", /kommanditgesellschaft auf aktien|\bkgaa\b/],
  ["ug", /\bunternehmergesellschaft\b|\bug\b/],
  ["gmbh", /gesellschaft mit beschrankter haftung|\bgmbh\b/],
  ["se", /europaische (aktien)?gesellschaft|\bse\b/],
  ["ag", /\baktiengesellschaft\b|\bag\b/],
  ["kg", /\bkommanditgesellschaft\b|\bkg\b/],
  ["ohg", /offene handelsgesellschaft|\bohg\b/],
  ["egbr", /gesellschaft (des )?burgerlichen rechts|\be?gbr\b/],
  ["partg", /partnerschaft/],
  ["eg", /eingetragene genossenschaft|\beg\b/],
  ["vvag", /versicherungsverein/],
  ["ev", /eingetragener verein|\be\.\s?v\b|^verein$/],
  ["ek", /einzelkauf|einzelunternehm|eingetragene[rns]? kauf(mann|frau)|\be\.\s?k(fm|fr)?\b/],
  ["ausl", /auslandisch|\bausl\.|\blimited\b|\bltd\b|\bplc\b|\bllc\b|\binc\b|\bs\.a\.r\.l\b|\bb\.v\b/],
  ["stiftung", /stiftung/],
];

/** Satzreste aus Bekanntmachungen, die der Parser als Rechtsform gelesen hat. */
const KEINE_RECHTSFORM = /mit sitz|amtsgericht|verschmelz|beschlossen|gewinnverwend|rechtstrager|jahresabschluss|ubernahme|schiedsvereinbarung|\bder firma\b|\bvom \d|\bdie\b|object object|"/;

/**
 * Kern einer Rechtsform („gmbh“, „kg“, …): „Gesellschaft mit beschrankter Haftung“,
 * „Gesellschaft mit beschränkter Haftung (GmbH)“ und „221110“ sind alle „gmbh“.
 * null, wenn der Wert keine Rechtsform ist (leer, Satzrest, unbekannter Code).
 */
export function rechtsformKern(v: unknown): string | null {
  const roh = v == null ? "" : String(v).trim();
  if (!roh) return null;
  if (/^\d+$/.test(roh)) return RECHTSFORM_LABEL[roh] ? rechtsformKern(RECHTSFORM_LABEL[roh]) : null;
  const f = falten(roh).replace(/\s+/g, " ");
  if (f.length > 90 || KEINE_RECHTSFORM.test(f)) return null;
  for (const [kern, re] of RECHTSFORMEN) if (re.test(f)) return kern;
  // Seltene, aber lesbare Form („sonstige juristische Person“): Schreibweise ohne Klammerzusatz.
  return `text:${schreibweiseSchluessel(f.replace(/\([^)]{0,60}\)/g, ""))}`;
}

// ---- Adresse ---------------------------------------------------------------------

export interface AdressTeile {
  street?: string | null;
  houseNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
}

/** „Hauptstraße“, „Hauptstrasse“, „Hauptstrae“ (ß verloren) und „Hauptstr.“ sind gleich. */
function strasseSchluessel(street: unknown, houseNumber: unknown): string {
  const t = `${street ?? ""} ${houseNumber ?? ""}`
    .replace(/(s)tra(ß|ss|s)?e\b/gi, "$1tr")
    .replace(/(s)tr\./gi, "$1tr");
  return schreibweiseSchluessel(t);
}

export function adressSchluessel(a: AdressTeile): { strasse: string; plz: string; ort: string } {
  return {
    strasse: strasseSchluessel(a.street, a.houseNumber),
    plz: String(a.zipCode ?? "").replace(/\s+/g, ""),
    ort: schreibweiseSchluessel(a.city),
  };
}

// ---- Feld-Ereignisse (ProfileChangeEvent, kind != managing-directors) ---------------

export type StammdatenArt = "name" | "legal-form" | "address" | "share-capital" | "purpose";

/** Hat sich der Wert wirklich geaendert? Fuer Text-Paare (vorher/nachher, wie gespeichert). */
export function istEchteAenderung(kind: string, vorher: string, nachher: string): boolean {
  const a = (vorher ?? "").trim();
  const n = (nachher ?? "").trim();
  // Leeres Neu ueberschreibt nichts Sinnvolles; leeres Alt ist Erstbefuellung.
  if (!a || !n) return false;
  switch (kind) {
    case "share-capital": {
      const za = zahlWert(a);
      const zn = zahlWert(n);
      if (za != null && zn != null) return za !== zn;
      return schreibweiseSchluessel(a) !== schreibweiseSchluessel(n);
    }
    case "legal-form": {
      const ka = rechtsformKern(a);
      const kn = rechtsformKern(n);
      // Neu ist kein lesbarer Wert (Satzrest) oder Alt war keiner (Code, Satzrest): kein Wechsel.
      if (!ka || !kn) return false;
      return ka !== kn;
    }
    case "address":
      // Gespeichert als „Strasse Nr, PLZ Ort“ (diffStammdaten); hier nur noch als Text da.
      return adressTextGeaendert(a, n);
    case "purpose": {
      const ka = schreibweiseSchluessel(a);
      const kn = schreibweiseSchluessel(n);
      if (ka === kn) return false;
      // Abgeschnittener Gegenstand: der kuerzere ist der Anfang des laengeren.
      const [kurz, lang] = ka.length <= kn.length ? [ka, kn] : [kn, ka];
      return !(kurz.length >= 30 && lang.startsWith(kurz));
    }
    case "name": {
      const ka = schreibweiseSchluessel(a);
      const kn = schreibweiseSchluessel(n);
      if (ka === kn) return false;
      // „Muster GmbH“ → „Muster GmbH die Konzeptionierung …“: Satzrest hinter der Rechtsform.
      if (kn.startsWith(ka) && SATZREST_NACH_RECHTSFORM.test(n) && !SATZREST_NACH_RECHTSFORM.test(a)) return false;
      return true;
    }
    default:
      return schreibweiseSchluessel(a) !== schreibweiseSchluessel(n);
  }
}

const SATZREST_NACH_RECHTSFORM = /(GmbH|mbH|AG|SE|UG|KG|OHG|e\.\s?K\.)\s+(?!&|und\s+Co|u\.\s*Co)[a-zäöüß]{2,}/;

/** Adresse als gespeicherter Text „Strasse Nr, PLZ Ort“ (ProfileChangeEvent.address). */
function adressTextGeaendert(vorher: string, nachher: string): boolean {
  const teile = (t: string): AdressTeile => {
    const i = t.lastIndexOf(",");
    const vorne = i >= 0 ? t.slice(0, i) : "";
    const hinten = (i >= 0 ? t.slice(i + 1) : t).trim();
    const m = /^(\S+)\s+(.*)$/.exec(hinten);
    return { street: vorne, zipCode: m ? m[1] : "", city: m ? m[2] : hinten };
  };
  return adresseGeaendert(teile(vorher), teile(nachher));
}

/** Adressvergleich in Teilen; eine verlorene Strasse bei gleichem Ort ist kein Umzug. */
export function adresseGeaendert(alt: AdressTeile, neu: AdressTeile): boolean {
  const a = adressSchluessel(alt);
  const n = adressSchluessel(neu);
  // Ohne alten Stand ist es Erstbefuellung, kein Umzug.
  if (!a.strasse && !a.plz && !a.ort) return false;
  if (a.strasse === n.strasse && a.plz === n.plz && a.ort === n.ort) return false;
  if (!n.strasse && a.strasse && a.plz === n.plz && a.ort === n.ort) return false;
  if (!n.ort && !n.plz && !n.strasse) return false;
  return true;
}

// ---- Geschaeftsfuehrung ------------------------------------------------------------

export interface PersonName {
  firstName?: string | null;
  lastName?: string | null;
}

const TITEL = new Set(["dr", "prof", "med", "dent", "vet", "dipl", "ing", "kfm", "rer", "nat", "pol", "oec", "phil", "jur", "h", "c", "mba", "msc", "bsc", "llm"]);

/**
 * Personen-Schluessel: Namensteile ohne Akzente/ß und ohne Titel, sortiert. „Günter Klug“,
 * „Gunter Klug“ und „Klug, Günter“ sind dieselbe Person.
 */
export function personSchluessel(p: PersonName): string {
  return falten(`${p.firstName ?? ""} ${p.lastName ?? ""}`)
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !TITEL.has(w))
    .map((w) => w.replace(/ss/g, "").replace(/ae/g, "a").replace(/oe/g, "o").replace(/ue/g, "u"))
    .sort()
    .join(" ");
}

/** Registergericht statt Person („Amtsgericht Hamburg“ als Nachname, 493 Firmen am 2026-11-24). */
export function istKeinePerson(p: PersonName): boolean {
  const n = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
  return !n || /^(amtsgericht|registergericht|landgericht)\b/i.test(n);
}

/**
 * Wer ist wirklich neu, wer wirklich weg? Entfernt Personen, die auf beiden Seiten stehen
 * (nur anders geschrieben), und Eintraege, die keine Person sind.
 */
export function gfDiffBereinigen<T extends PersonName>(added: T[], removed: T[]): { added: T[]; removed: T[] } {
  const a = (added ?? []).filter((p) => !istKeinePerson(p));
  const r = (removed ?? []).filter((p) => !istKeinePerson(p));
  const ak = new Set(a.map(personSchluessel));
  const rk = new Set(r.map(personSchluessel));
  return { added: a.filter((p) => !rk.has(personSchluessel(p))), removed: r.filter((p) => !ak.has(personSchluessel(p))) };
}

// ---- Eingang des Persists bereinigen (2026-11-24) -------------------------------------
//
// Die Producer laufen auf den Rechnern der Nutzer, oft in aelteren Versionen; der
// Register-Delta-Worker liest dieselben Auszuege. Was dort schiefgeht, wird hier vor dem
// Schreiben abgefangen, fuer alle Quellen gleich:
//   * Mojibake („beschrÃ¤nkter“) in Rechtsform, Name, Anschrift und Personen
//   * Rechtsform als Code („221110“) → lesbarer Name
//   * Satzrest als Rechtsform („… mit Sitz in“, „[object Object]“) oder als Namensanhang
//     → der bisherige Wert bleibt
//   * leere Strasse bei gleichem Ort → bisherige Strasse bleibt
//   * Registergericht als Geschaeftsfuehrer („Amtsgericht Hamburg“), doppelte Personen,
//     unmoegliche Geburtstage und Gruendungsjahre

export interface StammdatenEingang {
  name: string;
  legalForm: string;
  street: string;
  houseNumber: string;
  zipCode: string;
  city: string;
  foundingYear?: number | null;
  managingDirectors: Array<{ firstName: string; lastName: string; birthDay?: string | null; city?: string | null; bestelltAm?: string | null }>;
}

export interface StammdatenBestand {
  name?: string | null;
  legalForm?: string | null;
  street?: string | null;
  houseNumber?: string | null;
  zipCode?: string | null;
  city?: string | null;
  foundingYear?: number | null;
}

const lesbar = (v: unknown): string => (v == null ? "" : mojibakeReparieren(String(v)));

/** Liefert den bereinigten Eingang und was korrigiert wurde (fuers Protokoll). */
export function stammdatenEingangBereinigen<T extends StammdatenEingang>(
  eingang: T,
  alt: StammdatenBestand | null = null,
  jetzt: Date = new Date(),
): { wert: T; korrekturen: string[] } {
  const k: string[] = [];
  const r: T = { ...eingang };
  for (const f of ["name", "legalForm", "street", "houseNumber", "city"] as const) {
    const v = lesbar(r[f]);
    if (v !== (r[f] ?? "")) k.push(`${f}: Kodierung`);
    r[f] = v as T[typeof f];
  }

  // Rechtsform: Code → Name, Satzrest → bisheriger Wert.
  const roh = (r.legalForm ?? "").trim();
  const altForm = lesbar(alt?.legalForm).trim();
  const altPlausibel = altForm && !/^\d+$/.test(altForm) && rechtsformKern(altForm) !== null ? altForm : "";
  if (/^\d+$/.test(roh)) {
    if (RECHTSFORM_LABEL[roh]) {
      r.legalForm = RECHTSFORM_LABEL[roh]!;
      k.push("legalForm: Code");
    } else if (altPlausibel) {
      r.legalForm = altPlausibel;
      k.push("legalForm: unbekannter Code, bisheriger Wert");
    }
  } else if (roh && rechtsformKern(roh) === null) {
    r.legalForm = altPlausibel;
    k.push("legalForm: Satzrest verworfen");
  } else if (!roh && altPlausibel) {
    r.legalForm = altPlausibel;
  }

  // Name: leerer Name oder alter Name plus Satzrest → bisheriger Name.
  const altName = lesbar(alt?.name).trim();
  if (altName) {
    const neu = (r.name ?? "").trim();
    if (!neu) r.name = altName;
    else if (schreibweiseSchluessel(neu).startsWith(schreibweiseSchluessel(altName)) && SATZREST_NACH_RECHTSFORM.test(neu) && !SATZREST_NACH_RECHTSFORM.test(altName)) {
      r.name = altName;
      k.push("name: Satzrest verworfen");
    }
  }

  // Anschrift: Strasse verloren, Ort gleich → bisherige Strasse.
  if (alt && !(r.street ?? "").trim() && (alt.street ?? "").trim()) {
    const a = adressSchluessel(alt);
    const n = adressSchluessel(r);
    if (a.plz === n.plz && a.ort === n.ort) {
      r.street = lesbar(alt.street);
      r.houseNumber = lesbar(alt.houseNumber);
      k.push("street: bisherige Strasse");
    }
  }

  // Gruendungsjahr: nur 1700 bis heute.
  const jahrJetzt = jetzt.getUTCFullYear();
  const jahrOk = (j: unknown): j is number => typeof j === "number" && Number.isInteger(j) && j >= 1700 && j <= jahrJetzt;
  if (r.foundingYear != null && !jahrOk(r.foundingYear)) {
    k.push(`foundingYear: ${r.foundingYear} verworfen`);
    r.foundingYear = jahrOk(alt?.foundingYear) ? alt!.foundingYear! : null;
  }

  // Geschaeftsfuehrung: keine Gerichte, keine Doppelten, plausible Geburtstage.
  const gesehen = new Map<string, T["managingDirectors"][number]>();
  for (const roh of r.managingDirectors ?? []) {
    const p = { ...roh, firstName: lesbar(roh.firstName).trim(), lastName: lesbar(roh.lastName).trim(), city: roh.city == null ? roh.city : lesbar(roh.city) };
    if (istKeinePerson(p)) {
      k.push("managingDirectors: Gericht verworfen");
      continue;
    }
    if (p.birthDay) {
      const t = Date.parse(p.birthDay);
      if (!Number.isFinite(t) || t > jetzt.getTime() || t < Date.UTC(1900, 0, 1)) {
        k.push("managingDirectors: Geburtstag verworfen");
        p.birthDay = null;
      }
    }
    const schluessel = personSchluessel(p);
    const da = gesehen.get(schluessel);
    if (da) {
      k.push("managingDirectors: doppelt");
      // Fehlende Angaben aus der Dublette uebernehmen, sonst bleibt der erste Eintrag.
      gesehen.set(schluessel, { ...da, birthDay: da.birthDay ?? p.birthDay ?? null, city: da.city ?? p.city ?? null, bestelltAm: da.bestelltAm ?? p.bestelltAm ?? null });
      continue;
    }
    gesehen.set(schluessel, p);
  }
  r.managingDirectors = [...gesehen.values()] as T["managingDirectors"];
  return { wert: r, korrekturen: [...new Set(k)] };
}
