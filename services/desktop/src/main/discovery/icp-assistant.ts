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

const ownSchema = yup.object({
  angebot: yup.string().trim().min(5).max(600).required(),
  nutzen: yup.string().trim().max(600).default(""),
  branche: yup.string().trim().max(120).default(""),
  leistungen: yup.array().of(yup.string().trim().min(2).max(120).required()).max(10).default([]),
  standort: yup.string().trim().max(80).default(""),
});

const customerSchema = yup.object({
  name: yup.string().trim().min(2).max(200).required(),
  branche: yup.string().trim().min(2).max(120).required(),
  groessenIndiz: yup.string().trim().max(200).default(""),
  standort: yup.string().trim().max(80).default(""),
  leistungen: yup.array().of(yup.string().trim().min(2).max(120).required()).max(8).default([]),
});

const synthesisSchema = yup.object({
  beschreibung: yup.string().trim().min(40).max(2000).required(),
  branchen: yup.array().of(yup.string().trim().min(2).max(60).required()).max(12).default([]),
  groesse: yup.string().trim().max(200).default(""),
  merkmale: yup.array().of(yup.string().trim().min(2).max(120).required()).max(10).default([]),
});

async function llmJson<T>(
  providers: LlmProviderManager,
  system: string,
  user: string,
  tag: string,
  schema: yup.Schema<T>,
): Promise<T | null> {
  if (!providers.getStatus().ready) return null;
  try {
    const raw = await streamToText(providers, buildMessages(system, user, tag), {
      timeoutMs: 90_000,
      ...(providers.getProducerModelOverride()
        ? { modelOverride: providers.getProducerModelOverride() }
        : {}),
    });
    const parsed = parseJsonObject(raw);
    if (!parsed) return null;
    return schema.validateSync(parsed, { abortEarly: true });
  } catch (err) {
    console.warn(`[icp-assistant] LLM-Schritt ${tag} fehlgeschlagen:`, err);
    return null;
  }
}

// ---- Schritt 1: eigene Website ---------------------------------------------

async function analyzeOwnSite(
  providers: LlmProviderManager,
  domain: string,
): Promise<OwnSiteAnalysis | null> {
  const text = await crawlSite(domain);
  if (!text) return null;
  const system =
    "Du analysierst die eigene Website eines B2B-Anbieters. Extrahiere " +
    "NUR, was der Text belegt — keine Vermutungen, KEINE Personennamen. " +
    "standort = Ortsname des Firmensitzes (typisch im Impressum), nur " +
    "der Ort ohne Strasse/PLZ; leer lassen, wenn nicht eindeutig. " +
    'Antworte NUR als JSON: {"angebot": "1-2 Saetze: was wird ' +
    'angeboten", "nutzen": "welches Problem wird geloest", "branche": ' +
    '"...", "leistungen": ["..."], "standort": "Ort oder leer"}';
  return llmJson(
    providers,
    system,
    `Website-Text von ${domain}:\n${text.slice(0, 24_000)}`,
    "icpown",
    ownSchema,
  );
}

// ---- Schritt 2: Kunden-Websites --------------------------------------------

async function analyzeCustomerSite(
  providers: LlmProviderManager,
  cand: CustomerInput,
): Promise<CustomerSiteAnalysis | { fehler: "crawl" | "llm" }> {
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
    'sonst leer", "standort": "Ort oder leer", "leistungen": ["..."]}';
  // Bis zu 2 Versuche — unparsbare/schema-widrige KI-Antworten sollen
  // einen Kunden nicht still aus dem ICP werfen.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await llmJson(
      providers,
      system,
      `Website-Text von ${cand.url}:\n${text.slice(0, 20_000)}`,
      "icpcust",
      customerSchema,
    );
    if (result) return { ...result, domain: cand.domain };
  }
  return { fehler: "llm" };
}

// ---- Schritt 3: Synthese ---------------------------------------------------

async function synthesizeIcp(
  providers: LlmProviderManager,
  own: OwnSiteAnalysis,
  kunden: CustomerSiteAnalysis[],
): Promise<yup.InferType<typeof synthesisSchema> | null> {
  const system =
    "Du erstellst aus dem Angebot eines B2B-Anbieters und den Profilen " +
    "seiner besten Bestandskunden ein Idealkundenprofil (ICP). Leite " +
    "NUR Muster ab, die die Kundenprofile wirklich zeigen — keine " +
    "Vermutungen, keine Personennamen, KEINE Ausschluss-Kriterien " +
    "(die definiert der Nutzer selbst). beschreibung: 3-6 Saetze in " +
    "Du-Form aus Sicht des Anbieters (\"Deine idealen Kunden sind ...\"), " +
    "konkret und ohne Marketing-Floskeln. " +
    'Antworte NUR als JSON: {"beschreibung": "...", "branchen": ["..."], ' +
    '"groesse": "Groessenband, falls ableitbar, sonst leer", ' +
    '"merkmale": ["gemeinsame Merkmale der Kunden"]}';
  const user =
    `ANBIETER:\nAngebot: ${own.angebot}\nNutzen: ${own.nutzen}\n` +
    `Leistungen: ${own.leistungen.join(", ")}\n\nBESTE KUNDEN:\n` +
    kunden
      .map(
        (k) =>
          `- ${k.name} (${k.branche}${k.standort ? `, ${k.standort}` : ""})` +
          `${k.groessenIndiz ? ` | Groesse: ${k.groessenIndiz}` : ""}` +
          `${k.leistungen.length > 0 ? ` | Taetigkeit: ${k.leistungen.join(", ")}` : ""}`,
      )
      .join("\n");
  return llmJson(providers, system, user, "icpsynth", synthesisSchema);
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
  const eigene = await analyzeOwnSite(providers, args.eigeneDomain);
  if (!eigene) {
    return {
      error:
        `Deine Website (${args.eigeneDomain}) konnte nicht analysiert werden ` +
        `(nicht erreichbar, zu wenig Text oder KI-Fehler). Bitte URL pruefen.`,
    };
  }

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
        kundenFehlgeschlagen.push({
          domain: cand.domain,
          grund:
            result.fehler === "crawl"
              ? "Website nicht erreichbar oder nicht lesbar"
              : "KI-Analyse fehlgeschlagen (2 Versuche) — bitte erneut analysieren",
        });
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
