// Reine Parser fuer die Seiten des Registerportals. Ohne Browser testbar
// (parser.test.ts). Die Selektoren und Regeln stammen aus dem Notebook
// master-data/scripts/de/register_delta.ipynb (7 Testfaelle gegen das Portal).

import { bestandGericht } from "./ids";

export type RegisterStatus = "ACTIVE" | "CLOSED" | "LOESCHUNG_ANGEKUENDIGT";

/** Rohdaten einer Ergebniszeile, wie sie das In-Page-Skript (portal.ts) aus dem DOM zieht. */
export type RohZeile = {
  kopf: string;
  name: string | null;
  sitz: string | null;
  statusTexte: string[];
  /** Alle sichtbaren Textstuecke der Zeile in DOM-Reihenfolge (fuer die Historie). */
  texte: string[];
};

export type Treffer = {
  kopf: string;
  kopfGeparst: boolean;
  bundesland: string;
  gericht: string;
  art: string;
  nummer: number;
  zusatz: string;
  frueher: string;
  name: string;
  sitz: string;
  status: RegisterStatus;
  statusText: string;
  historie: Array<{ name: string; sitz: string; order: number }>;
};

// "<Land> Amtsgericht <Gericht> <Art> <Nummer>[ <Zusatz>][ früher Amtsgericht <Alt>]"
// Dieselbe Nummer kann bei fusionierten Gerichten mehrfach existieren.
export const KOPF_RE =
  /^(?<land>.+?)\s+Amtsgericht\s+(?<gericht>.+?)\s+(?<art>HRA|HRB|GnR|PR|VR|GsR)\s+(?<nummer>\d+)(?:\s+(?<zusatz>[A-ZÄÖÜ]{1,3}))?(?:\s+früher Amtsgericht\s+(?<frueher>.+?))?\s*$/u;

export const SPERR_RE = /zu viele Anfragen|Anfragen pro Stunde|temporär gesperrt|Zugriff.*gesperrt|Too Many Requests|\b429\b/i;

export function normalisiereLeerraum(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function statusAusText(statusTexte: string[]): { status: RegisterStatus; text: string } {
  for (const t of statusTexte) {
    const l = t.toLowerCase();
    if (l === "aktuell") return { status: "ACTIVE", text: t };
    if (l.includes("geschlossen") || l.includes("gelöscht")) return { status: "CLOSED", text: t };
  }
  return { status: "ACTIVE", text: statusTexte[0] ?? "" };
}

/** Historie: nach dem Wort "Historie" folgen Paare "n.) Name" / "n.) Ort". */
export function historieAusTexten(texte: string[]): Array<{ name: string; sitz: string; order: number }> {
  const eintraege = new Map<number, { name: string; sitz: string; order: number }>();
  let inHist = false;
  for (const roh of texte) {
    const t = normalisiereLeerraum(roh);
    if (t === "Historie") {
      inHist = true;
      continue;
    }
    if (!inHist) continue;
    const m = /^(\d+)\.\)\s*(.*)$/.exec(t);
    if (!m) {
      inHist = false;
      continue;
    }
    const order = Number(m[1]);
    const e = eintraege.get(order);
    if (!e) eintraege.set(order, { order, name: m[2], sitz: "" });
    else if (!e.sitz) e.sitz = m[2];
  }
  return [...eintraege.values()].sort((a, b) => a.order - b.order);
}

export function parseZeile(z: RohZeile): Treffer {
  const kopf = normalisiereLeerraum(z.kopf);
  const m = KOPF_RE.exec(kopf);
  const g = m?.groups ?? {};
  const { status, text } = statusAusText(z.statusTexte);
  return {
    kopf,
    kopfGeparst: Boolean(m),
    bundesland: g.land ?? "",
    gericht: g.gericht ? bestandGericht(g.gericht) : "",
    art: g.art ?? "",
    nummer: g.nummer ? Number(g.nummer) : -1,
    zusatz: g.zusatz ?? "",
    frueher: g.frueher ?? "",
    name: normalisiereLeerraum(z.name ?? ""),
    sitz: normalisiereLeerraum(z.sitz ?? ""),
    status,
    statusText: text,
    historie: historieAusTexten(z.texte),
  };
}

export function parseErgebnis(zeilen: RohZeile[]): Treffer[] {
  return zeilen.map(parseZeile);
}

/** Trefferzahl aus "1-3 von 3 Treffer" im Seitentext. */
export function trefferzahl(seitentext: string): number | null {
  const m = /(\d+)-(\d+) von (\d+) Treffer/.exec(seitentext);
  return m ? Number(m[3]) : null;
}

// ---- Registerbekanntmachungen ---------------------------------------------

export type Bekanntmachung = {
  datum: string; // TT.MM.JJJJ
  tagIso: string; // JJJJ-MM-TT
  kategorie: string;
  bundesland: string | null;
  gericht: string | null;
  art: string | null;
  nummer: number | null;
  zusatz: string;
  frueher: string;
  firma: string;
  sitz: string;
  kopf: string;
  geparst: boolean;
};

export const BEKANNTMACHUNG_KATEGORIEN = new Set([
  "Löschungsankündigung",
  "Registerbekanntmachung nach dem Umwandlungsgesetz",
  "Einreichung neuer Dokumente",
  "Sonstige Registerbekanntmachung",
  "Sonderregisterbekanntmachung OHNE Bezug zum elektr. Register",
]);

function tagIsoAus(datum: string): string {
  const [t, m, j] = datum.split(".");
  return `${j}-${m}-${t}`;
}

/**
 * Seitentext der Bekanntmachungsseite (Zeilen) → Eintraege. Aufbau je Eintrag:
 * Datumzeile (einmal je Tag), dann Kategorie, Kopfzeile, "Firma – Sitz".
 * Vor dem ersten Datum und am Seitenende stehen die Filter-Optionen
 * (Kategoriewoerter ohne Datum) — die werden ausgelassen.
 */
export function parseBekanntmachungen(seitentext: string): Bekanntmachung[] {
  const zeilen = seitentext
    .split("\n")
    .map(normalisiereLeerraum)
    .filter((z) => z.length > 0);
  const eintraege: Bekanntmachung[] = [];
  let datum: string | null = null;
  for (let i = 0; i < zeilen.length; i++) {
    const z = zeilen[i];
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(z)) {
      datum = z;
      continue;
    }
    if (!BEKANNTMACHUNG_KATEGORIEN.has(z) || datum === null || i + 2 >= zeilen.length) continue;
    const kopf = zeilen[i + 1];
    if (BEKANNTMACHUNG_KATEGORIEN.has(kopf) || kopf.startsWith("Bitte warten")) continue;
    const m = KOPF_RE.exec(kopf);
    const g = m?.groups ?? {};
    const [firma, , sitz] = teile(zeilen[i + 2]);
    eintraege.push({
      datum,
      tagIso: tagIsoAus(datum),
      kategorie: z,
      bundesland: g.land ?? null,
      gericht: g.gericht ? bestandGericht(g.gericht) : null,
      art: g.art ?? null,
      nummer: g.nummer ? Number(g.nummer) : null,
      zusatz: g.zusatz ?? "",
      frueher: g.frueher ?? "",
      firma: firma.trim(),
      sitz: sitz.trim(),
      kopf,
      geparst: Boolean(m),
    });
    i += 2;
  }
  return eintraege;
}

function teile(s: string): [string, string, string] {
  const idx = s.indexOf(" – ");
  if (idx < 0) return [s, "", ""];
  return [s.slice(0, idx), " – ", s.slice(idx + 3)];
}
