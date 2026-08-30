// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Scan-Lauf.
//
// Laeuft LOKAL auf der Nutzer-Maschine (Compute-Locality, A2). Ablauf:
//   1. Ortsgraph:  GET /v1/geo/places      → Origin, bbox, Nachbarorte
//   2. Scan-Start: POST /v1/discovery/scans → scanId + Caps (Quota O3)
//   3. Kanaele:
//      a. OSM Overpass (oeffentliche Instanz, EIN Request pro Scan,
//         Timeout 30 s — Fair-Use per O2): benannte office/craft-POIs
//         in der bbox, Feinfilter Haversine auf den Radius.
//      b. valueserp ueber den Gateway-Proxy (Operator-Key bleibt in der
//         Cloud): eine places-Suche pro Branchenbegriff, max. 8 Queries
//         pro Scan (deutlich unter dem O1-Budget von 30).
//   4. Merge + Priorisierung (Kandidaten MIT Website zuerst — Phase 2
//      braucht sie fuers Mini-Profil), Batches a 100 ans Gateway.
//
// Bot-Detection-Policy (A7) betrifft diesen Code nicht — beide Kanaele
// sind APIs, kein Browser-Scraping.

import * as yup from "yup";
import type { GatewayClient } from "../agent/gateway-client";
import type { LlmProviderManager } from "../agent/providers";
import { sanitizeCategory } from "./category";
import {
  buildMessages,
  parseJsonObject,
  streamToText,
} from "../link-monitor/llm";

const OVERPASS_URL =
  process.env.AVA_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const MAX_SERP_QUERIES = 8;
const BATCH_SIZE = 100;

export interface ScanArgs {
  ort: string;
  radiusKm: number;
  /** Branchenbegriffe — Fallback fuer den SERP-Kanal, wenn der
   *  LLM-Query-Planner nicht verfuegbar ist. Leer + kein icpText →
   *  SERP-Kanal wird uebersprungen (nur OSM/Register). */
  branchen: string[];
  /** Voller ICP-Text (icp.renderText()) — aktiviert den LLM-Query-
   *  Planner: gezielte Places-Suchen wie ein menschlicher Rechercheur
   *  statt stumpfem "Branche Ort". */
  icpText?: string;
}

export interface ScanSummary {
  scanId: string;
  origin: { name: string; kreis: string };
  orteImRadius: number;
  quellen: { osm: number; serp: number; register: number };
  kandidatenGesamt: number;
  added: number;
  updated: number;
  bereitsBekannt: number;
  capped: number;
  serpQueries: string[];
  /** Wie die SERP-Queries entstanden: LLM-Planner, Branche-Ort-Fallback
   *  oder gar nicht (kein ICP/Branchen). */
  queryPlanung: "llm" | "fallback" | "keine";
  hinweise: string[];
}

interface Candidate {
  name: string;
  city?: string | null;
  plz?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Pflicht (Zielbild): ohne Website wird eine Firma komplett
   *  uebersprungen — die normierte Kern-Domain ist die Discovery-ID. */
  domain: string;
  category?: string | null;
  meta?: Record<string, unknown> | null;
  /** Register-Kanal: master-data-companyId ist hier schon bekannt. */
  masterCompanyId?: string | null;
  source: "osm" | "serp" | "register";
}

interface GeoResponse {
  origin: { name: string; kreis: string; lat: number; lon: number };
  /** plz-Anzahl dient als Groessen-Proxy des Orts (Query-Planner). */
  places: Array<{ name: string; plz?: string[] }>;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

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

/** URL → normierte KERN-Domain. MUSS mit `normalizeDomain` im Gateway
 *  (services/db-gateway/src/lib/discovery.ts) uebereinstimmen — die
 *  Kern-Domain ist die Discovery-ID. */
export function domainFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  // Social-Profile sind keine Firmen-Domains — fuers Mini-Profil nutzlos.
  if (/facebook\.com|instagram\.com|linkedin\.com|xing\.com/.test(host)) {
    return null;
  }
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const tld = labels[labels.length - 1] ?? "";
  const sld = labels[labels.length - 2] ?? "";
  const take =
    labels.length > 2 && tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  const core = labels.slice(-take).join(".");
  if (core.length < 4 || core.length > 100) return null;
  return core;
}

/** Kanal a: OSM Overpass — benannte Gewerbe-POIs in der bbox. */
async function fetchOsmCandidates(
  geo: GeoResponse,
  radiusKm: number,
  hinweise: string[],
): Promise<Candidate[]> {
  const { minLat, minLon, maxLat, maxLon } = geo.bbox;
  const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
  const query = `[out:json][timeout:30];
(
  nwr["office"]["name"](${bbox});
  nwr["craft"]["name"](${bbox});
);
out center 800;`;
  try {
    // User-Agent ist Pflicht: die oeffentliche Overpass-Instanz lehnt
    // anonyme Clients mit Apache-406 ab (empirisch verifiziert).
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "AVA-Desktop-Discovery/0.1 (+https://github.com/eproX-GmbH)",
        accept: "application/json",
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      hinweise.push(
        `OSM-Kanal uebersprungen (Overpass antwortete ${res.status} — oeffentliche Instanz ggf. ausgelastet, spaeter erneut versuchen).`,
      );
      return [];
    }
    const body = (await res.json()) as {
      elements?: Array<{
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
        tags?: Record<string, string>;
      }>;
    };
    const out: Candidate[] = [];
    // Nicht-kommerzielle office-Typen raus — der Hannover-Testlauf war
    // voll mit Landesbehoerden und Vereinen.
    const NON_COMMERCIAL = new Set([
      "government",
      "religion",
      "association",
      "ngo",
      "political_party",
      "educational_institution",
      "diplomatic",
    ]);
    for (const el of body.elements ?? []) {
      const tags = el.tags ?? {};
      const name = tags.name?.trim();
      if (!name || name.length < 2) continue;
      if (tags.office && NON_COMMERCIAL.has(tags.office)) continue;
      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat === undefined || lon === undefined) continue;
      // bbox-Ecken liegen ausserhalb des Radius — Feinfilter.
      if (haversineKm(geo.origin.lat, geo.origin.lon, lat, lon) > radiusKm) {
        continue;
      }
      const domain = domainFromUrl(tags.website ?? tags["contact:website"]);
      if (!domain) continue; // Zielbild: ohne Website komplett ueberspringen
      out.push({
        name,
        city: tags["addr:city"] ?? null,
        plz: tags["addr:postcode"] ?? null,
        lat,
        lon,
        domain,
        category: sanitizeCategory(
          tags.office ?? (tags.craft ? `craft:${tags.craft}` : null),
        ),
        source: "osm",
      });
    }
    return out;
  } catch (err) {
    hinweise.push(
      `OSM-Kanal fehlgeschlagen (${err instanceof Error ? err.message : String(err)}).`,
    );
    return [];
  }
}

// ---- LLM-Query-Planner (SERP-Kanal) ----------------------------------------
//
// Imitiert einen menschlichen Rechercheur: aus dem vollen ICP-Kontext
// und der Ortsliste im Radius entsteht ein Recherche-Plan aus 12-15
// gezielten Places-Suchen — verschiedene Zielgruppen-Richtungen,
// Synonym-Varianten, verteilt ueber die groesseren Orte. Ein billiger
// LLM-Call (Producer-Modell); Fallback bleibt "Branche Ort".
// Budget-Invariante O1: max 15 Planner-Queries + max 12 Register-
// Lookups = 27 < 30.

const MAX_PLANNED_QUERIES = 15;

const plannedQueriesSchema = yup
  .array()
  .of(yup.string().trim().min(4).max(80).required())
  .min(3)
  .max(MAX_PLANNED_QUERIES);

async function planSerpQueries(
  providers: LlmProviderManager,
  icpText: string,
  ort: string,
  geo: GeoResponse,
  hinweise: string[],
): Promise<string[] | null> {
  if (!providers.getStatus().ready) return null;
  // Groessere Orte zuerst (plz-Anzahl als Proxy), max 12 zur Auswahl.
  const orte = [...geo.places]
    .sort((a, b) => (b.plz?.length ?? 0) - (a.plz?.length ?? 0))
    .slice(0, 12)
    .map((p) => p.name);
  const system =
    "Du planst eine B2B-Lead-Recherche ueber die Google-Places-Suche, " +
    "wie ein Mensch, der systematisch googelt. Erstelle 10 bis " +
    `${MAX_PLANNED_QUERIES} kurze Suchanfragen, die zum Idealkundenprofil ` +
    "(ICP) passen. Regeln fuer Places-Suchen:\n" +
    "- Muster: <Zielgruppen-/Kategoriebegriff> <Ort> (z. B. " +
    '"Immobilienmakler Hannover"). KEINE Attribute wie Mitarbeiterzahl, ' +
    "KEINE Filter-Phrasen, KEINE Anfuehrungszeichen — Places matcht nur " +
    "Kategorie/Name/Ort.\n" +
    "- Verschiedene Zielgruppen-Richtungen des ICP abdecken UND pro " +
    "Zielgruppe Synonym-Varianten ausprobieren (z. B. Steuerkanzlei / " +
    "Steuerberater / Wirtschaftspruefer).\n" +
    "- Die Suchen ueber mehrere der genannten Orte verteilen (groessere " +
    "Orte bevorzugen), nicht alles auf den Zentrums-Ort.\n" +
    "- Ausschluesse im ICP respektieren: danach gar nicht erst suchen.\n" +
    'Antworte NUR als JSON: {"queries": ["...", "..."]}';
  const user =
    `ICP:\n${icpText}\n\nZentrums-Ort: ${ort}\n` +
    `Orte im Radius (nach Groesse): ${orte.join(", ")}`;
  try {
    const raw = await streamToText(
      providers,
      buildMessages(system, user, "serpplan"),
      {
        timeoutMs: 45_000,
        ...(providers.getProducerModelOverride()
          ? { modelOverride: providers.getProducerModelOverride() }
          : {}),
      },
    );
    const parsed = parseJsonObject(raw) as { queries?: unknown } | null;
    const queries = plannedQueriesSchema.validateSync(parsed?.queries ?? [], {
      abortEarly: true,
    });
    return queries && queries.length > 0
      ? [...new Set(queries)].slice(0, MAX_PLANNED_QUERIES)
      : null;
  } catch (err) {
    hinweise.push(
      `Query-Planner fehlgeschlagen (${err instanceof Error ? err.message : String(err)}) — Fallback "Branche Ort".`,
    );
    return null;
  }
}

/** Adresse "Musterstr. 1, 30159 Hannover" → {plz, city}. */
function parseAddress(address: string | undefined): { plz: string | null; city: string | null } {
  if (!address) return { plz: null, city: null };
  const m = /(\b\d{5}\b)\s+([^,]+)/.exec(address);
  if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  const parts = address.split(",");
  const last = parts[parts.length - 1]?.trim();
  return { plz: null, city: last && last.length <= 60 ? last : null };
}

/** Kanal b: valueserp places ueber den Gateway-Proxy — mit fertiger
 *  Query-Liste (vom LLM-Planner oder dem Branche-Ort-Fallback). */
/** Places-Treffer ohne Website — Rohdaten fuer den optionalen
 *  SERP-Website-Nachschlag (nur bei duenner Ausbeute, Budget-gedeckelt). */
interface PlacesHitOhneWebsite {
  name: string;
  city: string | null;
  plz: string | null;
  lat: number | null;
  lon: number | null;
  category: string | null;
  meta: Record<string, unknown> | null;
}

async function fetchSerpCandidates(
  gateway: GatewayClient,
  queries: string[],
  hinweise: string[],
): Promise<{
  candidates: Candidate[];
  queries: string[];
  ohneWebsite: PlacesHitOhneWebsite[];
}> {
  const candidates: Candidate[] = [];
  const ohneWebsite: PlacesHitOhneWebsite[] = [];
  const skippedNames = new Set<string>();
  for (const q of queries) {
    try {
      const body = await gateway.request<{
        places_results?: Array<{
          title?: string;
          address?: string;
          category?: string;
          rating?: number;
          reviews?: number;
          phone?: string;
          gps_coordinates?: { latitude?: number; longitude?: number };
          website?: string;
          link?: string;
        }>;
      }>("/v1/proxy/valueserp", {
        method: "POST",
        body: { q, search_type: "places", num: 20 },
      });
      for (const p of body.places_results ?? []) {
        const name = p.title?.trim();
        if (!name) continue;
        const domain = domainFromUrl(p.website ?? p.link);
        const { plz, city } = parseAddress(p.address);
        const meta: Record<string, unknown> = {};
        if (p.rating !== undefined) meta.rating = p.rating;
        if (p.reviews !== undefined) meta.reviews = p.reviews;
        if (p.phone) meta.phone = p.phone;
        if (!domain) {
          // Zielbild: ohne Website ueberspringen — aber die Treffer
          // merken, damit ein Nachschlag (Schritt 3b) die Website per
          // organischer SERP-Suche aufloesen kann, wenn die Ausbeute
          // sonst zu duenn ist.
          const key = `${name.toLowerCase()}|${city ?? ""}`;
          if (!skippedNames.has(key)) {
            skippedNames.add(key);
            ohneWebsite.push({
              name,
              city,
              plz,
              lat: p.gps_coordinates?.latitude ?? null,
              lon: p.gps_coordinates?.longitude ?? null,
              category: sanitizeCategory(p.category),
              meta: Object.keys(meta).length > 0 ? meta : null,
            });
          }
          continue;
        }
        candidates.push({
          name,
          city,
          plz,
          lat: p.gps_coordinates?.latitude ?? null,
          lon: p.gps_coordinates?.longitude ?? null,
          domain,
          category: sanitizeCategory(p.category),
          meta: Object.keys(meta).length > 0 ? meta : null,
          source: "serp",
        });
      }
    } catch (err) {
      hinweise.push(
        `SERP-Query "${q}" fehlgeschlagen (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }
  return { candidates, queries, ohneWebsite };
}

// ---- SERP-Website-Nachschlag (Backlog v0.1.459) ----------------------------
//
// Places liefert nicht fuer jeden Treffer eine Website. Statt diese
// Firmen pauschal zu verwerfen, wird bei DUENNER Ausbeute (weniger als
// SPARSE_SERP_THRESHOLD Places-Kandidaten mit Website) fuer einen Teil
// der uebersprungenen Treffer eine normale organische SERP-Suche
// "Name Ort" gefahren — gleiches Muster wie der Register-Kanal, mit
// demselben Verzeichnis-Filter. Hartes Budget: O1 (30 SERP-Calls/Scan)
// minus bereits verbrauchter Queries/Lookups, zusaetzlich gedeckelt.

const SPARSE_SERP_THRESHOLD = 10;
const MAX_WEBSITE_FOLLOWUPS = 6;

async function resolveWebsitesViaSerp(
  gateway: GatewayClient,
  hits: PlacesHitOhneWebsite[],
  budget: number,
  hinweise: string[],
): Promise<Candidate[]> {
  const limit = Math.min(hits.length, budget, MAX_WEBSITE_FOLLOWUPS);
  if (limit <= 0) return [];
  const out: Candidate[] = [];
  let versucht = 0;
  for (const hit of hits.slice(0, limit)) {
    versucht++;
    try {
      const body = await gateway.request<{
        organic_results?: Array<{ link?: string; domain?: string }>;
      }>("/v1/proxy/valueserp", {
        method: "POST",
        body: { q: `${hit.name} ${hit.city ?? ""}`.trim(), num: 5 },
      });
      const domain = (body.organic_results ?? [])
        .map((o) => domainFromUrl(o.link ?? o.domain))
        .find((d) => d && !DIRECTORY_DOMAIN_RE.test(d));
      if (!domain) continue;
      out.push({
        name: hit.name,
        city: hit.city,
        plz: hit.plz,
        lat: hit.lat,
        lon: hit.lon,
        domain,
        category: hit.category,
        meta: hit.meta,
        source: "serp",
      });
    } catch {
      hinweise.push(
        `Website-Nachschlag nach ${versucht} Suchen abgebrochen (SERP-Fehler/Quota).`,
      );
      break;
    }
  }
  if (out.length > 0) {
    hinweise.push(
      `Website-Nachschlag: ${out.length} von ${versucht} Places-Treffern ohne Website per SERP-Suche aufgeloest.`,
    );
  }
  return out;
}

// ---- Kanal c (Phase 4): Register-Bestand im Umkreis ------------------------
//
// master-data-Firmen mit Sitzort im Radius, die AVA noch nie verarbeitet
// hat. Website-Ermittlung per normaler SERP-Suche (1 Query/Firma, hartes
// Budget) mit Verzeichnis-Filter — Portale wie Northdata sind nicht die
// Firmen-Website. A8 gilt: ohne aufgeloeste Website kein Kandidat.

const DIRECTORY_DOMAIN_RE =
  /northdata|unternehmensregister|handelsregister|bundesanzeiger|creditreform|dnb\.com|firmenwissen|firmeneintrag|wlw\.de|gelbeseiten|11880|dasoertliche|kununu|linkedin|xing|facebook|instagram|moneyhouse|companyhouse|implisense|genios|websiteprofile|branchenbuch|cylex|yelp|herold|stepstone|indeed|wikipedia|youtube|northd/i;

const MAX_REGISTER_LOOKUPS = 12;

async function fetchRegisterCandidates(
  gateway: GatewayClient,
  ort: string,
  radiusKm: number,
  hinweise: string[],
): Promise<{ candidates: Candidate[]; lookups: number }> {
  let regs: Array<{ companyId: string; name: string; location: string }>;
  try {
    const qs = new URLSearchParams({
      near: ort,
      radiusKm: String(radiusKm),
      limit: String(MAX_REGISTER_LOOKUPS),
    });
    const r = await gateway.request<{
      candidates: Array<{ companyId: string; name: string; location: string }>;
    }>(`/v1/discovery/register-candidates?${qs.toString()}`);
    regs = r.candidates;
  } catch (err) {
    hinweise.push(
      `Register-Kanal uebersprungen (${err instanceof Error ? err.message : String(err)}).`,
    );
    return { candidates: [], lookups: 0 };
  }
  const out: Candidate[] = [];
  let lookups = 0;
  let ohneWebsite = 0;
  for (const reg of regs) {
    lookups++;
    try {
      const body = await gateway.request<{
        organic_results?: Array<{ link?: string; domain?: string }>;
      }>("/v1/proxy/valueserp", {
        method: "POST",
        body: { q: `${reg.name} ${reg.location}`, num: 5 },
      });
      const hit = (body.organic_results ?? [])
        .map((o) => domainFromUrl(o.link ?? o.domain))
        .find((d) => d && !DIRECTORY_DOMAIN_RE.test(d));
      if (!hit) {
        ohneWebsite++;
        continue;
      }
      out.push({
        name: reg.name,
        city: reg.location,
        domain: hit,
        masterCompanyId: reg.companyId,
        source: "register",
      });
    } catch {
      // Quota/Netz — Kanal bricht leise ab, Rest der Quellen laeuft.
      hinweise.push(
        `Register-Kanal nach ${lookups} Website-Lookups abgebrochen (SERP-Fehler/Quota).`,
      );
      break;
    }
  }
  if (ohneWebsite > 0) {
    hinweise.push(
      `${ohneWebsite} Register-Firmen ohne aufloesbare Website uebersprungen.`,
    );
  }
  return { candidates: out, lookups };
}

export async function runDiscoveryScan(
  gateway: GatewayClient,
  providers: LlmProviderManager | null,
  args: ScanArgs,
): Promise<ScanSummary | { error: string }> {
  const hinweise: string[] = [];

  // 1. Ortsgraph.
  let geo: GeoResponse;
  try {
    const qs = new URLSearchParams({
      near: args.ort,
      radiusKm: String(args.radiusKm),
    });
    geo = await gateway.request<GeoResponse>(`/v1/geo/places?${qs.toString()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("404")) {
      return { error: `Ort "${args.ort}" nicht gefunden — Schreibweise pruefen.` };
    }
    return { error: `Ortsaufloesung fehlgeschlagen: ${msg}` };
  }

  // 2. Scan-Start (Quota-Gate).
  let scan: { scanId: string; maxCandidatesPerScan: number };
  try {
    scan = await gateway.request<{ scanId: string; maxCandidatesPerScan: number }>(
      "/v1/discovery/scans",
      { method: "POST", body: { ort: args.ort, radiusKm: args.radiusKm } },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("429")) {
      return { error: "Discovery-Tageslimit erreicht — morgen wieder verfuegbar." };
    }
    return { error: `Scan-Start fehlgeschlagen: ${msg}` };
  }

  // 2b. SERP-Recherche-Plan: LLM-Planner aus dem ICP-Kontext (wie ein
  //     menschlicher Rechercheur), Fallback "Branche Ort". Budget O1:
  //     max 15 Planner-Queries + max 12 Register-Lookups = 27 < 30.
  let queries: string[] = [];
  let queryPlanung: "llm" | "fallback" | "keine" = "keine";
  if (args.icpText && providers) {
    const planned = await planSerpQueries(providers, args.icpText, args.ort, geo, hinweise);
    if (planned) {
      queries = planned;
      queryPlanung = "llm";
    }
  }
  if (queries.length === 0 && args.branchen.length > 0) {
    queries = args.branchen
      .map((b) => b.trim())
      .filter((b) => b.length >= 2)
      .slice(0, MAX_SERP_QUERIES)
      .map((b) => `${b} ${args.ort}`);
    queryPlanung = "fallback";
  }
  if (queries.length === 0) {
    hinweise.push(
      "SERP-Kanal uebersprungen: kein ICP fuer den Query-Planner und keine Branchenbegriffe vorhanden.",
    );
  }

  // 3. Kanaele (parallel).
  const [osm, serp, register] = await Promise.all([
    fetchOsmCandidates(geo, args.radiusKm, hinweise),
    queries.length > 0
      ? fetchSerpCandidates(gateway, queries, hinweise)
      : Promise.resolve({
          candidates: [] as Candidate[],
          queries: [] as string[],
          ohneWebsite: [] as PlacesHitOhneWebsite[],
        }),
    fetchRegisterCandidates(gateway, args.ort, args.radiusKm, hinweise),
  ]);

  // 3b. Website-Nachschlag — nur bei duenner Ausbeute. Budget: O1 laesst
  //     30 SERP-Calls pro Scan zu; Queries + Register-Lookups sind schon
  //     verbraucht, der Rest deckelt den Nachschlag (zusaetzlich hart
  //     auf MAX_WEBSITE_FOLLOWUPS begrenzt).
  if (
    serp.ohneWebsite.length > 0 &&
    serp.candidates.length < SPARSE_SERP_THRESHOLD
  ) {
    const budget = Math.max(0, 30 - serp.queries.length - register.lookups);
    const resolved = await resolveWebsitesViaSerp(
      gateway,
      serp.ohneWebsite,
      budget,
      hinweise,
    );
    serp.candidates.push(...resolved);
    const rest = serp.ohneWebsite.length - resolved.length;
    if (rest > 0) {
      hinweise.push(
        `${rest} Places-Treffer ohne Website uebersprungen (Zielbild: nur Firmen mit Website).`,
      );
    }
  } else if (serp.ohneWebsite.length > 0) {
    hinweise.push(
      `${serp.ohneWebsite.length} Places-Treffer ohne Website uebersprungen (Ausbeute ausreichend, kein Nachschlag noetig).`,
    );
  }

  // 4. Lokal per Domain deduplizieren (Domain = Discovery-ID),
  //    Naehe-priorisieren fuers Cap.
  const merged: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of [...osm, ...serp.candidates, ...register.candidates]) {
    if (seen.has(c.domain)) continue;
    seen.add(c.domain);
    merged.push(c);
  }
  merged.sort((a, b) => {
    const da =
      a.lat != null && a.lon != null
        ? haversineKm(geo.origin.lat, geo.origin.lon, a.lat, a.lon)
        : Number.MAX_SAFE_INTEGER;
    const db =
      b.lat != null && b.lon != null
        ? haversineKm(geo.origin.lat, geo.origin.lon, b.lat, b.lon)
        : Number.MAX_SAFE_INTEGER;
    return da - db;
  });
  const capped = merged.slice(0, scan.maxCandidatesPerScan);
  if (merged.length > capped.length) {
    hinweise.push(
      `${merged.length - capped.length} Kandidaten wegen Scan-Cap (${scan.maxCandidatesPerScan}) nicht uebertragen — die naechstgelegenen wurden bevorzugt.`,
    );
  }

  // 5. Batches ans Gateway.
  let added = 0;
  let updated = 0;
  let cappedRemote = 0;
  let bereitsBekannt = 0;
  for (let i = 0; i < capped.length; i += BATCH_SIZE) {
    const batch = capped.slice(i, i + BATCH_SIZE);
    try {
      const r = await gateway.request<{
        added: number;
        updated: number;
        capped: number;
        known: Record<string, string>;
      }>(`/v1/discovery/scans/${scan.scanId}/candidates`, {
        method: "POST",
        body: { candidates: batch },
      });
      added += r.added;
      updated += r.updated;
      cappedRemote += r.capped;
      bereitsBekannt += Object.keys(r.known).length;
    } catch (err) {
      hinweise.push(
        `Kandidaten-Batch ${i / BATCH_SIZE + 1} fehlgeschlagen (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  return {
    scanId: scan.scanId,
    origin: { name: geo.origin.name, kreis: geo.origin.kreis },
    orteImRadius: geo.places.length,
    quellen: {
      osm: osm.length,
      serp: serp.candidates.length,
      register: register.candidates.length,
    },
    kandidatenGesamt: capped.length,
    added,
    updated,
    bereitsBekannt,
    capped: cappedRemote,
    serpQueries: serp.queries,
    queryPlanung,
    hinweise,
  };
}
