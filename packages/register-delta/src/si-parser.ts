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

/**
 * Liefert null, wenn das Dokument kein brauchbarer Auszug ist.
 *
 * `erwarteterName` ist der Firmenname aus der Trefferzeile des Registerportals.
 * Er dient als Schutz: Steht der Rechtstraeger im Auszug nur als Beteiligung,
 * laesst sich der Firmenname nicht sicher von dem einer Gesellschafterin
 * unterscheiden. Nur wenn der gelesene Name zum erwarteten passt, wird der
 * Auszug uebernommen; sonst lieber keine Daten als falsche.
 */
export function parseStrukturierterInhalt(xml: string, erwarteterName?: string): StrukturierterInhalt | null {
  if (!istSiXml(xml)) return null;
  let baum: Baum;
  try {
    baum = parser.parse(xml) as Baum;
  } catch {
    return null;
  }
  // Den Firmennamen in fester Reihenfolge suchen. XJustiz kennt mehrere
  // Bauarten: mal steht der Rechtstraeger in den Basisdaten, mal ist er selbst
  // eine Beteiligung mit eigener Rolle. Eine natuerliche Person ist nie die
  // Firma: sonst landet der Name eines Gesellschafters als Firmenname im
  // Bestand. Deshalb wird nur ueber Organisationen ausgewichen.
  const basis = suche(baum, "tns:basisdatenRegister");
  const kandidaten: unknown[] = [
    istObjekt(basis) ? basis : undefined,
    suche(baum, "tns:rechtstraeger"),
    // Nur mit erwartetem Namen, weil dieser Zweig auch eine Gesellschafterin
    // sein kann; der Abgleich unten entscheidet.
    erwarteterName ? organisationsZweig(baum) : undefined,
  ];
  let firma: unknown = undefined;
  let name = "";
  for (const k of kandidaten) {
    if (k === undefined) continue;
    const n = text(suche(k, "tns:bezeichnung.aktuell"));
    if (n) {
      firma = k;
      name = n;
      break;
    }
  }
  if (!name) return null;
  if (erwarteterName && !namenPassen(name, erwarteterName)) return null;

  const managingDirectors: SiGeschaeftsfuehrer[] = [];
  const beteiligungen = suche(baum, "tns:beteiligung");
  for (const b of Array.isArray(beteiligungen) ? beteiligungen : beteiligungen ? [beteiligungen] : []) {
    if (!istObjekt(b)) continue;
    const person = suche(b, "tns:natuerlichePerson");
    if (!istObjekt(person)) continue;
    const lastName = text(suche(person, "tns:nachname"));
    if (!lastName) continue;
    managingDirectors.push({
      firstName: kappe(text(suche(person, "tns:vorname")), 200),
      lastName: kappe(lastName, 200),
      birthDay: isoDatum(text(suche(person, "tns:geburtsdatum"))),
      city: kappe(text(suche(person, "tns:ort")), 120) || null,
    });
  }

  const kapital = Number.parseFloat(text(suche(baum, "tns:zahl")));
  const gruendung = text(objektFeld(suche(baum, "tns:gruendungsmetadaten"), "tns:gruendungsdatum"));
  const ersteSatzung = text(objektFeld(suche(baum, "tns:ersteSatzung"), "tns:satzungsdatum"));
  const letzteAenderung = text(objektFeld(suche(baum, "tns:letzteAenderung"), "tns:aenderungsdatum"));
  const jahrQuelle = gruendung || ersteSatzung || letzteAenderung;
  const jahr = jahrQuelle ? Number.parseInt(jahrQuelle.slice(0, 4), 10) : Number.NaN;

  const gegenstand = text(objektFeld(basis, "tns:gegenstand"));

  // Werte auf die Grenzen bringen, die das Gateway annimmt. Ein einzelner
  // Ausreisser darf die Meldung des ganzen Jobs nicht ungueltig machen:
  // Registerauszuege enthalten vereinzelt unsinnige Jahreszahlen (im Bestand
  // fanden sich 219 und 2209) und sehr lange Texte.
  const jahrGueltig = Number.isFinite(jahr) && jahr >= 1000 && jahr <= 2100 ? jahr : null;
  return {
    name: kappe(name, 500),
    legalForm: kappe(rechtsform(istObjekt(firma) ? firma : baum, xml), 200),
    // Anschrift und Rechtsform stehen je nach Bauart neben dem Namen oder
    // weiter oben; deshalb erst im gefundenen Zweig, dann im ganzen Dokument.
    street: kappe(text(suche(firma, "tns:strasse")) || text(suche(baum, "tns:strasse")), 200),
    houseNumber: kappe(text(suche(firma, "tns:hausnummer")) || text(suche(baum, "tns:hausnummer")), 40),
    zipCode: kappe(text(suche(firma, "tns:postleitzahl")) || text(suche(baum, "tns:postleitzahl")), 20),
    city: kappe(text(suche(firma, "tns:ort")) || text(suche(baum, "tns:ort")), 120),
    foundingYear: jahrGueltig,
    corporatePurpose: gegenstand ? kappe(gegenstand, 20_000) : null,
    shareCapital: Number.isFinite(kapital) && kapital >= 0 ? kapital : null,
    lastRegisterEntry: isoDatum(text(suche(baum, "tns:letzteEintragung"))),
    lastRegisterModification: isoDatum(text(suche(baum, "tns:aenderungsdatum"))),
    managingDirectors: managingDirectors.slice(0, 200),
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

/**
 * Passt der gelesene Firmenname zum Namen aus der Trefferzeile? Tolerant
 * gegenueber Rechtsform-Schreibweisen und Zusaetzen: verglichen wird der
 * Namenskern ohne Satzzeichen und Rechtsformkuerzel.
 */
export function namenPassen(gelesen: string, erwartet: string): boolean {
  const kern = (s: string) =>
    s
      .toLowerCase()
      .replace(/[äöüß]/g, (z) => ({ "ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss" })[z] ?? z)
      .replace(/\b(gmbh|ug|ag|kg|ohg|mbh|co|haftungsbeschraenkt|haftungsbeschrankt|e\.?\s?k|se|kgaa|gbr|eg)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const a = kern(gelesen);
  const b = kern(erwartet);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  // Wortmengen-Vergleich: mindestens zwei Drittel der Woerter des kuerzeren
  // Namens muessen im laengeren vorkommen (Zusaetze wie Standortangaben).
  const wa = new Set(a.split(" ").filter(Boolean));
  const wb = new Set(b.split(" ").filter(Boolean));
  const [klein, gross] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (klein.size === 0) return false;
  let treffer = 0;
  for (const w of klein) if (gross.has(w)) treffer++;
  return treffer / klein.size >= 2 / 3;
}

/**
 * Erste Beteiligung, die eine Organisation ist. In manchen Auszuegen ist der
 * Rechtstraeger selbst als Beteiligung modelliert; natuerliche Personen werden
 * dabei uebergangen, damit nie ein Personenname als Firmenname durchgeht.
 */
function organisationsZweig(baum: Baum): unknown {
  const roh = suche(baum, "tns:beteiligung");
  const liste = Array.isArray(roh) ? roh : roh ? [roh] : [];
  for (const b of liste) {
    if (!istObjekt(b)) continue;
    if (suche(b, "tns:natuerlichePerson") !== undefined) continue;
    const org = suche(b, "tns:organisation");
    if (istObjekt(org) && suche(org, "tns:bezeichnung.aktuell") !== undefined) return org;
  }
  return undefined;
}

function istObjekt(v: unknown): v is Baum {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objektFeld(v: unknown, key: string): unknown {
  return istObjekt(v) ? v[key] : undefined;
}

/** Auf die vom Gateway erlaubte Laenge kuerzen. */
function kappe(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
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
