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

import type { GatewayClient } from "../agent/gateway-client";

const OVERPASS_URL =
  process.env.AVA_OVERPASS_URL ?? "https://overpass-api.de/api/interpreter";
const MAX_SERP_QUERIES = 8;
const BATCH_SIZE = 100;

export interface ScanArgs {
  ort: string;
  radiusKm: number;
  /** Branchenbegriffe fuer den SERP-Kanal ("IT-Dienstleister", …).
   *  Leer → SERP-Kanal wird uebersprungen (nur OSM). */
  branchen: string[];
}

export interface ScanSummary {
  scanId: string;
  origin: { name: string; kreis: string };
  orteImRadius: number;
  quellen: { osm: number; serp: number };
  kandidatenGesamt: number;
  added: number;
  updated: number;
  bereitsBekannt: number;
  capped: number;
  serpQueries: string[];
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
  source: "osm" | "serp";
}

interface GeoResponse {
  origin: { name: string; kreis: string; lat: number; lon: number };
  places: Array<{ name: string }>;
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
function domainFromUrl(url: string | undefined | null): string | null {
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
        category: tags.office ?? (tags.craft ? `craft:${tags.craft}` : null),
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

/** Adresse "Musterstr. 1, 30159 Hannover" → {plz, city}. */
function parseAddress(address: string | undefined): { plz: string | null; city: string | null } {
  if (!address) return { plz: null, city: null };
  const m = /(\b\d{5}\b)\s+([^,]+)/.exec(address);
  if (m?.[1] && m[2]) return { plz: m[1], city: m[2].trim() };
  const parts = address.split(",");
  const last = parts[parts.length - 1]?.trim();
  return { plz: null, city: last && last.length <= 60 ? last : null };
}

/** Kanal b: valueserp places ueber den Gateway-Proxy. */
async function fetchSerpCandidates(
  gateway: GatewayClient,
  ort: string,
  branchen: string[],
  hinweise: string[],
): Promise<{ candidates: Candidate[]; queries: string[] }> {
  const queries = branchen
    .map((b) => b.trim())
    .filter((b) => b.length >= 2)
    .slice(0, MAX_SERP_QUERIES)
    .map((b) => `${b} ${ort}`);
  const candidates: Candidate[] = [];
  let ohneWebsite = 0;
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
        if (!domain) {
          ohneWebsite++; // Zielbild: ohne Website komplett ueberspringen
          continue;
        }
        const { plz, city } = parseAddress(p.address);
        const meta: Record<string, unknown> = {};
        if (p.rating !== undefined) meta.rating = p.rating;
        if (p.reviews !== undefined) meta.reviews = p.reviews;
        if (p.phone) meta.phone = p.phone;
        candidates.push({
          name,
          city,
          plz,
          lat: p.gps_coordinates?.latitude ?? null,
          lon: p.gps_coordinates?.longitude ?? null,
          domain,
          category: p.category ?? null,
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
  if (ohneWebsite > 0) {
    hinweise.push(
      `${ohneWebsite} Places-Treffer ohne Website uebersprungen (Zielbild: nur Firmen mit Website).`,
    );
  }
  return { candidates, queries };
}

export async function runDiscoveryScan(
  gateway: GatewayClient,
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

  // 3. Kanaele (parallel).
  const [osm, serp] = await Promise.all([
    fetchOsmCandidates(geo, args.radiusKm, hinweise),
    args.branchen.length > 0
      ? fetchSerpCandidates(gateway, args.ort, args.branchen, hinweise)
      : Promise.resolve({ candidates: [] as Candidate[], queries: [] as string[] }),
  ]);
  if (args.branchen.length === 0) {
    hinweise.push(
      "SERP-Kanal uebersprungen: keine Branchenbegriffe uebergeben und keine im Nutzerprofil hinterlegt.",
    );
  }

  // 4. Lokal per Domain deduplizieren (Domain = Discovery-ID),
  //    Naehe-priorisieren fuers Cap.
  const merged: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of [...osm, ...serp.candidates]) {
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
    quellen: { osm: osm.length, serp: serp.candidates.length },
    kandidatenGesamt: capped.length,
    added,
    updated,
    bereitsBekannt,
    capped: cappedRemote,
    serpQueries: serp.queries,
    hinweise,
  };
}
