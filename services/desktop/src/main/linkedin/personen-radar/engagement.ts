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

import { apifyHeaders, apifyUrl, type ApifyAccess } from "../apify-access";
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
  access: ApifyAccess,
  actorId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const url = apifyUrl(
    access,
    `/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?format=json`,
  );
  const res = await fetch(url, {
    method: "POST",
    headers: apifyHeaders(access, { "content-type": "application/json" }),
    body: JSON.stringify(input),
    signal: signal ?? AbortSignal.timeout(RUN_TIMEOUT_MS),
  });
  await antwortPruefen(res, actorId);
  const json: unknown = await res.json();
  return Array.isArray(json) ? json : [];
}

/** Gemeinsame Fehlerabbildung aller Apify-Aufrufe (AUTH/LIMIT/CREDITS hart nach oben). */
async function antwortPruefen(res: Response, actorId: string): Promise<void> {
  if (res.status === 401 || res.status === 403) {
    throw new Error("APIFY_AUTH: Token ungueltig oder abgelaufen.");
  }
  if (res.status === 402) {
    // docs/PLAN_PRICING_TIERS.md P4: Limit der LinkedIn-Beobachtung (Gateway) oder Apify-Guthaben.
    const body = await res.text().catch(() => "");
    try {
      const j = JSON.parse(body) as { error?: string; meldung?: string };
      if (j.error?.startsWith("linkedin_")) throw new Error(`LINKEDIN_LIMIT:${j.error}: ${j.meldung ?? "Limit der LinkedIn-Beobachtung erreicht."}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("LINKEDIN_LIMIT")) throw e;
    }
    throw new Error("APIFY_CREDITS: Apify-Guthaben aufgebraucht.");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Apify ${actorId}: HTTP ${res.status} ${body.slice(0, 140)}`);
  }
}

const LANG_MAX_MS = 30 * 60_000;

/**
 * PM-2026-0052 — langer Lauf (alle Kommentare eines grossen Posts): synchrone Laeufe bricht
 * Apify nach 300 s ab. Daher asynchron starten, mit waitForFinish nachfragen und das Dataset
 * seitenweise lesen. Die Kosten traegt das Gateway nach, sobald der Lauf fertig ist.
 */
async function runActorLang(
  access: ApifyAccess,
  actorId: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown[]> {
  const ende = Date.now() + LANG_MAX_MS;
  const kurz = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000));
  const start = await fetch(apifyUrl(access, `/acts/${encodeURIComponent(actorId)}/runs?waitForFinish=60`), {
    method: "POST",
    headers: apifyHeaders(access, { "content-type": "application/json" }),
    body: JSON.stringify(input),
    signal: kurz(),
  });
  await antwortPruefen(start, actorId);
  let lauf = ((await start.json()) as { data?: { id?: string; status?: string; defaultDatasetId?: string } }).data ?? {};
  const laufId = lauf.id;
  if (!laufId) throw new Error(`Apify ${actorId}: Lauf ohne Kennung`);
  while (lauf.status === "READY" || lauf.status === "RUNNING") {
    if (Date.now() > ende) throw new Error(`Apify ${actorId}: Lauf nach 30 Minuten nicht fertig (${laufId})`);
    const r = await fetch(apifyUrl(access, `/actor-runs/${encodeURIComponent(laufId)}?waitForFinish=60`), { headers: apifyHeaders(access), signal: kurz() });
    await antwortPruefen(r, actorId);
    lauf = { ...lauf, ...(((await r.json()) as { data?: typeof lauf }).data ?? {}) };
  }
  if (lauf.status !== "SUCCEEDED") throw new Error(`Apify ${actorId}: Lauf ${lauf.status ?? "unbekannt"}`);
  if (!lauf.defaultDatasetId) return [];
  const alle: unknown[] = [];
  for (let offset = 0; offset < 5000; offset += 1000) {
    const r = await fetch(apifyUrl(access, `/datasets/${encodeURIComponent(lauf.defaultDatasetId)}/items?format=json&clean=true&limit=1000&offset=${offset}`), { headers: apifyHeaders(access), signal: kurz() });
    await antwortPruefen(r, actorId);
    const seite = (await r.json()) as unknown;
    const zeilen = Array.isArray(seite) ? seite : [];
    alle.push(...zeilen);
    if (zeilen.length < 1000) break;
  }
  return alle;
}

/** Zeitfenster des Kommentar-Actors (`postedLimit`, wirkt auf das Kommentardatum). */
export type Zeitfenster = "24h" | "week" | "month" | "3months" | "6months" | "year";

/** PM-2026-0052 — was ein Lauf je Post holt. Der Actor kennt kein Blaettern: ohne
 *  Zeitfenster liefert jeder Lauf dieselben ersten `kommentare` Eintraege. `kommentare: 0`
 *  heisst beim Actor „alle Seiten“ (bis 100 Seiten à 10, also 1.000). */
export interface EngagementAbruf {
  reaktionen: number;
  kommentare: number;
  /** Nur Kommentare der letzten Zeit (Folgelauf nach dem vollen Nachladen). */
  zeitfenster?: Zeitfenster | null;
  /** Antworten auf Kommentare als eigene Eintraege mitnehmen. */
  antworten?: boolean;
  /** Kommentare als langen Lauf holen (asynchron, fuer das volle Nachladen). */
  lang?: boolean;
}

/** Kleinstes Zeitfenster, das die Zeit seit dem letzten Abruf sicher abdeckt (mit Puffer). */
export function zeitfensterSeit(letzterAbruf: string | null, jetzt: number = Date.now()): Zeitfenster | null {
  const t = letzterAbruf ? Date.parse(letzterAbruf) : NaN;
  if (!Number.isFinite(t)) return null;
  const stunden = (jetzt - t) / 3600_000;
  if (stunden <= 20) return "24h";
  if (stunden <= 6 * 24) return "week";
  if (stunden <= 27 * 24) return "month";
  if (stunden <= 85 * 24) return "3months";
  if (stunden <= 175 * 24) return "6months";
  if (stunden <= 360 * 24) return "year";
  return null;
}

/** Engager (Reaktionen + Kommentare) eines Posts holen. */
export async function fetchPostEngagement(
  access: ApifyAccess,
  actors: EngagementActorConfig,
  postUrl: string,
  abrufOderMax: EngagementAbruf | number,
  signal?: AbortSignal,
): Promise<{ engager: Engager[]; kosteneinheiten: number; kommentare: number; reaktionen: number }> {
  const abruf: EngagementAbruf =
    typeof abrufOderMax === "number" ? { reaktionen: abrufOderMax, kommentare: abrufOderMax } : abrufOderMax;
  const out: Engager[] = [];
  let items = 0;
  let kommentare = 0;
  let reaktionen = 0;
  const laeufe: Array<{ actorId: string; kind: "reaction" | "comment"; input: Record<string, unknown> }> = [];
  if (abruf.reaktionen > 0 && actors.postReactionsActorId.trim()) {
    laeufe.push({ actorId: actors.postReactionsActorId, kind: "reaction", input: { posts: [postUrl], maxItems: abruf.reaktionen } });
  }
  if (actors.postCommentsActorId.trim()) {
    laeufe.push({
      actorId: actors.postCommentsActorId,
      kind: "comment",
      input: {
        posts: [postUrl],
        maxItems: abruf.kommentare,
        ...(abruf.zeitfenster ? { postedLimit: abruf.zeitfenster } : {}),
        ...(abruf.antworten ? { scrapeReplies: true } : {}),
      },
    });
  }
  for (const lauf of laeufe) {
    const rows =
      lauf.kind === "comment" && abruf.lang
        ? await runActorLang(access, lauf.actorId, lauf.input, signal)
        : await runActor(access, lauf.actorId, lauf.input, signal);
    items += rows.length;
    if (lauf.kind === "comment") kommentare += rows.length;
    else reaktionen += rows.length;
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
        // harvestapi/linkedin-post-comments nennt den Text "commentary" (Befund
        // 2026-10-22: alle Kommentar-Leads kamen ohne Text an).
        commentText:
          lauf.kind === "comment"
            ? (pickStr(o, "commentary", "commentText", "text") ??
               pickStr(asObj(o.comment), "commentary", "text", "content"))
            : null,
        postUrl,
      });
    }
  }
  return { engager: out, kosteneinheiten: items, kommentare, reaktionen };
}

/** Aktuelle Positionen einer Person (Profile-Scraper, $4/1000 —
 *  NUR fuer vorgefilterte Engager aufrufen!). */
/** v0.1.518 — BUGFIX. Der harvestapi-Profil-Actor markiert laufende
 *  Positionen NICHT mit fehlendem endDate, sondern mit
 *  `endDate: { text: "Present" }` (Store-Beispiel verifiziert
 *  2026-09-02). Die alte Pruefung "null oder leeres Objekt" hielt
 *  damit JEDE aktuelle Position fuer beendet — Stufe 1 der Kaskade
 *  lieferte fuer niemanden etwas, alle Personen landeten in
 *  "ungeklaert". Aktuell = kein Jahr im endDate ODER Text wie
 *  Present/Heute/Now. */
function istAktuell(end: unknown): boolean {
  if (end == null) return true;
  if (typeof end === "string") {
    return end.trim() === "" || /present|heute|aktuell|now|current/i.test(end);
  }
  if (typeof end === "object") {
    const o = end as Record<string, unknown>;
    if (Object.keys(o).length === 0) return true;
    const text = typeof o.text === "string" ? o.text : "";
    if (/present|heute|aktuell|now|current/i.test(text)) return true;
    const jahr = typeof o.year === "number" ? o.year : Number(o.year);
    return !Number.isFinite(jahr) || jahr <= 0;
  }
  return false;
}

export async function fetchCurrentPositions(
  access: ApifyAccess,
  actors: EngagementActorConfig,
  profileUrl: string,
  signal?: AbortSignal,
): Promise<{ positions: CurrentPosition[]; kosteneinheiten: number }> {
  const rows = await runActor(
    access,
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
      if (!istAktuell(eo.endDate)) continue;
      positions.push({
        companyName: pickStr(eo, "companyName", "company"),
        companyLinkedinUrl: pickStr(eo, "companyLinkedinUrl", "companyUrl"),
        position: pickStr(eo, "position", "title"),
      });
    }
    // currentPosition-Feld als Zusatzquelle (manche Profile ohne exp).
    // v0.1.518 — der Actor liefert es als ARRAY ([{companyName}]), nicht
    // als Objekt; asObj() gab dafuer null → Fallback griff nie.
    if (positions.length === 0) {
      const curListe = Array.isArray(o.currentPosition)
        ? o.currentPosition
        : o.currentPosition != null
          ? [o.currentPosition]
          : [];
      for (const c of curListe) {
        const cur = asObj(c);
        if (!cur) continue;
        positions.push({
          companyName: pickStr(cur, "companyName", "company"),
          companyLinkedinUrl: pickStr(cur, "companyLinkedinUrl"),
          position: pickStr(cur, "position", "title"),
        });
      }
    }
  }
  return { positions: positions.slice(0, 5), kosteneinheiten: rows.length };
}

/** Website einer LinkedIn-Unternehmensseite (Firmen-Angabe!). */
export async function fetchCompanyWebsite(
  access: ApifyAccess,
  actors: EngagementActorConfig,
  companyLinkedinUrl: string,
  signal?: AbortSignal,
): Promise<{ website: string | null; name: string | null; kosteneinheiten: number }> {
  const rows = await runActor(
    access,
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
