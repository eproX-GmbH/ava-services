// LinkedIn-Beobachter Phase L5 — entity linking against master data.
//
// Walks every post that has an extracted signal but no entity-link pass
// yet, and turns the L3/L4 raw strings (`entities.companies[]`,
// `entities.people[]`, `detected_logos[]`, surfaced actors) into
// references against the user's master-data company catalogue and the
// per-company contacts list.
//
// Single-flight: relies on the extractor's `running` flag — the caller
// in extractor.ts gates phase 3 inside the same drain. The drain is
// sequential per post; we don't fan out gateway calls in parallel.
//
// Networking: read-only `GET /v1/companies/search` and
// `GET /v1/companies/{id}/contacts`. We DO NOT push LinkedIn data to
// the gateway. Both endpoints are part of the existing master-data
// flow the user already runs.

import type { GatewayClient } from "../agent/gateway-client";
import {
  getDb,
  loadEntityLinkCandidate,
  lookupCacheGet,
  lookupCachePut,
  nextPendingEntityLinkPosts,
  recordEntityLinks,
  resetUnresolvedLinks,
  entityLinkStats,
  type EntityLinkAlternate,
  type EntityLinkInput,
} from "./db";

export interface LinkerStatus {
  running: boolean;
  pendingPosts: number;
  linkedPosts: number;
  knownCompanies: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  lastRunAt: number | null;
  lastError: string | null;
}

let gatewayRef: GatewayClient | null = null;
let running = false;
let lastRunAt: number | null = null;
let lastError: string | null = null;

export function attachLinkerGateway(gateway: GatewayClient): void {
  gatewayRef = gateway;
}

export function isLinking(): boolean {
  return running;
}

export function getLinkerStatus(): LinkerStatus {
  return {
    running,
    pendingPosts: 0,
    linkedPosts: 0,
    knownCompanies: 0,
    matched: 0,
    ambiguous: 0,
    unmatched: 0,
    lastRunAt,
    lastError,
  };
}

export async function linkerStatusSnapshot(): Promise<LinkerStatus> {
  try {
    const db = await getDb();
    const stats = await entityLinkStats(db);
    return {
      running,
      pendingPosts: stats.pendingPosts,
      linkedPosts: stats.linkedPosts,
      knownCompanies: stats.knownCompanies,
      matched: stats.matched,
      ambiguous: stats.ambiguous,
      unmatched: stats.unmatched,
      lastRunAt,
      lastError,
    };
  } catch (err) {
    return {
      running,
      pendingPosts: 0,
      linkedPosts: 0,
      knownCompanies: 0,
      matched: 0,
      ambiguous: 0,
      unmatched: 0,
      lastRunAt,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- string utilities --------------------------------------------------

const COMPANY_SUFFIX_RE =
  /\b(gmbh|ag|se|ug|kg|kgaa|ohg|ev|gbr|co\.?\s*kg|mbh|inc\.?|ltd\.?|llc|sa|sas|sarl|nv|bv|spa|srl|plc|gesellschaft|holding|group|gruppe)\b/giu;

/** Cache-key normalisation: lowercase, strip trademark/legal suffixes, and
 *  collapse whitespace. We deliberately keep the ORIGINAL string as
 *  source_value so the UI can show the LLM's wording. */
export function normalizeCompanyQuery(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " und ")
    .replace(COMPANY_SUFFIX_RE, " ")
    .replace(/[.,;:!?'"`(){}\[\]/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tiny token-set ratio: |A∩B| / |A∪B| over whitespace tokens, lowercased.
 *  Returns 0 when either side is empty. */
export function tokenSetRatio(a: string, b: string): number {
  const ta = new Set(
    a
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
  const tb = new Set(
    b
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function extractProfileSlug(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/in\/([^/?#]+)/i);
    return m && m[1] ? decodeURIComponent(m[1]).toLowerCase() : null;
  } catch {
    return null;
  }
}

// ---- gateway lookups ---------------------------------------------------

interface SearchHit {
  companyId: string;
  name: string;
  location?: string;
}

async function searchCompanies(
  query: string,
  signal?: AbortSignal,
): Promise<EntityLinkAlternate[]> {
  if (!gatewayRef) return [];
  const data = await gatewayRef.request<{
    items?: Array<Record<string, unknown>>;
  }>("/v1/companies/search", {
    query: { q: query, limit: 5 },
    signal,
  });
  const items = (data.items ?? []).filter(
    (i): i is Record<string, unknown> & { companyId: string; name: string } =>
      typeof i?.companyId === "string" && typeof i?.name === "string",
  );
  return items.map<EntityLinkAlternate>((i) => ({
    companyId: i.companyId,
    name: i.name,
    score: 0, // filled by scoreHits()
  }));
}

interface ContactRow {
  contactId: string;
  display: string;
  linkedinUrl: string | null;
}

async function fetchContacts(
  companyId: string,
  signal?: AbortSignal,
): Promise<ContactRow[]> {
  if (!gatewayRef) return [];
  try {
    const data = await gatewayRef.request<Record<string, unknown>>(
      `/v1/companies/${encodeURIComponent(companyId)}/contacts`,
      { signal },
    );
    // Defensive: contact aggregate shape is loosely-typed here. We try a
    // few common keys (boardMembers, contacts, items) and pull display
    // names + linkedin URLs out of whatever shape the producer returns.
    const collected: ContactRow[] = [];
    const candidates: unknown[] = [];
    for (const key of ["contacts", "items", "boardMembers", "people"]) {
      const arr = (data as Record<string, unknown>)[key];
      if (Array.isArray(arr)) candidates.push(...arr);
    }
    for (const c of candidates) {
      if (!c || typeof c !== "object") continue;
      const o = c as Record<string, unknown>;
      const idRaw =
        o.contactId ?? o.id ?? o.personId ?? o.uuid ?? o.contact_id ?? null;
      const id = typeof idRaw === "string" ? idRaw : null;
      if (!id) continue;
      const display =
        (typeof o.displayName === "string" && o.displayName) ||
        (typeof o.name === "string" && o.name) ||
        (typeof o.fullName === "string" && o.fullName) ||
        [
          typeof o.firstName === "string" ? o.firstName : "",
          typeof o.lastName === "string" ? o.lastName : "",
        ]
          .filter(Boolean)
          .join(" ")
          .trim();
      if (!display) continue;
      const li =
        (typeof o.linkedinUrl === "string" && o.linkedinUrl) ||
        (typeof o.linkedin === "string" && o.linkedin) ||
        (typeof o.linkedInUrl === "string" && o.linkedInUrl) ||
        null;
      collected.push({ contactId: id, display, linkedinUrl: li });
    }
    return collected;
  } catch {
    // Producer endpoint might not be live yet — treat as empty contact
    // list rather than failing the post.
    return [];
  }
}

// ---- scoring -----------------------------------------------------------

interface ScoredCompanyOutcome {
  resolution: "matched" | "ambiguous" | "unmatched";
  matchScore: number | null;
  matchReason: string | null;
  matchedCompanyId: string | null;
  matchedCompanyName: string | null;
  alternates: EntityLinkAlternate[] | null;
}

function scoreHits(
  rawCandidate: string,
  hits: EntityLinkAlternate[],
): ScoredCompanyOutcome {
  if (hits.length === 0) {
    return {
      resolution: "unmatched",
      matchScore: null,
      matchReason: "Keine Treffer in Stammdaten",
      matchedCompanyId: null,
      matchedCompanyName: null,
      alternates: null,
    };
  }
  const candNorm = rawCandidate.trim().toLowerCase();
  const scored: EntityLinkAlternate[] = hits.map((h) => {
    const nameNorm = h.name.trim().toLowerCase();
    let score = 0;
    if (nameNorm === candNorm) score = 1.0;
    else score = tokenSetRatio(rawCandidate, h.name);
    return { ...h, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.score < 0.85) {
    return {
      resolution: "unmatched",
      matchScore: top?.score ?? null,
      matchReason: "Kein Treffer ≥ 0.85",
      matchedCompanyId: null,
      matchedCompanyName: null,
      alternates: null,
    };
  }
  const close = scored.filter((s) => s.score >= 0.85 && top.score - s.score <= 0.1);
  if (close.length > 1) {
    return {
      resolution: "ambiguous",
      matchScore: top.score,
      matchReason: `Mehrdeutig (${close.length} Treffer)`,
      matchedCompanyId: null,
      matchedCompanyName: null,
      alternates: scored.slice(0, 5),
    };
  }
  const reason = top.score === 1.0 ? "Exakter Name" : `Fuzzy ${top.score.toFixed(2)}`;
  return {
    resolution: "matched",
    matchScore: top.score,
    matchReason: reason,
    matchedCompanyId: top.companyId,
    matchedCompanyName: top.name,
    alternates: null,
  };
}

// ---- main drain --------------------------------------------------------

const MAX_CANDIDATES_PER_POST = 30;

export interface DrainEntityLinksOpts {
  limit?: number;
  signal?: AbortSignal;
  /** Manual run from the Settings button: also re-link posts that
   *  previously resolved to ambiguous/unmatched, in case the user has
   *  imported new master-data companies since. Sticky-matched posts
   *  are left alone. */
  manual?: boolean;
}

export async function drainEntityLinks(
  opts: DrainEntityLinksOpts = {},
): Promise<LinkerStatus> {
  if (running) return await linkerStatusSnapshot();
  if (!gatewayRef) {
    // No gateway wired yet (e.g. user not signed in). Skip silently.
    return await linkerStatusSnapshot();
  }
  running = true;
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const signal = opts.signal;
  let firstError: string | null = null;

  try {
    const db = await getDb();
    if (opts.manual === true) {
      try {
        await resetUnresolvedLinks(db);
      } catch (err) {
        console.warn(
          "[linkedin/linker] reset unresolved failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    const queue = await nextPendingEntityLinkPosts(db, limit);
    for (const postUrn of queue) {
      if (signal?.aborted) break;
      try {
        await linkOnePost(postUrn, signal);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.message === "aborted")
        ) {
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (!firstError) firstError = msg;
        // Best-effort: stamp the post anyway so we don't loop on it.
        try {
          await recordEntityLinks(db, postUrn, []);
        } catch {
          // ignore
        }
      }
    }
    lastError = firstError;
    lastRunAt = Date.now();
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    lastRunAt = Date.now();
  } finally {
    running = false;
  }
  return await linkerStatusSnapshot();
}

async function linkOnePost(
  postUrn: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const db = await getDb();
  const cand = await loadEntityLinkCandidate(db, postUrn);
  if (!cand) {
    await recordEntityLinks(db, postUrn, []);
    return;
  }

  const links: EntityLinkInput[] = [];
  let candidatesLeft = MAX_CANDIDATES_PER_POST;

  // 1. Company-typed candidates (signal_company + logo). Dedupe by
  //    normalised cache key BUT keep one row per (sourceKind,
  //    sourceValue) so the UI can distinguish "BMW from text" vs
  //    "BMW from logo".
  type CompanyCand = {
    sourceKind: "signal_company" | "logo";
    sourceValue: string;
  };
  const companyCands: CompanyCand[] = [];
  for (const c of cand.signalCompanies) {
    if (typeof c !== "string" || !c.trim()) continue;
    companyCands.push({ sourceKind: "signal_company", sourceValue: c.trim() });
  }
  for (const c of cand.detectedLogos) {
    if (typeof c !== "string" || !c.trim()) continue;
    companyCands.push({ sourceKind: "logo", sourceValue: c.trim() });
  }

  const matchedCompanyIds: string[] = [];
  for (const c of companyCands) {
    if (signal?.aborted) break;
    if (candidatesLeft-- <= 0) break;
    const norm = normalizeCompanyQuery(c.sourceValue);
    if (!norm) {
      links.push(unmatchedLink(c.sourceKind, c.sourceValue, "Leerer Suchstring"));
      continue;
    }
    let hits = await lookupCacheGet(db, norm);
    if (!hits) {
      try {
        hits = await searchCompanies(norm, signal);
        await lookupCachePut(db, norm, hits);
      } catch (err) {
        if (
          err instanceof Error &&
          (err.name === "AbortError" || err.message === "aborted")
        ) {
          throw err;
        }
        console.warn(
          "[linkedin/linker] company search failed:",
          err instanceof Error ? err.message : String(err),
        );
        links.push(
          unmatchedLink(
            c.sourceKind,
            c.sourceValue,
            "Gateway-Suche fehlgeschlagen",
          ),
        );
        continue;
      }
    }
    const outcome = scoreHits(c.sourceValue, hits);
    links.push({
      sourceKind: c.sourceKind,
      sourceValue: c.sourceValue,
      resolution: outcome.resolution,
      matchScore: outcome.matchScore,
      matchReason: outcome.matchReason,
      masterCompanyId: outcome.matchedCompanyId,
      masterCompanyName: outcome.matchedCompanyName,
      contactId: null,
      contactDisplay: null,
      actorUrn: null,
      alternates: outcome.alternates,
    });
    if (outcome.resolution === "matched" && outcome.matchedCompanyId) {
      if (!matchedCompanyIds.includes(outcome.matchedCompanyId)) {
        matchedCompanyIds.push(outcome.matchedCompanyId);
      }
    }
  }

  // 2. Build the contact pool: every contact for every matched company.
  //    Hit fetchContacts at most once per matched company.
  const contactPool: Array<{
    companyId: string;
    companyName: string;
    contact: ContactRow;
  }> = [];
  for (const cid of matchedCompanyIds) {
    if (signal?.aborted) break;
    const rows = await fetchContacts(cid, signal);
    const companyName =
      links.find((l) => l.masterCompanyId === cid)?.masterCompanyName ?? "";
    for (const r of rows) {
      contactPool.push({ companyId: cid, companyName, contact: r });
    }
  }

  // 3. Person-typed candidates: match against contactPool. Multi-company
  //    matches → ambiguous.
  for (const p of cand.signalPeople) {
    if (signal?.aborted) break;
    if (candidatesLeft-- <= 0) break;
    if (typeof p !== "string" || !p.trim()) continue;
    const value = p.trim();
    const matches = contactPool
      .map((cp) => ({
        cp,
        score:
          cp.contact.display.toLowerCase() === value.toLowerCase()
            ? 1.0
            : tokenSetRatio(value, cp.contact.display),
      }))
      .filter((m) => m.score >= 0.85)
      .sort((a, b) => b.score - a.score);
    if (matches.length === 0) {
      links.push(unmatchedLink("signal_person", value, "Kein Kontakt-Treffer"));
      continue;
    }
    const distinctCompanies = new Set(matches.map((m) => m.cp.companyId));
    const top0 = matches[0];
    if (!top0) continue;
    if (distinctCompanies.size > 1) {
      links.push({
        sourceKind: "signal_person",
        sourceValue: value,
        resolution: "ambiguous",
        matchScore: top0.score,
        matchReason: `Mehrdeutig (${distinctCompanies.size} Firmen)`,
        masterCompanyId: null,
        masterCompanyName: null,
        contactId: null,
        contactDisplay: null,
        actorUrn: null,
        alternates: matches.slice(0, 5).map((m) => ({
          companyId: m.cp.companyId,
          name: `${m.cp.contact.display} (${m.cp.companyName})`,
          score: m.score,
        })),
      });
      continue;
    }
    links.push({
      sourceKind: "signal_person",
      sourceValue: value,
      resolution: "matched",
      matchScore: top0.score,
      matchReason:
        top0.score === 1.0 ? "Exakter Name" : `Fuzzy ${top0.score.toFixed(2)}`,
      masterCompanyId: top0.cp.companyId,
      masterCompanyName: top0.cp.companyName,
      contactId: top0.cp.contact.contactId,
      contactDisplay: top0.cp.contact.display,
      actorUrn: null,
      alternates: null,
    });
  }

  // 4. Surfaced actors → always recorded as 'matched' with actorUrn,
  //    plus optional contact match (slug or name).
  for (const a of cand.surfacedActors) {
    if (signal?.aborted) break;
    if (candidatesLeft-- <= 0) break;
    const slug = extractProfileSlug(a.profileUrl);
    let contactId: string | null = null;
    let contactDisplay: string | null = null;
    let companyId: string | null = null;
    let companyName: string | null = null;
    let score: number | null = null;
    let reason = "LinkedIn-Akteur";

    // First try slug match.
    if (slug) {
      for (const cp of contactPool) {
        const cs = extractProfileSlug(cp.contact.linkedinUrl);
        if (cs && cs === slug) {
          contactId = cp.contact.contactId;
          contactDisplay = cp.contact.display;
          companyId = cp.companyId;
          companyName = cp.companyName;
          score = 1.0;
          reason = "LinkedIn-URL";
          break;
        }
      }
    }
    // Fallback: display-name match against contact pool.
    if (!contactId) {
      const matches = contactPool
        .map((cp) => ({
          cp,
          score:
            cp.contact.display.toLowerCase() === a.displayName.toLowerCase()
              ? 1.0
              : tokenSetRatio(a.displayName, cp.contact.display),
        }))
        .filter((m) => m.score >= 0.85)
        .sort((a, b) => b.score - a.score);
      const top = matches[0];
      if (
        top &&
        (matches.length === 1 ||
          new Set(matches.map((m) => m.cp.companyId)).size === 1)
      ) {
        contactId = top.cp.contact.contactId;
        contactDisplay = top.cp.contact.display;
        companyId = top.cp.companyId;
        companyName = top.cp.companyName;
        score = top.score;
        reason =
          top.score === 1.0 ? "Exakter Name" : `Fuzzy ${top.score.toFixed(2)}`;
      }
    }
    links.push({
      sourceKind: "actor",
      sourceValue: a.displayName,
      resolution: "matched",
      matchScore: score,
      matchReason: reason,
      masterCompanyId: companyId,
      masterCompanyName: companyName,
      contactId,
      contactDisplay,
      actorUrn: a.actorUrn,
      alternates: null,
    });
  }

  await recordEntityLinks(db, postUrn, links);
}

function unmatchedLink(
  sourceKind: "signal_company" | "signal_person" | "logo" | "actor",
  sourceValue: string,
  reason: string,
): EntityLinkInput {
  return {
    sourceKind,
    sourceValue,
    resolution: "unmatched",
    matchScore: null,
    matchReason: reason,
    masterCompanyId: null,
    masterCompanyName: null,
    contactId: null,
    contactDisplay: null,
    actorUrn: null,
    alternates: null,
  };
}
