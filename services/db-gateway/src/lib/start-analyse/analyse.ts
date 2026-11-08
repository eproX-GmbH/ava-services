// Onboarding O1 (docs/PLAN_ONBOARDING.md): Start-Analyse einer Firmen-Website.
// Eigene Website lesen → Angebot, eigene Firma, ICP-Entwurf, Referenzkunden →
// bis zu 5 Referenzen: Website finden + Kurzprofil → ICP-Synthese.
// Betreiber-Spur (Betreiber zahlt, Joyce 2026-11-08). WICHTIG: Referenzen werden
// NUR aus der Website des Nutzers gelesen. Das Kurzprofil einer Referenz hat kein
// Referenzfeld, es gibt keine Tiefe 2 (Joyce: keine Referenzen der Referenzen).

import { lookup } from "node:dns/promises";
import { z } from "zod";
import { betreiberJson, betreiberWebsuche } from "../betreiber-llm";
import { istPlattform, kernDomain, websiteLesen, type CrawlErgebnis } from "../vorabanalyse/crawl";
import { namePasst } from "../vorabanalyse/namen";
import { istFreemail } from "./freemail";

const MAX_REFERENZEN = 5;

const kurz = (n: number) => z.string().nullish().transform((v) => (v ?? "").trim().slice(0, n));
const liste = (n: number, len: number) => z.array(z.string()).nullish().transform((a) => [...new Set((a ?? []).map((x) => x.trim().slice(0, len)).filter((x) => x.length >= 2))].slice(0, n));

const eigeneSchema = z.object({
  firma: z.object({ name: kurz(200), ort: kurz(100), branche: kurz(160), kurzbeschreibung: kurz(800), leistungen: liste(10, 120), groessenIndiz: kurz(200) }).default({}),
  angebot: kurz(600),
  nutzen: kurz(600),
  beschreibung: kurz(2000),
  branchen: liste(8, 100),
  orte: liste(5, 100),
  groesse: kurz(200),
  merkmale: liste(10, 200),
  referenzen: z.array(z.object({ name: kurz(200), domain: kurz(200), ort: kurz(100) })).nullish().transform((a) => (a ?? []).filter((r) => r.name.length >= 2 || r.domain.length >= 4).slice(0, 12)),
  fehlend: liste(10, 120),
});

/** Kurzprofil einer Referenz: bewusst OHNE Referenzfeld (keine Tiefe 2). */
const kurzprofilSchema = z.object({ name: kurz(200), branche: kurz(160), groessenIndiz: kurz(200), standort: kurz(100), leistungen: liste(8, 120) });

const syntheseSchema = z.object({ beschreibung: kurz(2000), branchen: liste(8, 100), groesse: kurz(200), merkmale: liste(10, 200) });

const websucheSchema = z.object({ url: z.string().nullable(), konfidenz: z.enum(["high", "medium", "low"]).default("low") });

export interface Referenz {
  name: string;
  domain: string | null;
  ort: string;
  profil: z.infer<typeof kurzprofilSchema> | null;
  /** Warum keine Website/kein Profil (fuer Hinweise, nie geraten). */
  grund?: string;
}

export interface StartErgebnis {
  website: string;
  seiten: number;
  eigeneFirma: z.infer<typeof eigeneSchema>["firma"];
  icp: {
    beschreibung: string; angebot: string; nutzen: string; branchen: string[]; orte: string[]; radiusKm: number;
    groesse: string; merkmale: string[]; ausschluesse: string; kundenBeispiele: Array<{ domain: string; name?: string; ort?: string }>;
  };
  referenzen: Referenz[];
  fehlend: string[];
  erstelltAt: string;
}

/** endgueltig = nicht wiederholen (Freemail, keine DNS, geparkte Seite). */
export type AnalyseAusgang = { ok: true; ergebnis: StartErgebnis } | { ok: false; endgueltig: boolean; status: "freemail" | "keine_website" | "fehler"; grund: string };

const GEPARKT = /(domain (is|may be) for sale|diese domain (kaufen|steht zum verkauf)|this domain is parked|parkingcrew|sedoparking|domain parking|buy this domain|hier entsteht (in kürze )?eine neue (internet|web)(seite|präsenz))/i;

async function dnsVorhanden(domain: string): Promise<boolean> {
  for (const host of [domain, `www.${domain}`]) {
    try {
      await lookup(host);
      return true;
    } catch (err) {
      const code = (err as { code?: string }).code;
      // Nur "gibt es nicht" ist endgueltig; Zeitueberschreitung u. ae. = spaeter erneut.
      if (code !== "ENOTFOUND" && code !== "ENODATA") return true;
    }
  }
  return false;
}

function textFuerModell(s: CrawlErgebnis): string {
  return [
    `Website-Text von ${s.url} (${s.seiten} Seiten):\n${s.text.slice(0, 40_000)}`,
    s.externeDomains.length ? `\nVerlinkte fremde Domains: ${s.externeDomains.slice(0, 60).join(", ")}` : "",
    s.bildtexte.length ? `\nBildtexte (z. B. Logos): ${s.bildtexte.slice(0, 80).join(" | ")}` : "",
  ].join("");
}

const EIGENE_SYSTEM =
  "Du analysierst die eigene Website eines B2B-Anbieters fuer seinen Start in einem Vertriebsassistenten. Extrahiere NUR, was die Website belegt, keine Personennamen, nichts erfinden.\n" +
  "- firma: name (Firmenname laut Impressum), ort (Firmensitz, nur Ortsname), branche, kurzbeschreibung (2-3 Saetze), leistungen (bis 10), groessenIndiz (Mitarbeiter/Standorte, falls genannt, sonst leer).\n" +
  "- angebot: 1-2 Saetze, was der Anbieter verkauft. nutzen: welches Problem er loest.\n" +
  "- beschreibung: 3-6 Saetze in Du-Form (\"Deine idealen Kunden sind ...\"): wen der Anbieter ansprechen sollte, abgeleitet aus Angebot, genannten Zielgruppen und Referenzen. Keine Marketing-Floskeln.\n" +
  "- branchen: 2-6 UEBERGEORDNETE Zielbranchen seiner Kunden (nicht seine eigenen Leistungen). orte: Firmensitz als Ortsname (z. B. \"Hannover\", \"Wien (AT)\"). groesse und merkmale nur, wenn die Website sie nennt oder klar nahelegt.\n" +
  "- referenzen: genannte Referenz- oder Bestandskunden (Seiten wie Referenzen, Kunden, Case Studies, Logos in den Bildtexten). name wie genannt, domain NUR wenn sie in den verlinkten Domains oder im Text steht, sonst leer; ort falls genannt. Partner, Lieferanten, Zertifikate, Verbaende, Softwarehersteller und Social-Media sind KEINE Referenzen. Bis zu 12.\n" +
  "- fehlend: was sich nicht belegen liess.\n" +
  'Antworte NUR als JSON: {"firma": {"name": "", "ort": "", "branche": "", "kurzbeschreibung": "", "leistungen": [], "groessenIndiz": ""}, "angebot": "", "nutzen": "", "beschreibung": "", "branchen": [], "orte": [], "groesse": "", "merkmale": [], "referenzen": [{"name": "", "domain": "", "ort": ""}], "fehlend": []}';

const KURZPROFIL_SYSTEM =
  "Du erstellst ein knappes Firmen-Kurzprofil ausschliesslich aus dem Website-Text. Keine Vermutungen, KEINE Personennamen. standort = Ortsname des Firmensitzes (Impressum). " +
  'Antworte NUR als JSON: {"name": "Firmenname", "branche": "...", "groessenIndiz": "Mitarbeiter/Standorte, falls erkennbar, sonst leer", "standort": "Ort oder leer", "leistungen": ["max. 8 wichtigste"]}';

// Wie synthesizeIcp in der App (discovery/icp-assistant.ts), hier auf der Betreiber-Spur.
const SYNTHESE_SYSTEM =
  "Du erstellst aus dem Angebot eines B2B-Anbieters und den Profilen seiner Referenzkunden ein Idealkundenprofil (ICP). Das ICP beschreibt die ZIELGRUPPE verallgemeinert, es ist KEINE Nacherzaehlung der Beispiel-Firmen. Regeln:\n" +
  "- Nur Muster ableiten, die die Profile wirklich zeigen. Keine Vermutungen, keine Personennamen, keine Ausschluss-Kriterien.\n" +
  "- branchen: 2-6 UEBERGEORDNETE Branchenbezeichnungen, keine Leistungs- oder Produktlisten.\n" +
  "- groesse: realistisches Groessenband fuer Zielkunden; nie Kennzahlen einer einzelnen Firma uebernehmen; bei nur einem Beispiel oder ohne Muster leer.\n" +
  "- merkmale: verallgemeinerte Eigenschaften der Zielgruppe.\n" +
  "- beschreibung: 3-6 Saetze in Du-Form aus Sicht des Anbieters (\"Deine idealen Kunden sind ...\"), konkret, ohne Floskeln, ohne die Beispiel-Firmen beim Namen zu nennen.\n" +
  'Antworte NUR als JSON: {"beschreibung": "...", "branchen": [], "groesse": "", "merkmale": []}';

function domainNormal(roh: string): string | null {
  const t = roh.trim().toLowerCase();
  if (!t) return null;
  try {
    const host = new URL(/^https?:\/\//.test(t) ? t : `https://${t}`).hostname;
    const d = kernDomain(host);
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) && !istPlattform(d) && !istFreemail(d) ? d : null;
  } catch {
    return null;
  }
}

/** Website einer Referenz finden: Domain aus der Seite, sonst Websuche; im Zweifel keine. */
async function referenzDomain(r: { name: string; domain: string; ort: string }, eigeneDomain: string, quelle: string): Promise<{ domain: string | null; grund?: string }> {
  const direkt = domainNormal(r.domain);
  if (direkt && direkt !== eigeneDomain) return { domain: direkt };
  if (!r.name) return { domain: null, grund: "kein Name" };
  const w = await betreiberWebsuche({
    prompt:
      `Finde die offizielle Unternehmenswebsite (eigene Domain der Firma, kein Verzeichnis, kein Portal, keine Social-Media-Seite) der Firma "${r.name}"${r.ort ? ` mit Sitz in ${r.ort}` : ""} (DACH-Raum bevorzugt). ` +
      `Gibt es mehrere Firmen dieses Namens und ist keine eindeutig, antworte mit url null. Antworte NUR als JSON: {"url": "https://..." oder null, "konfidenz": "high"|"medium"|"low"}`,
    schema: websucheSchema,
    quelle,
  });
  if (!w.ok) return { domain: null, grund: `Websuche: ${w.grund}` };
  const d = w.wert.url ? domainNormal(w.wert.url) : null;
  if (!d || d === eigeneDomain) return { domain: null, grund: "keine eindeutige Website gefunden" };
  // Ohne Namensbezug in der Domain gilt nur "high" (wie in der Vorabanalyse).
  const belegt = namePasst(r.name, r.ort || null, d);
  const passt = w.wert.konfidenz === "high" || (w.wert.konfidenz === "medium" && belegt);
  return passt ? { domain: d } : { domain: null, grund: "Website nicht sicher zuzuordnen" };
}

async function referenzProfil(r: { name: string; domain: string; ort: string }, eigeneDomain: string, quelle: string): Promise<Referenz> {
  const gefunden = await referenzDomain(r, eigeneDomain, quelle);
  if (!gefunden.domain) return { name: r.name || r.domain, domain: null, ort: r.ort, profil: null, grund: gefunden.grund };
  // Ein zweiter Versuch nach 10 s, danach weglassen (Referenzen sind Zugabe, kein Muss).
  let seite = await websiteLesen(gefunden.domain);
  if (!seite) {
    await new Promise((res) => setTimeout(res, 10_000));
    seite = await websiteLesen(gefunden.domain);
  }
  if (!seite) return { name: r.name || gefunden.domain, domain: gefunden.domain, ort: r.ort, profil: null, grund: "Website nicht lesbar" };
  // Nur Text, KEINE verlinkten Domains/Bildtexte: hier wird nicht nach Referenzen gesucht.
  const p = await betreiberJson({ system: KURZPROFIL_SYSTEM, user: `Website-Text von ${seite.url}:\n${seite.text.slice(0, 12_000)}`, schema: kurzprofilSchema, quelle, maxTokens: 1200 });
  if (!p.ok) return { name: r.name || gefunden.domain, domain: gefunden.domain, ort: r.ort, profil: null, grund: `Kurzprofil: ${p.grund}` };
  return { name: p.wert.name || r.name || gefunden.domain, domain: gefunden.domain, ort: p.wert.standort || r.ort, profil: p.wert };
}

/** Eine komplette Start-Analyse. Wiederholungen steuert der Auftrag (auftrag.ts). */
export async function startAnalyse(eingabe: { domain: string; website?: string | null }, quelle: string): Promise<AnalyseAusgang> {
  const ziel = eingabe.website?.trim() || eingabe.domain;
  const domain = domainNormal(ziel);
  if (!domain) return { ok: false, endgueltig: true, status: istFreemail(kernDomain(ziel.replace(/^https?:\/\//, "").split("/")[0] ?? "")) ? "freemail" : "keine_website", grund: "Keine Firmen-Domain" };
  if (!(await dnsVorhanden(domain))) return { ok: false, endgueltig: true, status: "keine_website", grund: `${domain} existiert nicht (DNS)` };

  const seite = await websiteLesen(eingabe.website?.trim() || domain);
  // 403/404/5xx/Zeitueberschreitung/robots: websiteLesen meldet null → Auftrag wiederholt.
  if (!seite) return { ok: false, endgueltig: false, status: "fehler", grund: `Website ${domain} nicht lesbar` };
  if (GEPARKT.test(seite.text.slice(0, 4000)) && seite.text.length < 3000) return { ok: false, endgueltig: true, status: "keine_website", grund: `${domain} ist eine geparkte Seite` };

  const e = await betreiberJson({ system: EIGENE_SYSTEM, user: textFuerModell(seite), schema: eigeneSchema, quelle, maxTokens: 3000 });
  if (!e.ok) return { ok: false, endgueltig: false, status: "fehler", grund: `KI-Analyse: ${e.grund}` };
  const eigen = e.wert;

  const referenzen: Referenz[] = [];
  const gesehen = new Set<string>();
  for (const r of eigen.referenzen) {
    if (referenzen.length >= MAX_REFERENZEN) break;
    const schluessel = (domainNormal(r.domain) ?? r.name).toLowerCase();
    if (gesehen.has(schluessel)) continue;
    gesehen.add(schluessel);
    referenzen.push(await referenzProfil(r, domain, quelle));
  }
  const mitProfil = referenzen.filter((r) => r.profil);

  let { beschreibung, branchen, groesse, merkmale } = eigen;
  if (mitProfil.length > 0) {
    const user =
      `ANBIETER:\nAngebot: ${eigen.angebot}\nNutzen: ${eigen.nutzen}\nLeistungen: ${eigen.firma.leistungen.join(", ")}\n\n` +
      `REFERENZKUNDEN (${mitProfil.length} Beispiel${mitProfil.length === 1 ? ", vorsichtig verallgemeinern" : "e"}):\n` +
      mitProfil.map((r) => `- ${r.name} (${r.profil!.branche}${r.ort ? `, ${r.ort}` : ""})${r.profil!.groessenIndiz ? ` | Groesse: ${r.profil!.groessenIndiz}` : ""}${r.profil!.leistungen.length ? ` | Taetigkeit: ${r.profil!.leistungen.join(", ")}` : ""}`).join("\n");
    const s = await betreiberJson({ system: SYNTHESE_SYSTEM, user, schema: syntheseSchema, quelle, maxTokens: 1500 });
    if (s.ok && s.wert.beschreibung.length >= 40) {
      beschreibung = s.wert.beschreibung;
      if (s.wert.branchen.length) branchen = s.wert.branchen;
      if (s.wert.groesse) groesse = s.wert.groesse;
      if (s.wert.merkmale.length) merkmale = s.wert.merkmale;
    }
  }
  const orte = eigen.orte.length ? eigen.orte : eigen.firma.ort ? [eigen.firma.ort] : [];
  return {
    ok: true,
    ergebnis: {
      website: seite.url,
      seiten: seite.seiten,
      eigeneFirma: eigen.firma,
      icp: {
        beschreibung, angebot: eigen.angebot, nutzen: eigen.nutzen, branchen, orte, radiusKm: 50, groesse, merkmale, ausschluesse: "",
        kundenBeispiele: referenzen.filter((r) => r.domain).slice(0, MAX_REFERENZEN).map((r) => ({ domain: r.domain!, ...(r.name ? { name: r.name } : {}), ...(r.ort ? { ort: r.ort } : {}) })),
      },
      referenzen,
      fehlend: eigen.fehlend,
      erstelltAt: new Date().toISOString(),
    },
  };
}
