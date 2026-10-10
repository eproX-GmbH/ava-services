// Welche E-Mail-Domain gehört zur Firma? (Befund 2026-10-10: Bei Strategic IT war
// joyce@quikk.de – Adresse derselben Person bei QUIKK – die einzige Personenadresse.
// domainAus() nahm sie als Firmendomain, und alle Kollegen bekamen vorname@quikk.de.)
//
// Regel:
//   1. Website der Firma → deren registrierbare Domain.
//   2. Sonst Firmenadressen (info@, kontakt@ aus den Firmenfakten) → deren Domain.
//   3. Personenadressen einer abweichenden Domain zählen nur als Alias, wenn
//      mindestens ZWEI verschiedene Personen sie tragen UND die Domain zum
//      Firmennamen passt oder das KI-Urteil sie der Firma zuordnet. Eine einzelne
//      fremde Adresse ist nie ein Beleg (Personen arbeiten oft für mehrere Firmen).
//   Fehlt beides, gibt es keine Domain und keine Ableitung.

import * as yup from "yup";
import type { Urteil } from "./zuordnung";

const URTEIL_SCHEMA = yup.object({ gehoert: yup.boolean().required(), begruendung: yup.string().max(400).default("") });

const ZWEITE_EBENE = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.at", "or.at", "gv.at", "com.tr", "co.nz", "com.br"]);

/** firma.de aus www.firma.de, mail.firma.de, https://shop.firma.co.uk/ (wie Gateway lib/firmen-domain.ts). */
export function registrierbar(hostOderUrl: string | null | undefined): string | null {
  if (!hostOderUrl) return null;
  let host = hostOderUrl.trim().toLowerCase();
  try {
    if (host.includes("/") || host.includes(":")) host = new URL(host.startsWith("http") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  const teile = host.split(".").filter(Boolean);
  if (teile.length < 2) return null;
  const zwei = teile.slice(-2).join(".");
  return ZWEITE_EBENE.has(zwei) && teile.length >= 3 ? teile.slice(-3).join(".") : zwei;
}

const emailDomain = (e: string) => registrierbar(e.split("@")[1] ?? "");

const RECHTSFORM = /\b(gmbh|mbh|ag|kg|ohg|gbr|ug|se|ltd|limited|llc|inc|co|corp|haftungsbeschränkt|haftungsbeschraenkt|e\.?\s?v|e\.?\s?k|und|&|the|der|die|das)\b/g;

/** Passt die Domain zum Firmennamen? „strategic-it.de“ ↔ „Strategic IT GmbH“, „mueller-bau.de“ ↔ „Müller Bau KG“. */
export function passtZumNamen(domain: string, firmenname: string): boolean {
  const label = domain.split(".")[0]!.replace(/[^a-z0-9]/g, "");
  const name = firmenname
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(RECHTSFORM, " ");
  const woerter = name.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  if (!label || woerter.length === 0) return false;
  const zusammen = woerter.join("");
  if (label === zusammen || (zusammen.startsWith(label) && label.length >= 5) || (label.startsWith(zusammen) && zusammen.length >= 5)) return true;
  // Ein markantes Wort des Namens (mindestens 5 Zeichen) steckt im Label.
  if (woerter.some((w) => w.length >= 5 && label.includes(w))) return true;
  // Anfangsbuchstaben: „ksb.de“ ↔ „Klein Schanzlin Becker“.
  const initialen = woerter.map((w) => w[0]).join("");
  return initialen.length >= 3 && label === initialen;
}

export interface FirmenDomain {
  domain: string;
  quelle: "website" | "firmenmail" | "alias";
  begruendung: string;
}

/**
 * Die Domain, unter der für diese Firma Adressen abgeleitet werden dürfen; null = keine.
 * `personen`: Adressen je Person (nur personengebundene, keine Funktionsadressen nötig).
 */
export async function firmenDomain(args: {
  firmenname: string;
  websiteUrl: string | null;
  firmenEmails: string[];
  personen: Array<{ personId: string; emails: string[] }>;
  urteil?: Urteil | null;
}): Promise<FirmenDomain | null> {
  const web = registrierbar(args.websiteUrl);
  // Personen je Domain (jede Person nur einmal je Domain).
  const traeger = new Map<string, Set<string>>();
  for (const p of args.personen) for (const e of p.emails) {
    const d = emailDomain(e);
    if (d) traeger.set(d, (traeger.get(d) ?? new Set()).add(p.personId));
  }
  const firmenmail = args.firmenEmails.map(emailDomain).find((d): d is string => !!d) ?? null;
  const basis = web ?? firmenmail;
  // Hat die Basis-Domain selbst Personenbelege (oder es gibt keine Alternative), gilt sie.
  const alias = [...traeger.entries()]
    .filter(([d, s]) => d !== basis && s.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)[0];
  if (basis && (traeger.has(basis) || !alias)) return { domain: basis, quelle: web ? "website" : "firmenmail", begruendung: web ? "Website der Firma" : "Firmenadresse" };
  if (!alias) return null;
  const [kandidat, menge] = alias;
  if (passtZumNamen(kandidat, args.firmenname)) return { domain: kandidat, quelle: "alias", begruendung: `${menge.size} Personen mit @${kandidat}, passt zum Firmennamen` };
  if (!args.urteil) return basis ? { domain: basis, quelle: web ? "website" : "firmenmail", begruendung: "Website der Firma" } : null;
  const ja = await domainUrteil(args.urteil, { firmenname: args.firmenname, website: web, kandidat, personen: menge.size });
  if (ja) return { domain: kandidat, quelle: "alias", begruendung: `${menge.size} Personen mit @${kandidat}, KI-Urteil: ${ja}` };
  return basis ? { domain: basis, quelle: web ? "website" : "firmenmail", begruendung: "Website der Firma" } : null;
}

/** KI-Urteil: Ist die Domain eine Mail-Domain dieser Firma? Liefert die Begründung bei „ja“, sonst null. */
async function domainUrteil(urteil: Urteil, a: { firmenname: string; website: string | null; kandidat: string; personen: number }): Promise<string | null> {
  const system =
    "Du prüfst, ob eine E-Mail-Domain zu einer Firma gehört. Personen arbeiten oft für mehrere Firmen (Beteiligungen, Schwesterfirmen, frühere Arbeitgeber); " +
    "eine Domain gehört nur dann zur Firma, wenn die Firma selbst sie für ihre Mitarbeiter nutzt (eigene Marke, Konzern- oder Gruppendomain, früherer Firmenname). " +
    'Im Zweifel nein. Antworte nur mit JSON: {"gehoert": true|false, "begruendung": "ein Satz"}.';
  const user = `Firma: ${a.firmenname}\nWebsite: ${a.website ?? "unbekannt"}\nDomain: ${a.kandidat}\nPersonen dieser Firma mit Adresse an der Domain: ${a.personen}`;
  try {
    const text = await urteil(system, user);
    const m = text?.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = URTEIL_SCHEMA.validateSync(JSON.parse(m[0]));
    return j.gehoert ? (j.begruendung || "gehört zur Firma").slice(0, 200) : null;
  } catch {
    return null;
  }
}
