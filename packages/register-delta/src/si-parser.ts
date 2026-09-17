// Strukturierter Registerinhalt (SI, XJustiz-XML von handelsregister.de) →
// dieselben Felder, die der structured-content-Producer schreibt
// (structured-content/src/infrastructure/webdrivers/structured-content-webdriver.ts,
// parseStructuredContentObject). Die Pfadlogik ist absichtlich identisch
// (erster Treffer je Schluessel in Dokumentreihenfolge), damit Delta und
// Producer dieselben Werte liefern. Ohne native Abhaengigkeit (fast-xml-parser),
// weil das Paket im Betreiber-Worker (Alpine) und in der Desktop-App laeuft.

import { XMLParser } from "fast-xml-parser";

export type SiGeschaeftsfuehrer = {
  firstName: string;
  lastName: string;
  /** ISO-Datum (JJJJ-MM-TT) oder null. */
  birthDay: string | null;
  city: string | null;
};

export type StrukturierterInhalt = {
  name: string;
  legalForm: string;
  street: string;
  houseNumber: string;
  zipCode: string;
  city: string;
  foundingYear: number | null;
  corporatePurpose: string | null;
  shareCapital: number | null;
  /** ISO-Datum oder null. */
  lastRegisterEntry: string | null;
  lastRegisterModification: string | null;
  managingDirectors: SiGeschaeftsfuehrer[];
};

/** Hoechstgroesse einer SI-Datei; echte Auszuege liegen bei 10 bis 200 KB. */
export const SI_MAX_BYTES = 5 * 1024 * 1024;

type Baum = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => name === "tns:beteiligung",
});

/** Sieht der Text nach einem XJustiz-Registerauszug aus? (Magic-Bytes-Ersatz fuer Text.) */
export function istSiXml(text: string): boolean {
  const kopf = text.replace(/^﻿/, "").trimStart().slice(0, 200);
  return kopf.startsWith("<") && /tns:|xjustiz/i.test(text.slice(0, 4000));
}

/**
 * Grober Bauplan eines nicht lesbaren Auszugs: Wurzelelement und die aeusseren
 * Tag-Namen, keine Inhalte. Nur fuer die Fehlersuche im Worker-Protokoll, damit
 * ein unbekannter Aufbau sichtbar wird, ohne Daten zu protokollieren.
 */
export function siBauplan(xml: string): string {
  const tags: string[] = [];
  const re = /<([A-Za-z][\w.:-]*)[\s>]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null && tags.length < 25) {
    if (!tags.includes(m[1])) tags.push(m[1]);
  }
  return tags.join(" ");
}

/** Liefert null, wenn das Dokument kein brauchbarer Auszug ist (kein Firmenname). */
export function parseStrukturierterInhalt(xml: string): StrukturierterInhalt | null {
  if (!istSiXml(xml)) return null;
  let baum: Baum;
  try {
    baum = parser.parse(xml) as Baum;
  } catch {
    return null;
  }
  // Firmendaten zuerst im Basisdaten-Block suchen. Fehlt der Block (bei
  // Personengesellschaften heisst der Zweig anders), im ganzen Dokument suchen,
  // aber nie unterhalb von tns:beteiligung: sonst rutscht der Name eines
  // Gesellschafters als Firmenname durch.
  const basis = suche(baum, "tns:basisdatenRegister");
  const firma = istObjekt(basis) && suche(basis, "tns:bezeichnung.aktuell") !== undefined ? basis : baum;
  const name = text(suche(firma, "tns:bezeichnung.aktuell"));
  if (!name) return null;

  const managingDirectors: SiGeschaeftsfuehrer[] = [];
  const beteiligungen = suche(baum, "tns:beteiligung");
  for (const b of Array.isArray(beteiligungen) ? beteiligungen : beteiligungen ? [beteiligungen] : []) {
    if (!istObjekt(b)) continue;
    const person = suche(b, "tns:natuerlichePerson");
    if (!istObjekt(person)) continue;
    const lastName = text(suche(person, "tns:nachname"));
    if (!lastName) continue;
    managingDirectors.push({
      firstName: text(suche(person, "tns:vorname")),
      lastName,
      birthDay: isoDatum(text(suche(person, "tns:geburtsdatum"))),
      city: text(suche(person, "tns:ort")) || null,
    });
  }

  const kapital = Number.parseFloat(text(suche(baum, "tns:zahl")));
  const gruendung = text(objektFeld(suche(baum, "tns:gruendungsmetadaten"), "tns:gruendungsdatum"));
  const ersteSatzung = text(objektFeld(suche(baum, "tns:ersteSatzung"), "tns:satzungsdatum"));
  const letzteAenderung = text(objektFeld(suche(baum, "tns:letzteAenderung"), "tns:aenderungsdatum"));
  const jahrQuelle = gruendung || ersteSatzung || letzteAenderung;
  const jahr = jahrQuelle ? Number.parseInt(jahrQuelle.slice(0, 4), 10) : Number.NaN;

  const gegenstand = text(objektFeld(basis, "tns:gegenstand"));

  return {
    name,
    legalForm: rechtsform(firma, xml),
    street: text(suche(firma, "tns:strasse")),
    houseNumber: text(suche(firma, "tns:hausnummer")),
    zipCode: text(suche(firma, "tns:postleitzahl")),
    city: text(suche(firma, "tns:ort")),
    foundingYear: Number.isFinite(jahr) && jahr > 1000 ? jahr : null,
    corporatePurpose: gegenstand || null,
    shareCapital: Number.isFinite(kapital) ? kapital : null,
    lastRegisterEntry: isoDatum(text(suche(baum, "tns:letzteEintragung"))),
    lastRegisterModification: isoDatum(text(suche(baum, "tns:aenderungsdatum"))),
    managingDirectors,
  };
}

/** Rechtsform: Der lesbare Name steht nur als XML-Kommentar vor dem Code. */
function rechtsform(baum: Baum, xml: string): string {
  const knoten = suche(baum, "tns:rechtsform");
  const code = istObjekt(knoten) ? text(knoten.code) : text(knoten);
  if (!code) return "";
  const re = /<tns:rechtsform\b[^>]*>\s*<!--([^]*?)-->\s*<code>([^<]+)<\/code>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[2].trim() === code) return m[1].trim();
  }
  const bekannt: Record<string, string> = {
    "112100": "Kommanditgesellschaft (KG)",
    "113100": "Offene Handelsgesellschaft (OHG)",
    "221110": "Gesellschaft mit beschränkter Haftung (GmbH)",
    "222110": "Aktiengesellschaft (AG)",
  };
  return bekannt[code] ?? code;
}

function istObjekt(v: unknown): v is Baum {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objektFeld(v: unknown, key: string): unknown {
  return istObjekt(v) ? v[key] : undefined;
}

function text(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return String(v);
  return "";
}

function isoDatum(s: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : null;
}

/**
 * Tiefensuche in Dokumentreihenfolge; erster Treffer gewinnt (wie der Producer).
 * Beteiligungen werden uebersprungen: dort stehen die Daten der Gesellschafter,
 * nicht die der Firma. Die Gesellschafter werden getrennt eingelesen.
 */
function suche(knoten: unknown, key: string): unknown {
  if (Array.isArray(knoten)) {
    for (const k of knoten) {
      const r = suche(k, key);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (!istObjekt(knoten)) return undefined;
  if (key in knoten) return knoten[key];
  for (const [k, v] of Object.entries(knoten)) {
    if (typeof v !== "object" || v === null) continue;
    if (k === "tns:beteiligung" && key !== "tns:beteiligung") continue;
    const r = suche(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}
