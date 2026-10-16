// ICP (Idealkundenprofil) fuer einen Vorabanalyse-Lauf: Schema wie in der App,
// Assistent ueber die Betreiber-Spur (Website des Kunden oder Dokument/Freitext).

import { z } from "zod";
import { betreiberJson } from "../betreiber-llm";
import { websiteLesen } from "./crawl";

const liste = (max: number, len: number) => z.array(z.string().max(len)).max(max).default([]);

export const IcpSchema = z.object({
  beschreibung: z.string().max(2000).default(""),
  angebot: z.string().max(600).default(""),
  nutzen: z.string().max(600).default(""),
  branchen: liste(12, 80),
  orte: liste(12, 80),
  radiusKm: z.number().int().min(0).max(2000).default(50),
  groesse: z.string().max(200).default(""),
  merkmale: liste(12, 160),
  ausschluesse: z.string().max(800).default(""),
  kundenBeispiele: z.array(z.object({ domain: z.string().max(200), name: z.string().max(200).optional(), ort: z.string().max(100).optional() })).max(10).default([]),
  quelle: z.enum(["assistent", "manuell", "dokument"]).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
});
export type Icp = z.infer<typeof IcpSchema>;

const importSchema = z.object({
  beschreibung: z.string().default(""),
  angebot: z.string().default(""),
  nutzen: z.string().default(""),
  branchen: z.array(z.string()).default([]),
  orte: z.array(z.string()).default([]),
  radiusKm: z.number().optional().nullable(),
  groesse: z.string().default(""),
  merkmale: z.array(z.string()).default([]),
  ausschluesse: z.string().default(""),
  kundenBeispiele: z.array(z.string()).default([]),
  fehlend: z.array(z.string()).default([]),
});

const notizenSchema = z.object({ notizen: z.array(z.string()).default([]) });

const FORMULAR_SYSTEM =
  "Du uebertraegst ein bestehendes Idealkundenprofil (ICP) eines B2B-Anbieters in ein festes Formular. " +
  "Uebernimm NUR, was der Text belegt; fehlt etwas, lass das Feld leer und nenne es in \"fehlend\". Keine Vermutungen, keine Personennamen. Felder:\n" +
  "- angebot: 1-2 Saetze, was der Anbieter anbietet.\n- nutzen: welches Problem er loest / Nutzenversprechen.\n- branchen: 2-8 uebergeordnete Zielbranchen.\n" +
  "- orte: Heimat- oder Zielregionen als Ortsnamen (z. B. \"Hannover\", \"Wien (AT)\"); leer, wenn nur Laender oder nichts genannt.\n- radiusKm: Umkreis in km, nur wenn der Text einen nennt.\n" +
  "- groesse: Groessenband idealer Kunden (Mitarbeiter, Umsatz, Standorte) als Freitext.\n- merkmale: bis zu 10 verallgemeinerte Eigenschaften idealer Kunden (Situation, Signale, Technik, Struktur).\n" +
  "- ausschluesse: wer explizit NICHT passt, als Freitext.\n- kundenBeispiele: bis zu 5 genannte Beispiel- oder Referenzkunden als Website-Domain, wenn eine im Text steht, sonst Firmenname.\n" +
  "- beschreibung: 3-6 Saetze in Du-Form aus Sicht des Anbieters (\"Deine idealen Kunden sind ...\"), konkret, als Verdichtung des ganzen Textes, ohne Marketing-Floskeln.\n" +
  'Antworte NUR als JSON: {"beschreibung": "...", "angebot": "...", "nutzen": "...", "branchen": [], "orte": [], "radiusKm": 50, "groesse": "...", "merkmale": [], "ausschluesse": "...", "kundenBeispiele": [], "fehlend": []}';

const WEBSITE_SYSTEM =
  "Du analysierst die eigene Website eines B2B-Anbieters und leitest daraus ein erstes Idealkundenprofil (ICP) ab. " +
  "Extrahiere NUR, was der Text belegt (Angebot, Nutzen, genannte Zielbranchen, Referenzkunden, Standort), keine Personennamen. " +
  "Zielgruppenmerkmale und Groesse nur, wenn die Website sie nennt oder klar nahelegt; sonst leer und in \"fehlend\" nennen. " +
  "Felder wie im Formular: beschreibung (3-6 Saetze in Du-Form: \"Deine idealen Kunden sind ...\"), angebot, nutzen, branchen, orte (Firmensitz), radiusKm (50, falls unbekannt), groesse, merkmale, ausschluesse (leer), kundenBeispiele (Domains oder Namen genannter Referenzen), fehlend. " +
  'Antworte NUR als JSON: {"beschreibung": "...", "angebot": "...", "nutzen": "...", "branchen": [], "orte": [], "radiusKm": 50, "groesse": "...", "merkmale": [], "ausschluesse": "", "kundenBeispiele": [], "fehlend": []}';

const ABSCHNITT = 12_000;
const DIREKT_BIS = 24_000;
const MAX_ABSCHNITTE = 12;

function abschnitte(text: string): string[] {
  const t = text.replace(/\r/g, "");
  if (t.length <= ABSCHNITT) return [t];
  const aus: string[] = [];
  let rest = t;
  while (rest.length > 0 && aus.length < MAX_ABSCHNITTE) {
    if (rest.length <= ABSCHNITT) { aus.push(rest); break; }
    const fenster = rest.slice(0, ABSCHNITT);
    const schnitt = Math.max(fenster.lastIndexOf("\n\n"), fenster.lastIndexOf("\n"), fenster.lastIndexOf(". "));
    const bei = schnitt > ABSCHNITT * 0.5 ? schnitt + 1 : ABSCHNITT;
    aus.push(rest.slice(0, bei));
    rest = rest.slice(bei);
  }
  return aus;
}

function domainAus(s: string): string | null {
  const t = s.trim();
  const m = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(t);
  return m ? m[0].toLowerCase().replace(/^www\./, "") : null;
}

export interface IcpVorschlag { icp: Partial<Icp>; fehlend: string[]; hinweise: string[] }

function vorschlagAus(v: z.infer<typeof importSchema>, quelle: Icp["quelle"]): IcpVorschlag {
  const sauber = (a: string[]) => a.map((x) => x.trim()).filter((x) => x.length >= 2);
  const kunden = [] as Icp["kundenBeispiele"];
  const hinweise: string[] = [];
  let ohne = 0;
  for (const k of sauber(v.kundenBeispiele)) {
    const d = domainAus(k);
    if (d) kunden.push({ domain: d, name: k });
    else ohne++;
  }
  if (ohne > 0) hinweise.push(`${ohne} Beispielkunde${ohne === 1 ? "" : "n"} ohne Website im Text.`);
  return {
    icp: { beschreibung: v.beschreibung, angebot: v.angebot, nutzen: v.nutzen, branchen: sauber(v.branchen), orte: sauber(v.orte), ...(v.radiusKm ? { radiusKm: Math.round(v.radiusKm) } : {}), groesse: v.groesse, merkmale: sauber(v.merkmale), ausschluesse: v.ausschluesse, kundenBeispiele: kunden, quelle },
    fehlend: sauber(v.fehlend),
    hinweise,
  };
}

/** ICP aus einem Dokument oder Freitext (Abschnitte bei langen Texten). */
export async function icpAusText(text: string, quelle: string): Promise<IcpVorschlag | { error: string }> {
  const t = text.trim();
  if (t.length < 80) return { error: "Der Text ist zu kurz, um ein Idealkundenprofil daraus abzuleiten." };
  const teile = t.length > DIREKT_BIS ? abschnitte(t) : [t];
  let grundlage = t;
  const hinweise: string[] = [];
  if (teile.length > 1) {
    const notizen: string[] = [];
    for (let i = 0; i < teile.length; i++) {
      const r = await betreiberJson({
        system: "Du liest einen Abschnitt eines Dokuments, in dem ein B2B-Anbieter sein Idealkundenprofil (ICP) beschreibt. Notiere NUR Fakten, die fuer ein ICP zaehlen: Angebot und Nutzen des Anbieters, Zielbranchen, Firmengroesse, Regionen/Standorte, Merkmale idealer Kunden, Ausschluesse, Beispielkunden (Firmennamen oder Domains, KEINE Personennamen), Kauf-/Entscheidungssignale. Keine Vermutungen, nichts erfinden, Zahlen woertlich uebernehmen. Antworte NUR als JSON: {\"notizen\": [\"ein Fakt je Eintrag, max. 30\"]}",
        user: teile[i]!, schema: notizenSchema, quelle,
      });
      if (r.ok) notizen.push(...r.wert.notizen.map((n) => n.trim()).filter(Boolean));
      else hinweise.push(`Abschnitt ${i + 1} konnte nicht ausgewertet werden (${r.grund}).`);
    }
    if (notizen.length === 0) return { error: `Aus dem Text liessen sich keine ICP-Fakten lesen. ${hinweise[0] ?? ""}`.trim() };
    grundlage = `NOTIZEN AUS DEM DOKUMENT (${teile.length} Abschnitte):\n- ${notizen.join("\n- ")}`;
  }
  const r = await betreiberJson({ system: FORMULAR_SYSTEM, user: grundlage.slice(0, 60_000), schema: importSchema, quelle, maxTokens: 2500 });
  if (!r.ok) return { error: `Das Modell konnte das Formular nicht ableiten (${r.grund}).` };
  const v = vorschlagAus(r.wert, "dokument");
  v.hinweise.push(...hinweise);
  return v;
}

/** ICP aus der Website des Kunden (Startseite + Unterseiten). */
export async function icpAusWebsite(website: string, quelle: string): Promise<IcpVorschlag | { error: string }> {
  const seite = await websiteLesen(website);
  if (!seite) return { error: "Website nicht erreichbar oder zu wenig lesbarer Text." };
  const r = await betreiberJson({ system: WEBSITE_SYSTEM, user: `Website-Text von ${seite.url} (${seite.seiten} Seiten):\n${seite.text.slice(0, 40_000)}`, schema: importSchema, quelle, maxTokens: 2500 });
  if (!r.ok) return { error: `KI-Analyse fehlgeschlagen (${r.grund}).` };
  const v = vorschlagAus(r.wert, "assistent");
  v.hinweise.unshift(`${seite.seiten} Seite${seite.seiten === 1 ? "" : "n"} von ${seite.url} gelesen.`);
  return v;
}
