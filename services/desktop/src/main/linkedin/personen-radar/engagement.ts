// Personen-Radar PR1 (PLAN_LINKEDIN_WATCHLIST.md §8) — Engagement-Adapter.
//
// Andere Actor-Familie als die Watchlist (live geprueft 2026-08-31):
//   harvestapi/linkedin-post-reactions  {posts: string[], maxItems}
//     → Item {reactionType, actor{name, linkedinUrl, position}, postId}
//   harvestapi/linkedin-post-comments   (analog, Kommentar-Text)
//   harvestapi/linkedin-profile-scraper {queries: string[]}
//     → Item {experience[{companyName, companyLinkedinUrl, position,
//       endDate?}], headline, ...}  ($4/1000 — teuerster Schritt!)
//   harvestapi/linkedin-company         {companies: string[]}
//     → Item {website, name, universalName, linkedinUrl}
//
// Alle Mappings tolerant (kaputte Items -> ueberspringen), Fehler
// APIFY_AUTH/CREDITS hart hochgereicht (Muster Watchlist-Adapter).

import { normalizeLinkedInProfileUrl } from "../watchlist/normalize";

const APIFY_API = "https://api.apify.com/v2";
const RUN_TIMEOUT_MS = 5 * 60_000;

export interface EngagementActorConfig {
  postReactionsActorId: string;
  postCommentsActorId: string;
  profileActorId: string;
  companyActorId: string;
}

export const ENGAGEMENT_DEFAULT_ACTORS: EngagementActorConfig = {
  postReactionsActorId: "harvestapi~linkedin-post-reactions",
  postCommentsActorId: "harvestapi~linkedin-post-comments",
  profileActorId: "harvestapi~linkedin-profile-scraper",
  companyActorId: "harvestapi~linkedin-company",
};

export interface Engager {
  profileUrl: string;
  name: string | null;
  /** Headline ("Rolle bei Firma") — Stufe-2-Signal der Kaskade. */
  headline: string | null;
  activityType: "reaction" | "comment";
  reactionType: string | null;
  commentText: string | null;
  postUrl: string;
}

export interface CurrentPosition {
  companyName: string | null;
  companyLinkedinUrl: string | null;
  position: string | null;
}

type Raw = Record<string, unknown>;
const asObj = (v: unknown): Raw | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : null;
const asStr = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
const pickStr = (o: Raw | null, ...keys: string[]): string | null => {
  if (!o) return null;
  for (const k of keys) {
    const s = asStr(o[k]);
    if (s) return s;
  }
  return null;
};

async function runActor(
  key: string,
  actorId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const url =
    `${APIFY_API}/acts/${encodeURIComponent(actorId)}` +
    `/run-sync-get-dataset-items?token=${encodeURIComponent(key)}&format=json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: signal ?? AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("APIFY_AUTH: Token ungueltig oder abgelaufen.");
  }
  if (res.status === 402) {
    throw new Error("APIFY_CREDITS: Apify-Guthaben aufgebraucht.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apify ${actorId}: HTTP ${res.status} ${body.slice(0, 140)}`);
  }
  const json: unknown = await res.json();
  return Array.isArray(json) ? json : [];
}

/** Engager (Reaktionen + Kommentare) eines Posts holen. */
export async function fetchPostEngagement(
  key: string,
  actors: EngagementActorConfig,
  postUrl: string,
  maxItemsPerPost: number,
  signal?: AbortSignal,
): Promise<{ engager: Engager[]; kosteneinheiten: number }> {
  const out: Engager[] = [];
  let items = 0;
  const laeufe: Array<{ actorId: string; kind: "reaction" | "comment" }> = [
    { actorId: actors.postReactionsActorId, kind: "reaction" },
  ];
  if (actors.postCommentsActorId.trim()) {
    laeufe.push({ actorId: actors.postCommentsActorId, kind: "comment" });
  }
  for (const lauf of laeufe) {
    const rows = await runActor(
      key,
      lauf.actorId,
      { posts: [postUrl], maxItems: maxItemsPerPost },
      signal,
    );
    items += rows.length;
    for (const raw of rows) {
      const o = asObj(raw);
      if (!o) continue;
      const actor = asObj(o.actor) ?? asObj(o.author);
      const profileUrl = normalizeLinkedInProfileUrl(
        pickStr(actor, "linkedinUrl", "profileUrl", "url"),
      );
      if (!profileUrl) continue; // ohne Profil kein Kandidat
      out.push({
        profileUrl,
        name: pickStr(actor, "name", "fullName"),
        headline: pickStr(actor, "position", "headline", "info"),
        activityType: lauf.kind,
        reactionType:
          lauf.kind === "reaction"
            ? pickStr(o, "reactionType", "action", "type")
            : null,
        commentText:
          lauf.kind === "comment"
            ? (pickStr(o, "commentText", "text") ??
               pickStr(asObj(o.comment), "text", "content"))
            : null,
        postUrl,
      });
    }
  }
  return { engager: out, kosteneinheiten: items };
}

/** Aktuelle Positionen einer Person (Profile-Scraper, $4/1000 —
 *  NUR fuer vorgefilterte Engager aufrufen!). */
export async function fetchCurrentPositions(
  key: string,
  actors: EngagementActorConfig,
  profileUrl: string,
  signal?: AbortSignal,
): Promise<{ positions: CurrentPosition[]; kosteneinheiten: number }> {
  const rows = await runActor(
    key,
    actors.profileActorId,
    {
      queries: [profileUrl],
      profileScraperMode: "Profile details no email ($4 per 1k)",
    },
    signal,
  );
  const positions: CurrentPosition[] = [];
  for (const raw of rows) {
    const o = asObj(raw);
    if (!o) continue;
    const exp = Array.isArray(o.experience) ? o.experience : [];
    for (const e of exp) {
      const eo = asObj(e);
      if (!eo) continue;
      // "aktuell" = kein endDate (tolerant: fehlend oder leer).
      const end = eo.endDate;
      const laeuftNoch =
        end == null ||
        (typeof end === "object" && Object.keys(end as object).length === 0);
      if (!laeuftNoch) continue;
      positions.push({
        companyName: pickStr(eo, "companyName", "company"),
        companyLinkedinUrl: pickStr(eo, "companyLinkedinUrl", "companyUrl"),
        position: pickStr(eo, "position", "title"),
      });
    }
    // currentPosition-Feld als Zusatzquelle (manche Profile ohne exp).
    const cur = asObj(o.currentPosition) ?? null;
    if (cur && positions.length === 0) {
      positions.push({
        companyName: pickStr(cur, "companyName", "company"),
        companyLinkedinUrl: pickStr(cur, "companyLinkedinUrl"),
        position: pickStr(cur, "position", "title"),
      });
    }
  }
  return { positions: positions.slice(0, 5), kosteneinheiten: rows.length };
}

/** Website einer LinkedIn-Unternehmensseite (Firmen-Angabe!). */
export async function fetchCompanyWebsite(
  key: string,
  actors: EngagementActorConfig,
  companyLinkedinUrl: string,
  signal?: AbortSignal,
): Promise<{ website: string | null; name: string | null; kosteneinheiten: number }> {
  const rows = await runActor(
    key,
    actors.companyActorId,
    { companies: [companyLinkedinUrl] },
    signal,
  );
  for (const raw of rows) {
    const o = asObj(raw);
    if (!o) continue;
    return {
      website: pickStr(o, "website", "websiteUrl"),
      name: pickStr(o, "name", "companyName"),
      kosteneinheiten: rows.length,
    };
  }
  return { website: null, name: null, kosteneinheiten: rows.length };
}
