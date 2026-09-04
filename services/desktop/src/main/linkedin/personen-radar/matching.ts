// Personen-Radar PR2 (PLAN §8.1) — Person→Firma-Matching-Kaskade.
//
// Stufe 1 (hart):   aktuelle Positionen (Berufserfahrung!) →
//                   LinkedIn-Unternehmensseite → deren Website-Feld
//                   (FIRMEN-Angabe, nie das Profil-Website-Feld) →
//                   domainFromUrl = Discovery-ID.
// Stufe 2 (mittel): Firmenname aus Position/Headline → SERP-Suche
//                   nach der Website (Verzeichnis-Filter) — nur bei
//                   eindeutigem Treffer.
// Stufe 3:          KEIN Beleg → KEIN Raten. Person landet in der
//                   "ungeklaert"-Liste (kurze TTL).
//
// Mehrere aktuelle Positionen sind der NORMALFALL — alle werden
// aufgeloest, eine Person darf auf mehrere Firmen zeigen.

import type { GatewayClient } from "../../agent/gateway-client";
import { domainFromUrl } from "../../discovery/scan";
import {
  fetchCompanyWebsite,
  fetchCurrentPositions,
  type EngagementActorConfig,
  type Engager,
} from "./engagement";

// Zwilling von discovery/scan.ts DIRECTORY_DOMAIN_RE (dort modul-privat).
const DIRECTORY_RE =
  /northdata|unternehmensregister|handelsregister|bundesanzeiger|creditreform|dnb\.com|firmenwissen|wlw\.de|gelbeseiten|11880|dasoertliche|kununu|linkedin|xing|facebook|instagram|wikipedia|youtube/i;

export interface FirmenMatch {
  konfidenz: "hart" | "mittel";
  domain: string;
  companyName: string;
  rolle: string | null;
}

export interface KaskadenErgebnis {
  matches: FirmenMatch[];
  /** Positionen, die nicht aufloesbar waren (Transparenz). */
  unaufgeloest: string[];
  kosteneinheiten: number;
}

/** Headline "Rolle bei Firma" / "Rolle @ Firma" → Firmenname. */
function companyFromHeadline(headline: string | null): string | null {
  if (!headline) return null;
  // v0.1.518 — "at" ergaenzt (englische Headlines: "… Manager at KUNCKE
  // KONZEPT" lief vorher ins Leere) und Satzfortsetzungen abgeschnitten
  // ("bei SalesDone fuer begeisterte Kunden" → "SalesDone"; vorher ging
  // der ganze Satzrest als Firmenname in die SERP-Suche).
  const m = /(?:\bbei\b|\bat\b|@)\s*([^|•·,;–—-]{3,60})/i.exec(headline);
  const roh = m?.[1]?.trim();
  if (!roh) return null;
  const name = roh
    .split(/\s+(?:für|fuer|for|mit|with|und|and|als|as|in|im|wo|where|the)\s+/i)[0]
    ?.trim();
  return name && name.length >= 3 ? name : null;
}

export async function resolveEngagerCompanies(args: {
  key: string;
  actors: EngagementActorConfig;
  gateway: GatewayClient;
  engager: Engager;
  signal?: AbortSignal;
  /** v0.1.519 — LLM-Extraktion des Arbeitgebers aus der Headline
   *  (User-Direktive: Heuristik deckt "zig tausende" Headline-Formen
   *  nicht ab). Optional; ohne Modell greift die Heuristik. */
  firmaAusHeadline?: (headline: string) => Promise<string | null>;
}): Promise<KaskadenErgebnis> {
  const out: FirmenMatch[] = [];
  const unaufgeloest: string[] = [];
  let kosten = 0;
  const seenDomains = new Set<string>();

  // Stufe 1: Profil-Details → aktuelle Positionen.
  let positions: Awaited<ReturnType<typeof fetchCurrentPositions>>["positions"] = [];
  try {
    const r = await fetchCurrentPositions(
      args.key,
      args.actors,
      args.engager.profileUrl,
      args.signal,
    );
    positions = r.positions;
    kosten += r.kosteneinheiten;
  } catch (err) {
    // AUTH/CREDITS hochreichen, Rest: auf Stufe 2 zurueckfallen.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("APIFY_")) throw err;
    unaufgeloest.push(`Profil-Details: ${msg.slice(0, 80)}`);
  }

  for (const pos of positions.slice(0, 3)) {
    if (pos.companyLinkedinUrl) {
      try {
        const c = await fetchCompanyWebsite(
          args.key,
          args.actors,
          pos.companyLinkedinUrl,
          args.signal,
        );
        kosten += c.kosteneinheiten;
        const domain = domainFromUrl(c.website);
        if (domain && !DIRECTORY_RE.test(domain) && !seenDomains.has(domain)) {
          seenDomains.add(domain);
          out.push({
            konfidenz: "hart",
            domain,
            companyName: c.name ?? pos.companyName ?? domain,
            rolle: pos.position,
          });
          continue;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("APIFY_")) throw err;
      }
    }
    // Stufe 2 fuer diese Position (Freitext-Arbeitgeber ohne Page).
    const name = pos.companyName;
    if (name) {
      const domain = await serpDomainLookup(args.gateway, name, args.signal);
      if (domain && !seenDomains.has(domain)) {
        seenDomains.add(domain);
        out.push({ konfidenz: "mittel", domain, companyName: name, rolle: pos.position });
      } else if (!domain) {
        unaufgeloest.push(name);
      }
    }
  }

  // Kein Profil-Detail / nichts gefunden → Headline als letzter
  // Stufe-2-Versuch.
  if (out.length === 0) {
    let name: string | null = null;
    if (args.firmaAusHeadline && args.engager.headline) {
      try {
        name = await args.firmaAusHeadline(args.engager.headline);
      } catch {
        name = null;
      }
    }
    if (!name) name = companyFromHeadline(args.engager.headline);
    if (name) {
      const domain = await serpDomainLookup(args.gateway, name, args.signal);
      if (domain) {
        out.push({ konfidenz: "mittel", domain, companyName: name, rolle: args.engager.headline });
      } else {
        unaufgeloest.push(name);
      }
    }
  }
  return { matches: out, unaufgeloest, kosteneinheiten: kosten };
}

/** Firmenname → Website-Domain via SERP (1 Query, Verzeichnis-Filter,
 *  nur wenn das TOP-Ergebnis kein Verzeichnis ist — konservativ). */
async function serpDomainLookup(
  gateway: GatewayClient,
  companyName: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const body = await gateway.request<{
      organic_results?: Array<{ link?: string; domain?: string }>;
    }>("/v1/proxy/valueserp", {
      method: "POST",
      body: { q: `"${companyName}" website`, num: 5 },
      signal,
    });
    const domains = (body.organic_results ?? [])
      .map((o) => domainFromUrl(o.link ?? o.domain))
      .filter((d): d is string => !!d && !DIRECTORY_RE.test(d));
    // Konservativ: nur wenn das beste Nicht-Verzeichnis-Ergebnis auch
    // wirklich vorn steht (Position 1 oder 2 der Gesamtliste).
    const all = (body.organic_results ?? []).map((o) => domainFromUrl(o.link ?? o.domain));
    const first = domains[0] ?? null;
    if (!first) return null;
    const idx = all.indexOf(first);
    return idx >= 0 && idx <= 1 ? first : null;
  } catch {
    return null;
  }
}
