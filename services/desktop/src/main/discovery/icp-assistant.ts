// I2 ICP-Assistent (docs/PLAN_ICP_ASSISTENT.md) — URL-Analyse-Engine.
//
// "Zeig mir dich und deine 5 besten Kunden": eigene Website → Angebot +
// Nutzer-Standort (Impressum); Kunden-Websites → was die besten Kunden
// ausmacht; Synthese → ICP-Entwurf fuer den Review-Screen (B6: NIE
// stillschweigend speichern — dieses Modul liefert nur den Entwurf).
//
// Entscheidungen: B1 (alles lokal), B2 (Crawl-/LLM-Wiederverwendung),
// B3 (drei getrennte LLM-Schritte), B4 (Radius aus Kunden-Distanzen).
// Prompt-Regeln: nur Belegbares, keine Personennamen, K8 bleibt leer.

import * as yup from "yup";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import type { IcpProfile, IcpKundenBeispiel } from "../agent/icp-store";
import { crawlSite, embedText } from "./profiler";
import { domainFromUrl } from "./scan";
import type { CustomerProfileStore } from "./customer-profiles";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../link-monitor/llm";

export interface IcpAnalysisProgress {
  /** 1-basierter Schritt / Gesamt (fuer die Fortschrittsanzeige). */
  step: number;
  total: number;
  text: string;
}

export interface OwnSiteAnalysis {
  angebot: string;
  nutzen: string;
  branche: string;
  leistungen: string[];
  standort: string;
}

export interface CustomerSiteAnalysis {
  domain: string;
  name: string;
  branche: string;
  groessenIndiz: string;
  standort: string;
  leistungen: string[];
}

export interface CustomerInput {
  /** Normierte Kern-Domain (ID/Dedup). */
  domain: string;
  /** Exakte vom Nutzer angegebene URL (inkl. Pfad) — Crawl-Einstieg. */
  url: string;
}

export interface IcpDraft {
  icp: Partial<IcpProfile>;
  eigene: OwnSiteAnalysis | null;
  kunden: CustomerSiteAnalysis[];
  /** Kunden-Websites, die NICHT eingeflossen sind — mit Grund. */
  kundenFehlgeschlagen: Array<{ domain: string; grund: string }>;
  radiusBegruendung: string | null;
  hinweise: string[];
}

// ---- LLM-Schemata ----------------------------------------------------------

// Schemas bewusst TOLERANT: ein fehlendes Nebenfeld darf die ganze
// Analyse nicht kippen (Live-Befund: "KI-Analyse fehlgeschlagen" fuer
// intakte Websites, weil kleine Producer-Modelle Felder auslassen).
// Pflicht bleibt nur das Minimum; Rest hat Defaults.
// v0.1.471 — Zu VIEL Inhalt ist KEIN Fehler, sondern ein Kürz-Job
// (Live-Befund: "leistungen field must have less than or equal to 8
// items" kippte die komplette Kunden-Analyse — ausgerechnet bei
// gründlichen, starken Modellen). Ober-Grenzen werden deshalb VOR der
// Validierung gestutzt statt abgelehnt; nur Unter-Grenzen (zu wenig
// Substanz) bleiben echte Fehler.
const clampString = (max: number) =>
  yup
    .string()
    .transform((v) => (typeof v === "string" ? v.trim().slice(0, max) : v));

const clampList = (itemMax: number, maxItems: number) =>
  yup
    .array()
    .transform((v) =>
      Array.isArray(v)
        ? v
            .filter((x) => typeof x === "string" && x.trim().length > 0)
            .map((x: string) => x.trim().slice(0, itemMax))
            .slice(0, maxItems)
        : v,
    )
    // required() nur fuer den Typ (string[] statt (string|undefined)[]) —
    // leere Items sind durch den Transform-Filter schon raus.
    .of(yup.string().required())
    .default([]);

const ownSchema = yup.object({
  angebot: clampString(600).min(5).required(),
  nutzen: clampString(600).default(""),
  branche: clampString(120).default(""),
  leistungen: clampList(120, 10),
  standort: clampString(80).default(""),
});

const customerSchema = yup.object({
  name: clampString(200).default(""),
  branche: clampString(120).default(""),
  groessenIndiz: clampString(200).default(""),
  standort: clampString(80).default(""),
  leistungen: clampList(120, 8),
});

const synthesisSchema = yup.object({
  beschreibung: clampString(2000).min(40).required(),
  branchen: clampList(60, 12),
  groesse: clampString(200).default(""),
  merkmale: clampList(120, 10),
});

type LlmJsonResult<T> = { ok: true; value: T } | { ok: false; detail: string };

/** LLM-JSON mit ESKALATION: Versuch 1 auf dem guenstigen Producer-
 *  Modell, Versuch 2 auf dem vollen Chat-Modell (kleine Modelle sind
 *  die Hauptursache fuer unparsbares JSON). Fehler kommen mit
 *  konkretem Grund zurueck statt als stilles null. */
async function llmJson<T>(
  providers: LlmProviderManager,
  system: string,
  user: string,
  tag: string,
  schema: yup.Schema<T>,
): Promise<LlmJsonResult<T>> {
  if (!providers.getStatus().ready) {
    return { ok: false, detail: "kein KI-Modell bereit" };
  }
  let detail = "unbekannt";
  const producerOverride = providers.getProducerModelOverride();
  const attempts: Array<string | undefined> = producerOverride
    ? [producerOverride, undefined] // 2. Versuch: Chat-Modell
    : [undefined, undefined];
  for (const modelOverride of attempts) {
    try {
      const raw = await streamToText(
        providers,
        buildMessages(system, user, tag),
        {
          timeoutMs: 90_000,
          ...(modelOverride ? { modelOverride } : {}),
        },
      );
      const parsed = parseJsonObject(raw);
      if (!parsed) {
        detail = "Antwort war kein JSON";
        continue;
      }
      return { ok: true, value: schema.validateSync(parsed, { abortEarly: true }) };
    } catch (err) {
      detail = err instanceof Error ? err.message.slice(0, 160) : String(err);
      console.warn(`[icp-assistant] LLM-Schritt ${tag} fehlgeschlagen:`, err);
    }
  }
  return { ok: false, detail };
}

// ---- Schritt 1: eigene Website ---------------------------------------------

function cleanList(v: Array<string | undefined>): string[] {
  return v.filter((s): s is string => !!s && s.trim().length >= 2);
}

async function analyzeOwnSite(
  providers: LlmProviderManager,
  domain: string,
): Promise<OwnSiteAnalysis | { fehler: string }> {
  const text = await crawlSite(domain);
  if (!text) {
    return { fehler: "Website nicht erreichbar oder nicht lesbar" };
  }
  const system =
    "Du analysierst die eigene Website eines B2B-Anbieters. Extrahiere " +
    "NUR, was der Text belegt — keine Vermutungen, KEINE Personennamen. " +
    "standort = Ortsname des Firmensitzes (typisch im Impressum), nur " +
    "der Ort ohne Strasse/PLZ; leer lassen, wenn nicht eindeutig. " +
    'Antworte NUR als JSON: {"angebot": "1-2 Saetze: was wird ' +
    'angeboten", "nutzen": "welches Problem wird geloest", "branche": ' +
    '"...", "leistungen": ["max. 10 wichtigste"], "standort": "Ort oder leer"}';
  const r = await llmJson(
    providers,
    system,
    `Website-Text von ${domain}:\n${text.slice(0, 14_000)}`,
    "icpown",
    ownSchema,
  );
  if (!r.ok) return { fehler: `KI-Analyse fehlgeschlagen (${r.detail})` };
  return { ...r.value, leistungen: cleanList(r.value.leistungen) };
}

// ---- Schritt 2: Kunden-Websites --------------------------------------------

async function analyzeCustomerSite(
  providers: LlmProviderManager,
  cand: CustomerInput,
): Promise<CustomerSiteAnalysis | { fehler: "crawl" | "llm"; detail?: string }> {
  // Exakte URL crawlen (inkl. Pfad!) — die angegebene Seite IST der
  // Kunde (z. B. ein konkreter Shop), nicht die Konzern-Startseite.
  const text = await crawlSite(cand.domain, cand.url);
  if (!text) return { fehler: "crawl" };
  const system =
    "Du analysierst die Website eines Unternehmens (Bestandskunde eines " +
    "B2B-Anbieters). Extrahiere NUR Belegbares, KEINE Personennamen. " +
    "standort = Ortsname des Firmensitzes (Impressum), nur der Ort. " +
    'Antworte NUR als JSON: {"name": "Firmenname", "branche": "...", ' +
    '"groessenIndiz": "z. B. Mitarbeiter/Standorte, falls erkennbar, ' +
    'sonst leer", "standort": "Ort oder leer", "leistungen": ["max. 8 wichtigste"]}';
  const r = await llmJson(
    providers,
    system,
    `Website-Text von ${cand.url}:\n${text.slice(0, 12_000)}`,
    "icpcust",
    customerSchema,
  );
  if (!r.ok) return { fehler: "llm", detail: r.detail };
  return {
    ...r.value,
    // Fallbacks statt Totalausfall: fehlender Name → Domain.
    name: r.value.name.trim() || cand.domain,
    leistungen: cleanList(r.value.leistungen),
    domain: cand.domain,
  };
}

// ---- Schritt 3: Synthese ---------------------------------------------------

async function synthesizeIcp(
  providers: LlmProviderManager,
  own: OwnSiteAnalysis,
  kunden: CustomerSiteAnalysis[],
): Promise<yup.InferType<typeof synthesisSchema> | null> {
  const system =
    "Du erstellst aus dem Angebot eines B2B-Anbieters und den Profilen " +
    "seiner besten Bestandskunden ein Idealkundenprofil (ICP). Das ICP " +
    "beschreibt die ZIELGRUPPE verallgemeinert — es ist KEINE " +
    "Nacherzaehlung der Beispiel-Firmen. Regeln:\n" +
    "- Nur Muster ableiten, die die Kundenprofile wirklich zeigen — " +
    "keine Vermutungen, keine Personennamen, KEINE Ausschluss-" +
    "Kriterien (die definiert der Nutzer selbst).\n" +
    "- branchen: 2-6 UEBERGEORDNETE Branchenbezeichnungen (z. B. " +
    '"Immobilien", "Rechtsberatung", "Steuerberatung") — KEINE ' +
    "Leistungs- oder Produktlisten der Beispiel-Firmen.\n" +
    "- groesse: ein realistisches Groessenband fuer ZIELKUNDEN (z. B. " +
    '"10-200 Mitarbeiter" oder "mehrere Standorte"). NIEMALS Kennzahlen ' +
    "einer einzelnen Beispiel-Firma woertlich uebernehmen (etwa " +
    "Konzern-Standortzahlen). Bei nur EINEM Kundenbeispiel oder ohne " +
    "belastbares Muster: leer lassen.\n" +
    "- merkmale: verallgemeinerte Eigenschaften der Zielgruppe, nicht " +
    "firmenspezifische Fakten.\n" +
    "- beschreibung: 3-6 Saetze in Du-Form aus Sicht des Anbieters " +
    "(\"Deine idealen Kunden sind ...\"), konkret, ohne Marketing-" +
    "Floskeln und ohne die Beispiel-Firmen beim Namen zu nennen. " +
    'Antworte NUR als JSON: {"beschreibung": "...", "branchen": ["..."], ' +
    '"groesse": "...oder leer", "merkmale": ["..."]}';
  const user =
    `ANBIETER:\nAngebot: ${own.angebot}\nNutzen: ${own.nutzen}\n` +
    `Leistungen: ${own.leistungen.join(", ")}\n\n` +
    `BESTE KUNDEN (${kunden.length} Beispiel${kunden.length === 1 ? " — vorsichtig verallgemeinern, nichts woertlich uebernehmen" : "e"}):\n` +
    kunden
      .map(
        (k) =>
          `- ${k.name} (${k.branche}${k.standort ? `, ${k.standort}` : ""})` +
          `${k.groessenIndiz ? ` | Groesse: ${k.groessenIndiz}` : ""}` +
          `${k.leistungen.length > 0 ? ` | Taetigkeit: ${k.leistungen.join(", ")}` : ""}`,
      )
      .join("\n");
  const r = await llmJson(providers, system, user, "icpsynth", synthesisSchema);
  return r.ok ? r.value : null;
}

// ---- Radius-Vorschlag (B4) -------------------------------------------------

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

async function resolveOrt(
  gateway: GatewayClient,
  ort: string,
): Promise<{ lat: number; lon: number } | null> {
  try {
    const qs = new URLSearchParams({ near: ort, radiusKm: "1" });
    const geo = await gateway.request<{ origin: { lat: number; lon: number } }>(
      `/v1/geo/places?${qs.toString()}`,
    );
    return geo.origin;
  } catch {
    return null;
  }
}

async function suggestRadius(
  gateway: GatewayClient,
  eigenerOrt: string,
  kunden: CustomerSiteAnalysis[],
): Promise<{ radiusKm: number; begruendung: string }> {
  const fallback = {
    radiusKm: 50,
    begruendung: "Standard-Radius 50 km (Kunden-Standorte nicht auswertbar).",
  };
  const own = await resolveOrt(gateway, eigenerOrt);
  if (!own) return fallback;
  let maxKm = 0;
  let fernster: { name: string; km: number } | null = null;
  for (const k of kunden) {
    if (!k.standort) continue;
    const pos = await resolveOrt(gateway, k.standort);
    if (!pos) continue;
    const km = haversineKm(own.lat, own.lon, pos.lat, pos.lon);
    if (km > maxKm) {
      maxKm = km;
      fernster = { name: k.name, km: Math.round(km) };
    }
  }
  if (!fernster) return fallback;
  const radiusKm = Math.min(200, Math.max(30, Math.ceil(maxKm / 10) * 10));
  return {
    radiusKm,
    begruendung: `Dein entferntester Top-Kunde (${fernster.name}) sitzt ~${fernster.km} km entfernt — Vorschlag ${radiusKm} km.`,
  };
}

// ---- Orchestrator ----------------------------------------------------------

/** Kompakter Profiltext eines Top-Kunden — gleicher Stil wie die
 *  Radar-Mini-Profile, damit die Embeddings vergleichbar sind (I5). */
export function renderCustomerProfileText(k: CustomerSiteAnalysis): string {
  const lines = [
    `${k.name}${k.standort ? ` (${k.standort})` : ""} — ${k.branche}.`,
  ];
  if (k.leistungen.length > 0) lines.push(`Leistungen: ${k.leistungen.join(", ")}.`);
  if (k.groessenIndiz) lines.push(`Groesse: ${k.groessenIndiz}.`);
  return lines.join("\n");
}

/** Rohe Nutzer-URLs → CustomerInputs: exakte URL BEHALTEN (Crawl-
 *  Einstieg), Kern-Domain normieren (ID/Dedup), eigene Domain und
 *  Unbrauchbares aussortieren. */
export function buildCustomerInputs(
  rawUrls: string[],
  eigeneDomain: string,
): { inputs: CustomerInput[]; unbrauchbar: string[] } {
  const inputs: CustomerInput[] = [];
  const unbrauchbar: string[] = [];
  for (const raw of rawUrls) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const domain = domainFromUrl(trimmed);
    if (!domain) {
      unbrauchbar.push(trimmed.slice(0, 120));
      continue;
    }
    if (domain === eigeneDomain) continue;
    inputs.push({
      domain,
      url: trimmed.startsWith("http") ? trimmed : `https://${trimmed}`,
    });
  }
  return { inputs, unbrauchbar };
}

export async function runIcpAnalysis(
  gateway: GatewayClient,
  providers: LlmProviderManager,
  args: { eigeneDomain: string; kunden: CustomerInput[] },
  onProgress: (p: IcpAnalysisProgress) => void,
  /** I5 — Kundenprofile (Text + Embedding) fuer das Match-Signal
   *  lokal ablegen. Optional (Tests). */
  customerStore?: CustomerProfileStore,
): Promise<IcpDraft | { error: string }> {
  if (!providers.getStatus().ready) {
    return { error: "Kein KI-Modell bereit — bitte zuerst ein Modell einrichten." };
  }
  const seenDomains = new Set<string>();
  const kundenInputs = args.kunden
    .filter((k) => {
      if (seenDomains.has(k.domain)) return false;
      seenDomains.add(k.domain);
      return true;
    })
    .slice(0, 5);
  const total = 2 + kundenInputs.length + 1; // eigene + je Kunde + Synthese/Radius
  let step = 0;
  const hinweise: string[] = [];
  const tick = (text: string): void => {
    step++;
    onProgress({ step, total, text });
  };

  // 1. Eigene Website.
  tick(`Analysiere deine Website (${args.eigeneDomain}) …`);
  const eigeneResult = await analyzeOwnSite(providers, args.eigeneDomain);
  if ("fehler" in eigeneResult) {
    return {
      error: `Deine Website (${args.eigeneDomain}): ${eigeneResult.fehler}. Bitte URL pruefen und erneut versuchen.`,
    };
  }
  const eigene = eigeneResult;

  // 2. Kunden-Websites (Concurrency 2 — schont fremde Server).
  const kunden: CustomerSiteAnalysis[] = [];
  const kundenFehlgeschlagen: Array<{ domain: string; grund: string }> = [];
  const queue = [...kundenInputs];
  const workers = Array.from({ length: 2 }, async () => {
    for (;;) {
      const cand = queue.shift();
      if (!cand) return;
      tick(`Analysiere Kunden-Website ${cand.domain} …`);
      const result = await analyzeCustomerSite(providers, cand);
      if ("fehler" in result) {
        const grund =
          result.fehler === "crawl"
            ? "Website nicht erreichbar oder nicht lesbar (auch per Browser)"
            : `KI-Analyse fehlgeschlagen (${result.detail ?? "2 Versuche"})`;
        kundenFehlgeschlagen.push({ domain: cand.domain, grund });
        // Ehrliche Fortschrittszeile — vorher bekam auch ein Fehlschlag
        // in der Anzeige einen Haken.
        onProgress({ step, total, text: `✗ ${cand.domain}: ${grund}` });
        continue;
      }
      kunden.push(result);
      // I5 — Profil + Embedding lokal ablegen (Match-Signal
      // "aehnlich zu deinen Top-Kunden"). Best-effort.
      if (customerStore) {
        const profileText = renderCustomerProfileText(result);
        customerStore.set(cand.domain, {
          profileText,
          embedding: await embedText(profileText),
        });
      }
    }
  });
  await Promise.all(workers);
  for (const f of kundenFehlgeschlagen) {
    hinweise.push(`${f.domain}: ${f.grund}.`);
  }
  // Duenne-Basis-Warnung: weniger als die Haelfte der Kunden analysierbar.
  if (
    kundenInputs.length > 0 &&
    kunden.length < Math.ceil(kundenInputs.length / 2)
  ) {
    hinweise.push(
      `Nur ${kunden.length} von ${kundenInputs.length} Kunden-Websites flossen ein — das ICP steht auf duenner Basis. URLs pruefen und erneut analysieren lohnt sich.`,
    );
  }

  // 3. Synthese + Radius.
  tick("Erstelle dein Idealkundenprofil …");
  let synth: yup.InferType<typeof synthesisSchema> | null = null;
  if (kunden.length > 0) {
    synth = await synthesizeIcp(providers, eigene, kunden);
    if (!synth) hinweise.push("ICP-Synthese fehlgeschlagen — Entwurf enthaelt nur die Angebots-Analyse.");
  } else {
    hinweise.push(
      "Keine Kunden-Website analysierbar — Entwurf basiert nur auf deiner eigenen Website.",
    );
  }

  let radiusKm = 50;
  let radiusBegruendung: string | null = null;
  if (eigene.standort) {
    const r = await suggestRadius(gateway, eigene.standort, kunden);
    radiusKm = r.radiusKm;
    radiusBegruendung = r.begruendung;
  } else {
    hinweise.push(
      "Kein Firmen-Standort auf deiner Website gefunden — bitte Ort im Formular ergaenzen (wichtig fuer den Radar).",
    );
  }

  tick("Fertig — Entwurf bereit zum Review.");

  const kundenBeispiele: IcpKundenBeispiel[] = kunden.map((k) => ({
    domain: k.domain,
    name: k.name,
    ...(k.standort ? { ort: k.standort } : {}),
  }));
  const icp: Partial<IcpProfile> = {
    beschreibung: synth?.beschreibung ?? "",
    angebot: eigene.angebot,
    nutzen: eigene.nutzen,
    branchen: synth?.branchen ?? [],
    orte: eigene.standort ? [eigene.standort] : [],
    radiusKm,
    groesse: synth?.groesse ?? "",
    merkmale: synth?.merkmale ?? [],
    ausschluesse: "", // K8 — definiert NUR der Nutzer (B3).
    kundenBeispiele,
    quelle: "assistent",
  };
  return { icp, eigene, kunden, kundenFehlgeschlagen, radiusBegruendung, hinweise };
}
