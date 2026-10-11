// Stufe 2 (docs/PLAN_EMAIL_MUSTER_2.md, E1/E2): Firmenadressen Personen
// zuordnen und das Adressmuster per Urteil bestimmen, wo der Katalog nicht
// reicht. Electron-frei; der LLM-Aufruf kommt als Funktion herein.
//
// Zwei Stufen je Firma:
//   1. deterministisch: Lokalteil enthaelt Vor- oder Nachname GENAU EINER
//      Person (Normalform wie nameVarianten) → Treffer, ohne Modell.
//   2. Urteil (LLM) fuer den Rest: Person, Funktion oder unklar. Nie
//      zuordnen, wenn zwei Personen in Frage kommen; ein Urteil ohne
//      Namensanklang im Lokalteil wird verworfen.
//
// Der Muster-Judge wird nur gefragt, wenn der Katalog kein Muster findet
// oder ein einzelner Beleg mehrere Muster zulaesst. Eine vorgeschlagene
// Vorlage gilt nur, wenn sie ALLE Belege reproduziert.

import * as yup from "yup";
import { MUSTER, bildeAdresse, istFunktionsadresse, nameVarianten, type MusterBeleg } from "./pattern";

export type Urteil = (system: string, user: string) => Promise<string | null>;

export interface PersonKurz {
  personId: string;
  fullName: string;
  title?: string | null;
}

export interface Zuordnung {
  email: string;
  personId: string;
  fullName: string;
  /** deterministisch = Name im Lokalteil, judge = Modell-Urteil. */
  wie: "deterministisch" | "judge";
  begruendung: string;
}

function lokal(email: string): string {
  return (email.split("@")[0] ?? "").toLowerCase().trim();
}

function nurAlnum(s: string): string {
  return s.replace(/[^a-z0-9]/g, "");
}

/** Namensteile einer Person als Lokalteil-Bausteine (ab 3 Zeichen). */
function namensteile(fullName: string): string[] {
  const out = new Set<string>();
  for (const n of nameVarianten(fullName)) {
    for (const t of [n.vorname, n.nachname, n.nachnameKurz, ...n.vornamen]) {
      const x = nurAlnum(t);
      if (x.length >= 3) out.add(x);
    }
  }
  return [...out];
}

/**
 * Deterministische Zuordnung: Welche Personen passen zum Lokalteil? Treffer
 * nur bei genau EINER Person. Funktionsadressen sind nie Personen.
 */
export function ordneDeterministisch(email: string, personen: PersonKurz[]): { personId: string; fullName: string; begruendung: string } | "mehrdeutig" | null {
  if (istFunktionsadresse(email)) return null;
  const l = nurAlnum(lokal(email));
  if (l.length < 3) return null;
  const treffer: Array<{ p: PersonKurz; grund: string }> = [];
  for (const p of personen) {
    const teile = namensteile(p.fullName);
    const voll = teile.find((t) => t === l);
    const enthalten = teile.find((t) => t.length >= 4 && l.includes(t));
    const initial = nameVarianten(p.fullName).some((n) =>
      [`${n.vorname.charAt(0)}${n.nachname}`, `${n.vorname}${n.nachname.charAt(0)}`, `${n.nachname}${n.vorname.charAt(0)}`].some((k) => nurAlnum(k) === l),
    );
    if (voll) treffer.push({ p, grund: `Lokalteil ist „${voll}“` });
    else if (initial) treffer.push({ p, grund: "Initial plus Name" });
    else if (enthalten) treffer.push({ p, grund: `Lokalteil enthaelt „${enthalten}“` });
  }
  if (treffer.length === 1) return { personId: treffer[0]!.p.personId, fullName: treffer[0]!.p.fullName, begruendung: treffer[0]!.grund };
  if (treffer.length > 1) return "mehrdeutig";
  return null;
}

const zuordnungYup = yup
  .array()
  .of(
    yup
      .object({
        email: yup.string().trim().required(),
        art: yup.string().oneOf(["person", "funktion", "unklar"]).required(),
        personId: yup.string().trim().nullable().default(null),
        begruendung: yup.string().trim().max(200).default(""),
      })
      .noUnknown(true),
  )
  .required();

function jsonArrayAus(text: string): unknown {
  const t = text.trim();
  const start = t.indexOf("[");
  const end = t.lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Firmenadressen den Personen zuordnen. Erst deterministisch, dann das
 * Modell fuer den Rest (ein Aufruf). Ohne Modell nur Stufe 1.
 */
export async function ordneFirmenadressen(args: {
  firmenEmails: string[];
  personen: PersonKurz[];
  firmenname: string;
  urteil?: Urteil | null;
}): Promise<{ zuordnungen: Zuordnung[]; funktion: string[]; unklar: string[] }> {
  const zuordnungen: Zuordnung[] = [];
  const funktion: string[] = [];
  const unklar: string[] = [];
  const offen: string[] = [];
  const vergeben = new Set<string>();
  for (const email of [...new Set(args.firmenEmails.map((e) => e.toLowerCase().trim()))]) {
    if (istFunktionsadresse(email)) {
      funktion.push(email);
      continue;
    }
    const d = ordneDeterministisch(email, args.personen);
    if (d === "mehrdeutig") {
      unklar.push(email);
      continue;
    }
    if (d && !vergeben.has(d.personId)) {
      vergeben.add(d.personId);
      zuordnungen.push({ email, personId: d.personId, fullName: d.fullName, wie: "deterministisch", begruendung: d.begruendung });
      continue;
    }
    offen.push(email);
  }
  if (offen.length === 0 || !args.urteil || args.personen.length === 0) {
    return { zuordnungen, funktion, unklar: [...unklar, ...offen] };
  }
  const personenText = args.personen.map((p) => `- ${p.personId}: ${p.fullName}${p.title ? ` (${p.title})` : ""}`).join("\n");
  const system = [
    "Du ordnest E-Mail-Adressen einer Firma den bekannten Personen zu oder erkennst sie als Funktionsadresse.",
    "Regeln:",
    '- art "person" NUR, wenn Vor- oder Nachname (oder Initial plus Name) genau einer Person im Lokalteil erkennbar ist.',
    '- Kommen zwei Personen in Frage (gleicher Nachname, gleicher Vorname): art "unklar".',
    '- Rollen- und Abteilungsadressen (info, rechnung, buchhaltung, vertrieb, team, standort, support, bewerbung …) sind "funktion" — auch wenn ein Wort wie ein Name aussieht (z. B. "martin@" bei der Firma "Martin GmbH").',
    "- Erfinde keine Personen. personId nur aus der Liste.",
    'Antworte NUR mit einem JSON-Array: [{"email": string, "art": "person"|"funktion"|"unklar", "personId": string|null, "begruendung": string}]',
  ].join("\n");
  const user = [`Firma: ${args.firmenname}`, "", "Personen:", personenText, "", "Adressen:", offen.map((e) => `- ${e}`).join("\n")].join("\n");
  try {
    const text = await args.urteil(system, user);
    const roh = text ? jsonArrayAus(text) : null;
    const parsed = roh ? ((await zuordnungYup.validate(roh, { stripUnknown: true })) as Array<{ email: string; art: string; personId: string | null; begruendung: string }>) : null;
    for (const email of offen) {
      const u = parsed?.find((x) => x.email.toLowerCase() === email);
      const p = u?.art === "person" && u.personId ? args.personen.find((x) => x.personId === u.personId) : undefined;
      if (p && !vergeben.has(p.personId)) {
        // Sicherung: der Name muss im Lokalteil wenigstens anklingen (3 Zeichen), sonst war das Urteil geraten.
        const l = nurAlnum(lokal(email));
        const plausibel = namensteile(p.fullName).some((t) => l.includes(t.slice(0, 3)));
        if (!plausibel) {
          unklar.push(email);
          continue;
        }
        vergeben.add(p.personId);
        zuordnungen.push({ email, personId: p.personId, fullName: p.fullName, wie: "judge", begruendung: u!.begruendung || "KI-Urteil" });
      } else if (u?.art === "funktion") {
        funktion.push(email);
      } else {
        unklar.push(email);
      }
    }
  } catch {
    unklar.push(...offen);
  }
  return { zuordnungen, funktion, unklar };
}

// ---- Muster-Judge (E2) ------------------------------------------------------

const musterYup = yup
  .object({
    muster: yup.string().trim().required(),
    baseline: yup.string().trim().required(),
    begruendung: yup.string().trim().max(200).default(""),
  })
  .noUnknown(true);

/** Vorlage mit {vorname} {nachname} {v} {n} in einen Lokalteil uebersetzen. */
export function vorlageAnwenden(vorlage: string, fullName: string): string | null {
  const n = nameVarianten(fullName)[0];
  if (!n) return null;
  const local = vorlage
    .toLowerCase()
    .replace(/\{vorname\}/g, n.vorname)
    .replace(/\{nachname\}/g, n.nachname)
    .replace(/\{v\}/g, n.vorname.charAt(0))
    .replace(/\{n\}/g, n.nachname.charAt(0));
  if (/[{}]/.test(local) || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return null;
  return local;
}

export interface MusterUrteil {
  /** Katalog-Id oder Vorlage ("{v}{nachname}"). */
  muster: string;
  baseline: string;
  begruendung: string;
}

/**
 * Muster per Urteil, wenn der Katalog nicht reicht. Angenommen wird nur, was
 * alle personengebundenen Belege reproduziert.
 */
export async function beurteileMuster(args: { domain: string; belege: MusterBeleg[]; alternativen: string[]; urteil: Urteil }): Promise<MusterUrteil | null> {
  if (args.belege.length === 0) return null;
  const system = [
    "Du bestimmst das E-Mail-Adressmuster einer Firma aus belegten Adressen bekannter Personen.",
    `Katalog-Ids: ${MUSTER.map((m) => m.id).join(", ")}. Passt keine, gib eine Vorlage mit den Platzhaltern {vorname} {nachname} {v} {n} an (v/n = Initialen), z. B. "{v}{nachname}" oder "{vorname}.{n}".`,
    "Waehle das Muster, das ALLE Belege erklaert. baseline = der Beleg, der das Muster am klarsten zeigt.",
    'Antworte NUR mit einem JSON-Objekt: {"muster": string, "baseline": string, "begruendung": string}',
  ].join("\n");
  const user = [
    `Domain: ${args.domain}`,
    args.alternativen.length > 0 ? `Katalog-Kandidaten: ${args.alternativen.join(", ")}` : "",
    "Belege:",
    ...args.belege.map((b) => `- ${b.fullName} → ${b.email}`),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const text = await args.urteil(system, user);
    if (!text) return null;
    const t = text.trim();
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end < start) return null;
    const parsed = (await musterYup.validate(JSON.parse(t.slice(start, end + 1)), { stripUnknown: true })) as { muster: string; baseline: string; begruendung: string };
    const muster = parsed.muster.trim();
    const passt = args.belege.every((b) => {
      const adresse = bildeAdresseAllgemein(muster, b.fullName, args.domain);
      return adresse !== null && adresse === b.email.toLowerCase().trim();
    });
    if (!passt) return null;
    const baseline = args.belege.find((b) => b.email.toLowerCase() === parsed.baseline.toLowerCase())?.email ?? args.belege[0]!.email;
    return { muster, baseline, begruendung: parsed.begruendung };
  } catch {
    return null;
  }
}

/** Adresse nach Katalog-Id ODER Vorlage bilden. */
export function bildeAdresseAllgemein(muster: string, fullName: string, domain: string): string | null {
  if (MUSTER.some((m) => m.id === muster)) return bildeAdresse(muster, fullName, domain);
  const local = vorlageAnwenden(muster, fullName);
  return local ? `${local}@${domain.toLowerCase().trim()}` : null;
}
