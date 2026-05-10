// LinkedIn-Beobachter local data store (Phase L2).
//
// One PGlite instance per app run, persisted at userData/linkedin/db/.
// No pg-gateway, no cross-IPC: this database is main-process only and
// the renderer reaches it exclusively via the IPC handlers in
// ./index.ts. The kill-switch (store.reset()) wipes the parent
// userData/linkedin/ tree, so deleting this file has nothing extra to
// do beyond closing the connection.
//
// We deliberately keep the schema as plain CREATE TABLE IF NOT EXISTS
// statements applied on first use — no Prisma, no migrations runner.
// L2 introduces every table; future phases can run their own ALTER
// TABLE IF NOT EXISTS in init() when they need to extend.

import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  LinkedInFeedCounts,
  LinkedInRecentPost,
  LinkedInScanOutcome,
  LinkedInScanResult,
} from "../../shared/types";

interface PGliteRow {
  [k: string]: unknown;
}

interface PGliteResult<T = PGliteRow> {
  rows: T[];
  affectedRows?: number;
}

interface PGliteInstance {
  waitReady: Promise<void>;
  query<T = PGliteRow>(
    sql: string,
    params?: unknown[],
  ): Promise<PGliteResult<T>>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

let pglitePromise: Promise<PGliteInstance> | null = null;

function dbDir(): string {
  return join(app.getPath("userData"), "linkedin", "db");
}

async function loadPGlite(): Promise<PGliteInstance> {
  mkdirSync(dbDir(), { recursive: true });
  // Dynamic import — the package is ESM-only and a top-level import
  // breaks the CommonJS bundle that electron-vite emits for main.
  const mod = (await import("@electric-sql/pglite")) as unknown as {
    PGlite: new (path: string) => PGliteInstance;
  };
  const db = new mod.PGlite(dbDir());
  await db.waitReady;
  return db;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS linkedin_actor (
  actor_urn       TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  headline        TEXT,
  profile_url     TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS linkedin_post (
  post_urn        TEXT PRIMARY KEY,
  author_urn      TEXT NOT NULL REFERENCES linkedin_actor(actor_urn),
  posted_at       TIMESTAMPTZ,
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  text            TEXT,
  post_kind       TEXT,
  external_url    TEXT,
  permalink       TEXT,
  raw_html        TEXT
);
CREATE INDEX IF NOT EXISTS linkedin_post_scraped_at ON linkedin_post (scraped_at DESC);
CREATE INDEX IF NOT EXISTS linkedin_post_author ON linkedin_post (author_urn);

CREATE TABLE IF NOT EXISTS linkedin_interaction (
  interaction_id  TEXT PRIMARY KEY,
  post_urn        TEXT NOT NULL REFERENCES linkedin_post(post_urn),
  actor_urn       TEXT NOT NULL REFERENCES linkedin_actor(actor_urn),
  kind            TEXT NOT NULL,
  comment_text    TEXT,
  created_at      TIMESTAMPTZ,
  scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS linkedin_interaction_post ON linkedin_interaction (post_urn);
CREATE INDEX IF NOT EXISTS linkedin_interaction_actor ON linkedin_interaction (actor_urn);

CREATE TABLE IF NOT EXISTS linkedin_media (
  media_id        TEXT PRIMARY KEY,
  post_urn        TEXT NOT NULL REFERENCES linkedin_post(post_urn),
  kind            TEXT NOT NULL,
  source_url      TEXT,
  local_path      TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  downloaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS linkedin_media_post ON linkedin_media (post_urn);

CREATE TABLE IF NOT EXISTS linkedin_scan_run (
  run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  outcome         TEXT,
  posts_seen      INTEGER NOT NULL DEFAULT 0,
  posts_new       INTEGER NOT NULL DEFAULT 0,
  interactions_new INTEGER NOT NULL DEFAULT 0,
  media_new       INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT
);

-- Phase L3: text-topic extraction queue + result row.
-- One row per linkedin_post; status drives the worker queue.
CREATE TABLE IF NOT EXISTS linkedin_signal (
  post_urn         TEXT PRIMARY KEY REFERENCES linkedin_post(post_urn),
  status           TEXT NOT NULL,
  extracted_at     TIMESTAMPTZ,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  llm_tier         INTEGER,
  llm_model        TEXT,
  signal_kind      TEXT,
  signal_strength  INTEGER,
  summary          TEXT,
  topics           JSONB,
  entities         JSONB
);
CREATE INDEX IF NOT EXISTS linkedin_signal_status ON linkedin_signal (status);
CREATE INDEX IF NOT EXISTS linkedin_signal_kind ON linkedin_signal (signal_kind);
CREATE INDEX IF NOT EXISTS linkedin_signal_strength ON linkedin_signal (signal_strength);

-- Phase L4: vision-LLM image analysis queue + result row.
-- One row per linkedin_media (kind='image' only); status drives the worker queue.
CREATE TABLE IF NOT EXISTS linkedin_image_analysis (
  media_id          TEXT PRIMARY KEY REFERENCES linkedin_media(media_id),
  status            TEXT NOT NULL,
  analyzed_at       TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  llm_tier          INTEGER,
  llm_model         TEXT,
  description       TEXT,
  visible_text      TEXT,
  detected_logos    JSONB,
  detected_products JSONB,
  environment       TEXT
);
CREATE INDEX IF NOT EXISTS linkedin_image_analysis_status ON linkedin_image_analysis (status);
CREATE INDEX IF NOT EXISTS linkedin_image_analysis_environment ON linkedin_image_analysis (environment);

-- Phase L5: entity-link results. One row per (post, source_value, source_kind);
-- the same string can resolve once for 'signal_company' and again for 'logo'.
ALTER TABLE linkedin_signal ADD COLUMN IF NOT EXISTS entities_linked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS linkedin_signal_linked_at
  ON linkedin_signal (entities_linked_at);

CREATE TABLE IF NOT EXISTS linkedin_entity_link (
  link_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_post_urn      TEXT NOT NULL REFERENCES linkedin_post(post_urn),
  source_kind          TEXT NOT NULL,
  source_value         TEXT NOT NULL,
  resolution           TEXT NOT NULL,
  match_score          REAL,
  match_reason         TEXT,
  master_company_id    TEXT,
  master_company_name  TEXT,
  contact_id           TEXT,
  contact_display      TEXT,
  actor_urn            TEXT,
  alternates           JSONB,
  resolved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS linkedin_entity_link_post
  ON linkedin_entity_link (source_post_urn);
CREATE INDEX IF NOT EXISTS linkedin_entity_link_company
  ON linkedin_entity_link (master_company_id);
CREATE INDEX IF NOT EXISTS linkedin_entity_link_resolution
  ON linkedin_entity_link (resolution);

CREATE TABLE IF NOT EXISTS linkedin_company_lookup_cache (
  query_norm           TEXT PRIMARY KEY,
  cached_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hits                 JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS linkedin_company_lookup_cache_age
  ON linkedin_company_lookup_cache (cached_at);
`;

async function initSchema(db: PGliteInstance): Promise<void> {
  // Ensure pgcrypto/uuid generation extension. PGlite ships with
  // pgcrypto-like UUID via gen_random_uuid built into core, so the
  // CREATE EXTENSION is a no-op in newer builds; older ones tolerate
  // a missing extension because we wrap in a try/catch.
  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  } catch {
    // ignore — gen_random_uuid is built-in in current PGlite.
  }
  await db.exec(SCHEMA_SQL);
}

/** Lazily open + initialise the database. Subsequent calls reuse the
 *  same instance. */
export function getDb(): Promise<PGliteInstance> {
  if (!pglitePromise) {
    pglitePromise = (async () => {
      const db = await loadPGlite();
      await initSchema(db);
      return db;
    })();
  }
  return pglitePromise;
}

/** Close the DB on app quit. Safe to call when not yet opened. */
export async function closeDb(): Promise<void> {
  if (!pglitePromise) return;
  try {
    const db = await pglitePromise;
    await db.close();
  } catch (err) {
    console.warn(
      "[linkedin/db] close failed:",
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    pglitePromise = null;
  }
}

// ---- Mutation helpers ----------------------------------------------------

export interface ActorInput {
  actorUrn: string;
  displayName: string;
  headline: string | null;
  profileUrl: string | null;
}

export async function upsertActor(
  db: PGliteInstance,
  a: ActorInput,
): Promise<void> {
  await db.query(
    `INSERT INTO linkedin_actor (actor_urn, display_name, headline, profile_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (actor_urn) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       headline     = COALESCE(EXCLUDED.headline, linkedin_actor.headline),
       profile_url  = COALESCE(EXCLUDED.profile_url, linkedin_actor.profile_url),
       last_seen_at = NOW()`,
    [a.actorUrn, a.displayName, a.headline, a.profileUrl],
  );
}

export interface PostInput {
  postUrn: string;
  authorUrn: string;
  postedAt: Date | null;
  text: string;
  postKind: string;
  externalUrl: string | null;
  permalink: string | null;
  rawHtml: string;
}

/** Returns true when the row was newly inserted. */
export async function upsertPost(
  db: PGliteInstance,
  p: PostInput,
): Promise<boolean> {
  // xmax = 0 on INSERT, set on UPDATE — classic Postgres trick to
  // distinguish freshly inserted rows from upserted ones.
  const res = await db.query<{ inserted: boolean }>(
    `INSERT INTO linkedin_post
       (post_urn, author_urn, posted_at, text, post_kind, external_url, permalink, raw_html)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (post_urn) DO UPDATE SET
       posted_at    = COALESCE(EXCLUDED.posted_at, linkedin_post.posted_at),
       text         = EXCLUDED.text,
       post_kind    = EXCLUDED.post_kind,
       external_url = COALESCE(EXCLUDED.external_url, linkedin_post.external_url),
       permalink    = COALESCE(EXCLUDED.permalink, linkedin_post.permalink),
       raw_html     = EXCLUDED.raw_html
     RETURNING (xmax = 0) AS inserted`,
    [
      p.postUrn,
      p.authorUrn,
      p.postedAt,
      p.text,
      p.postKind,
      p.externalUrl,
      p.permalink,
      // Cap raw HTML to 64 KB so a single fat post doesn't bloat
      // the table.
      p.rawHtml.length > 64_000 ? p.rawHtml.slice(0, 64_000) : p.rawHtml,
    ],
  );
  return res.rows[0]?.inserted === true;
}

export interface InteractionInput {
  postUrn: string;
  actorUrn: string;
  kind: "like" | "comment" | "share" | "post";
  commentText: string | null;
  createdAt: Date | null;
}

/** Returns true when the row was newly inserted. */
export async function upsertInteraction(
  db: PGliteInstance,
  i: InteractionInput,
): Promise<boolean> {
  const id = `${i.postUrn}:${i.actorUrn}:${i.kind}`;
  const res = await db.query<{ inserted: boolean }>(
    `INSERT INTO linkedin_interaction
       (interaction_id, post_urn, actor_urn, kind, comment_text, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (interaction_id) DO UPDATE SET
       comment_text = COALESCE(EXCLUDED.comment_text, linkedin_interaction.comment_text),
       created_at   = COALESCE(EXCLUDED.created_at, linkedin_interaction.created_at)
     RETURNING (xmax = 0) AS inserted`,
    [id, i.postUrn, i.actorUrn, i.kind, i.commentText, i.createdAt],
  );
  return res.rows[0]?.inserted === true;
}

export interface MediaInput {
  mediaId: string;
  postUrn: string;
  kind: "image" | "video" | "document";
  sourceUrl: string | null;
  localPath: string;
  bytes: number;
}

/** Returns true when the row was newly inserted. */
export async function insertMedia(
  db: PGliteInstance,
  m: MediaInput,
): Promise<boolean> {
  const res = await db.query<{ inserted: boolean }>(
    `INSERT INTO linkedin_media
       (media_id, post_urn, kind, source_url, local_path, bytes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (media_id) DO NOTHING
     RETURNING (xmax = 0) AS inserted`,
    [m.mediaId, m.postUrn, m.kind, m.sourceUrl, m.localPath, m.bytes],
  );
  return res.rows.length > 0 && res.rows[0]?.inserted === true;
}

// ---- Scan-run book-keeping ----------------------------------------------

/** Insert an in-flight scan-run row; returns its UUID. */
export async function startScanRun(db: PGliteInstance): Promise<string> {
  const res = await db.query<{ run_id: string }>(
    `INSERT INTO linkedin_scan_run (started_at) VALUES (NOW())
     RETURNING run_id::text`,
  );
  const id = res.rows[0]?.run_id;
  if (!id) throw new Error("startScanRun: missing run_id");
  return id;
}

export interface FinishScanRunInput {
  runId: string;
  outcome: LinkedInScanOutcome;
  postsSeen: number;
  postsNew: number;
  interactionsNew: number;
  mediaNew: number;
  errorMessage?: string;
}

export async function finishScanRun(
  db: PGliteInstance,
  i: FinishScanRunInput,
): Promise<void> {
  await db.query(
    `UPDATE linkedin_scan_run
        SET finished_at = NOW(),
            outcome = $2,
            posts_seen = $3,
            posts_new = $4,
            interactions_new = $5,
            media_new = $6,
            error_message = $7
      WHERE run_id = $1::uuid`,
    [
      i.runId,
      i.outcome,
      i.postsSeen,
      i.postsNew,
      i.interactionsNew,
      i.mediaNew,
      i.errorMessage ?? null,
    ],
  );
}

export async function latestScanRun(
  db: PGliteInstance,
): Promise<LinkedInScanResult | null> {
  const res = await db.query<{
    run_id: string;
    finished_at: string | null;
    outcome: LinkedInScanOutcome | null;
    posts_seen: number;
    posts_new: number;
    interactions_new: number;
    media_new: number;
    error_message: string | null;
  }>(
    `SELECT run_id::text AS run_id,
            finished_at,
            outcome,
            posts_seen,
            posts_new,
            interactions_new,
            media_new,
            error_message
       FROM linkedin_scan_run
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1`,
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    runId: row.run_id,
    outcome: row.outcome ?? "error",
    postsSeen: Number(row.posts_seen ?? 0),
    postsNew: Number(row.posts_new ?? 0),
    interactionsNew: Number(row.interactions_new ?? 0),
    mediaNew: Number(row.media_new ?? 0),
    errorMessage: row.error_message ?? undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
  };
}

// ---- Read-side helpers ---------------------------------------------------

export async function feedCounts(
  db: PGliteInstance,
): Promise<LinkedInFeedCounts> {
  const res = await db.query<{
    posts: number;
    interactions: number;
    actors: number;
    media: number;
    media_bytes: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM linkedin_post)         AS posts,
       (SELECT COUNT(*)::int FROM linkedin_interaction)  AS interactions,
       (SELECT COUNT(*)::int FROM linkedin_actor)        AS actors,
       (SELECT COUNT(*)::int FROM linkedin_media)        AS media,
       (SELECT COALESCE(SUM(bytes), 0)::bigint FROM linkedin_media) AS media_bytes`,
  );
  const row = res.rows[0];
  const sig = await signalCounts(db);
  const img = await imageAnalysisCounts(db);
  const links = await entityLinkStats(db);
  return {
    posts: Number(row?.posts ?? 0),
    interactions: Number(row?.interactions ?? 0),
    actors: Number(row?.actors ?? 0),
    media: Number(row?.media ?? 0),
    mediaBytes: Number(row?.media_bytes ?? 0),
    signalsExtracted: sig.extracted,
    signalsPending: sig.pending,
    signalsFailed: sig.failed,
    signalsSkipped: sig.skipped,
    imageAnalyses: {
      pending: img.pending,
      analyzed: img.analyzed,
      failed: img.failed,
      skipped: img.skipped,
    },
    links: {
      pendingPosts: links.pendingPosts,
      linkedPosts: links.linkedPosts,
      matched: links.matched,
      ambiguous: links.ambiguous,
      unmatched: links.unmatched,
      knownCompanies: links.knownCompanies,
    },
  };
}

// ---- L3 signal queue + extraction results ------------------------------

export type SignalStatus = "pending" | "extracted" | "failed" | "skipped";
export type SignalKind =
  | "personnel_change"
  | "company_event"
  | "factory_visit"
  | "new_product"
  | "partnership"
  | "event_attendance"
  | "hiring"
  | "award"
  | "press_mention"
  | "none";

export interface SignalEntities {
  companies: string[];
  people: string[];
  locations?: string[];
}

export interface SignalPayload {
  signal_kind: SignalKind;
  signal_strength: number;
  summary: string;
  topics: string[];
  entities: SignalEntities;
}

export interface SignalCounts {
  pending: number;
  extracted: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface SignalCandidatePost {
  postUrn: string;
  postKind: string | null;
  text: string;
  postedAt: Date | null;
  postedAtRelative: string | null;
  author: {
    displayName: string;
    headline: string | null;
  };
  surfacedInteractions: Array<{
    actor: string;
    kind: string;
    commentText: string | null;
  }>;
}

const MAX_ATTEMPTS = 3;

export async function enqueueSignal(
  db: PGliteInstance,
  postUrn: string,
): Promise<void> {
  await db.query(
    `INSERT INTO linkedin_signal (post_urn, status, attempts)
     VALUES ($1, 'pending', 0)
     ON CONFLICT (post_urn) DO NOTHING`,
    [postUrn],
  );
}

export async function nextPendingSignals(
  db: PGliteInstance,
  limit: number,
): Promise<string[]> {
  const res = await db.query<{ post_urn: string }>(
    `SELECT post_urn FROM linkedin_signal
      WHERE status = 'pending'
         OR (status = 'failed' AND attempts < $2)
      ORDER BY post_urn
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  );
  return res.rows.map((r) => r.post_urn);
}

export async function loadSignalCandidate(
  db: PGliteInstance,
  postUrn: string,
): Promise<SignalCandidatePost | null> {
  const postRes = await db.query<{
    post_urn: string;
    post_kind: string | null;
    text: string | null;
    posted_at: string | null;
    author_display_name: string;
    author_headline: string | null;
  }>(
    `SELECT p.post_urn, p.post_kind, p.text, p.posted_at,
            a.display_name AS author_display_name,
            a.headline AS author_headline
       FROM linkedin_post p
       JOIN linkedin_actor a ON a.actor_urn = p.author_urn
      WHERE p.post_urn = $1`,
    [postUrn],
  );
  const r = postRes.rows[0];
  if (!r) return null;
  const intRes = await db.query<{
    display_name: string;
    kind: string;
    comment_text: string | null;
  }>(
    `SELECT a.display_name, i.kind, i.comment_text
       FROM linkedin_interaction i
       JOIN linkedin_actor a ON a.actor_urn = i.actor_urn
      WHERE i.post_urn = $1
      ORDER BY i.scraped_at ASC
      LIMIT 10`,
    [postUrn],
  );
  return {
    postUrn: r.post_urn,
    postKind: r.post_kind,
    text: r.text ?? "",
    postedAt: r.posted_at ? new Date(r.posted_at) : null,
    postedAtRelative: null,
    author: {
      displayName: r.author_display_name,
      headline: r.author_headline,
    },
    surfacedInteractions: intRes.rows.map((row) => ({
      actor: row.display_name,
      kind: row.kind,
      commentText: row.comment_text,
    })),
  };
}

export async function recordSignalSuccess(
  db: PGliteInstance,
  postUrn: string,
  payload: SignalPayload,
  llmTier: number | null,
  llmModel: string | null,
): Promise<void> {
  await db.query(
    `UPDATE linkedin_signal
        SET status = 'extracted',
            extracted_at = NOW(),
            attempts = attempts + 1,
            last_error = NULL,
            llm_tier = $2,
            llm_model = $3,
            signal_kind = $4,
            signal_strength = $5,
            summary = $6,
            topics = $7::jsonb,
            entities = $8::jsonb
      WHERE post_urn = $1`,
    [
      postUrn,
      llmTier,
      llmModel,
      payload.signal_kind,
      payload.signal_strength,
      payload.summary,
      JSON.stringify(payload.topics),
      JSON.stringify(payload.entities),
    ],
  );
}

export async function recordSignalFailure(
  db: PGliteInstance,
  postUrn: string,
  errorMessage: string,
): Promise<void> {
  const trimmed =
    errorMessage.length > 500 ? errorMessage.slice(0, 500) : errorMessage;
  await db.query(
    `UPDATE linkedin_signal
        SET attempts = attempts + 1,
            last_error = $2,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
      WHERE post_urn = $1`,
    [postUrn, trimmed, MAX_ATTEMPTS],
  );
}

export async function recordSignalSkipped(
  db: PGliteInstance,
  postUrn: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.length > 500 ? reason.slice(0, 500) : reason;
  await db.query(
    `UPDATE linkedin_signal
        SET status = 'skipped',
            last_error = $2
      WHERE post_urn = $1`,
    [postUrn, trimmed],
  );
}

/** When an LLM becomes available again, flip skipped rows back to pending
 *  so the next drain re-processes them. Failed rows are left alone. */
export async function resetSkippedToPending(
  db: PGliteInstance,
): Promise<number> {
  const res = await db.query(
    `UPDATE linkedin_signal
        SET status = 'pending',
            attempts = 0,
            last_error = NULL
      WHERE status = 'skipped'`,
  );
  return res.affectedRows ?? 0;
}

/** Manual nudge for stuck rows: flip exhausted-failed rows
 *  (status='failed', attempts >= MAX_ATTEMPTS) back to pending so the
 *  next drain re-tries them. Distinct from resetSkippedToPending() so
 *  the user has to ASK for retries rather than getting auto-cycles on
 *  every settings change. Wired into the manual "Auswertung jetzt
 *  ausführen" button. */
export async function resetFailedSignalsToPending(
  db: PGliteInstance,
): Promise<number> {
  const res = await db.query(
    `UPDATE linkedin_signal
        SET status = 'pending',
            attempts = 0,
            last_error = NULL
      WHERE status = 'failed'`,
  );
  return res.affectedRows ?? 0;
}

export async function signalCounts(
  db: PGliteInstance,
): Promise<SignalCounts> {
  const res = await db.query<{
    status: string;
    n: number;
  }>(
    `SELECT status, COUNT(*)::int AS n
       FROM linkedin_signal
      GROUP BY status`,
  );
  const out: SignalCounts = {
    pending: 0,
    extracted: 0,
    failed: 0,
    skipped: 0,
    total: 0,
  };
  for (const r of res.rows) {
    const n = Number(r.n ?? 0);
    out.total += n;
    if (r.status === "pending") out.pending = n;
    else if (r.status === "extracted") out.extracted = n;
    else if (r.status === "failed") out.failed = n;
    else if (r.status === "skipped") out.skipped = n;
  }
  return out;
}

// ---- Recent posts read --------------------------------------------------

export async function recentPosts(
  db: PGliteInstance,
  opts: { limit?: number; offset?: number; since?: number } = {},
): Promise<LinkedInRecentPost[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const sinceClause =
    typeof opts.since === "number" && opts.since > 0
      ? "WHERE p.scraped_at >= to_timestamp($3 / 1000.0)"
      : "";
  const sql = `
    SELECT p.post_urn,
           p.post_kind,
           COALESCE(p.text, '')                                         AS text,
           p.permalink,
           p.external_url,
           p.posted_at,
           p.scraped_at,
           a.actor_urn                                                  AS author_urn,
           a.display_name                                               AS author_display_name,
           a.headline                                                   AS author_headline,
           a.profile_url                                                AS author_profile_url,
           (SELECT COUNT(*)::int FROM linkedin_media m
              WHERE m.post_urn = p.post_urn)                            AS media_count,
           (SELECT COUNT(*)::int FROM linkedin_interaction i
              WHERE i.post_urn = p.post_urn)                            AS interaction_count
      FROM linkedin_post p
      JOIN linkedin_actor a ON a.actor_urn = p.author_urn
      ${sinceClause}
     ORDER BY p.scraped_at DESC
     LIMIT $1 OFFSET $2
  `;
  const params: unknown[] = [limit, offset];
  if (sinceClause) params.push(opts.since);
  const res = await db.query<{
    post_urn: string;
    post_kind: string | null;
    text: string;
    permalink: string | null;
    external_url: string | null;
    posted_at: string | null;
    scraped_at: string;
    author_urn: string;
    author_display_name: string;
    author_headline: string | null;
    author_profile_url: string | null;
    media_count: number;
    interaction_count: number;
  }>(sql, params);
  return res.rows.map((r) => ({
    postUrn: r.post_urn,
    postKind: r.post_kind ?? "text",
    text: r.text,
    permalink: r.permalink,
    externalUrl: r.external_url,
    postedAt: r.posted_at ? new Date(r.posted_at).getTime() : null,
    scrapedAt: new Date(r.scraped_at).getTime(),
    author: {
      actorUrn: r.author_urn,
      displayName: r.author_display_name,
      headline: r.author_headline,
      profileUrl: r.author_profile_url,
    },
    mediaCount: Number(r.media_count ?? 0),
    interactionCount: Number(r.interaction_count ?? 0),
  }));
}

// ---- L4 image-analysis queue + extraction results ----------------------

export type ImageAnalysisStatusRow =
  | "pending"
  | "analyzed"
  | "failed"
  | "skipped";

export type ImageEnvironment =
  | "factory"
  | "office"
  | "trade_show"
  | "conference"
  | "outdoor"
  | "studio"
  | "other"
  | "unknown";

export interface ImageAnalysisPayload {
  description: string;
  visible_text: string;
  detected_logos: string[];
  detected_products: string[];
  environment: ImageEnvironment;
}

export interface ImageAnalysisCounts {
  pending: number;
  analyzed: number;
  failed: number;
  skipped: number;
  total: number;
}

export interface ImageAnalysisCandidate {
  mediaId: string;
  postUrn: string;
  localPath: string;
  bytes: number;
  sourceUrl: string | null;
}

const IMAGE_MAX_ATTEMPTS = 3;

/** Idempotent insert. Called by the scraper after each new image media row. */
export async function enqueueImageAnalysis(
  db: PGliteInstance,
  mediaId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO linkedin_image_analysis (media_id, status, attempts)
     VALUES ($1, 'pending', 0)
     ON CONFLICT (media_id) DO NOTHING`,
    [mediaId],
  );
}

/** Pull the next batch of pending or retriable failed image rows,
 *  joined to linkedin_media so the worker has the local path. */
export async function nextPendingImageAnalyses(
  db: PGliteInstance,
  limit: number,
): Promise<ImageAnalysisCandidate[]> {
  const res = await db.query<{
    media_id: string;
    post_urn: string;
    local_path: string;
    bytes: number;
    source_url: string | null;
  }>(
    `SELECT ia.media_id, m.post_urn, m.local_path, m.bytes, m.source_url
       FROM linkedin_image_analysis ia
       JOIN linkedin_media m ON m.media_id = ia.media_id
      WHERE m.kind = 'image'
        AND (ia.status = 'pending'
             OR (ia.status = 'failed' AND ia.attempts < $2))
      ORDER BY ia.media_id
      LIMIT $1`,
    [limit, IMAGE_MAX_ATTEMPTS],
  );
  return res.rows.map((r) => ({
    mediaId: r.media_id,
    postUrn: r.post_urn,
    localPath: r.local_path,
    bytes: Number(r.bytes ?? 0),
    sourceUrl: r.source_url,
  }));
}

export async function recordImageAnalysisSuccess(
  db: PGliteInstance,
  mediaId: string,
  payload: ImageAnalysisPayload,
  llmTier: number | null,
  llmModel: string | null,
): Promise<void> {
  await db.query(
    `UPDATE linkedin_image_analysis
        SET status = 'analyzed',
            analyzed_at = NOW(),
            attempts = attempts + 1,
            last_error = NULL,
            llm_tier = $2,
            llm_model = $3,
            description = $4,
            visible_text = $5,
            detected_logos = $6::jsonb,
            detected_products = $7::jsonb,
            environment = $8
      WHERE media_id = $1`,
    [
      mediaId,
      llmTier,
      llmModel,
      payload.description,
      payload.visible_text,
      JSON.stringify(payload.detected_logos),
      JSON.stringify(payload.detected_products),
      payload.environment,
    ],
  );
}

export async function recordImageAnalysisFailure(
  db: PGliteInstance,
  mediaId: string,
  errorMessage: string,
): Promise<void> {
  const trimmed =
    errorMessage.length > 500 ? errorMessage.slice(0, 500) : errorMessage;
  await db.query(
    `UPDATE linkedin_image_analysis
        SET attempts = attempts + 1,
            last_error = $2,
            status = CASE WHEN attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END
      WHERE media_id = $1`,
    [mediaId, trimmed, IMAGE_MAX_ATTEMPTS],
  );
}

export async function recordImageAnalysisSkipped(
  db: PGliteInstance,
  mediaId: string,
  reason: string,
): Promise<void> {
  const trimmed = reason.length > 500 ? reason.slice(0, 500) : reason;
  await db.query(
    `UPDATE linkedin_image_analysis
        SET status = 'skipped',
            last_error = $2
      WHERE media_id = $1`,
    [mediaId, trimmed],
  );
}

/** Re-eligibilise skipped rows when settings change. Mirrors the L3
 *  `resetSkippedToPending`. Failed rows are left alone. */
export async function resetSkippedImageAnalysesToPending(
  db: PGliteInstance,
): Promise<number> {
  const res = await db.query(
    `UPDATE linkedin_image_analysis
        SET status = 'pending',
            attempts = 0,
            last_error = NULL
      WHERE status = 'skipped'`,
  );
  return res.affectedRows ?? 0;
}

/** Manual-nudge counterpart to resetFailedSignalsToPending. */
export async function resetFailedImageAnalysesToPending(
  db: PGliteInstance,
): Promise<number> {
  const res = await db.query(
    `UPDATE linkedin_image_analysis
        SET status = 'pending',
            attempts = 0,
            last_error = NULL
      WHERE status = 'failed'`,
  );
  return res.affectedRows ?? 0;
}

// ---- L5 entity linking --------------------------------------------------

export type EntityLinkSourceKind =
  | "signal_company"
  | "signal_person"
  | "logo"
  | "actor";

export type EntityLinkResolution = "matched" | "ambiguous" | "unmatched";

export interface EntityLinkAlternate {
  companyId: string;
  name: string;
  score: number;
}

export interface EntityLinkInput {
  sourceKind: EntityLinkSourceKind;
  sourceValue: string;
  resolution: EntityLinkResolution;
  matchScore: number | null;
  matchReason: string | null;
  masterCompanyId: string | null;
  masterCompanyName: string | null;
  contactId: string | null;
  contactDisplay: string | null;
  actorUrn: string | null;
  alternates: EntityLinkAlternate[] | null;
}

export interface EntityLinkStats {
  pendingPosts: number;
  linkedPosts: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  knownCompanies: number;
}

export interface LinkedSignalRow {
  postUrn: string;
  postedAt: number | null;
  scrapedAt: number;
  text: string;
  permalink: string | null;
  authorDisplayName: string;
  signalKind: string | null;
  signalStrength: number | null;
  summary: string | null;
  matchedCompanies: Array<{ companyId: string; name: string }>;
}

/** Pulls up to `limit` post URNs that have an extracted signal but no
 *  entity-link pass yet. */
export async function nextPendingEntityLinkPosts(
  db: PGliteInstance,
  limit: number,
): Promise<string[]> {
  const res = await db.query<{ post_urn: string }>(
    `SELECT post_urn FROM linkedin_signal
      WHERE status = 'extracted'
        AND entities_linked_at IS NULL
      ORDER BY post_urn
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => r.post_urn);
}

/** Re-link posts whose existing links contain at least one ambiguous OR
 *  unmatched outcome. Sticky-matched posts are left alone. Used by
 *  manual drains after the user imported new master-data companies. */
export async function resetUnresolvedLinks(
  db: PGliteInstance,
): Promise<number> {
  const res = await db.query(
    `UPDATE linkedin_signal s
        SET entities_linked_at = NULL
      WHERE s.status = 'extracted'
        AND s.entities_linked_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM linkedin_entity_link l
           WHERE l.source_post_urn = s.post_urn
             AND l.resolution IN ('ambiguous', 'unmatched')
        )`,
  );
  // Wipe the stale links for those posts so the linker writes fresh
  // outcomes instead of stacking duplicates.
  await db.query(
    `DELETE FROM linkedin_entity_link
      WHERE source_post_urn IN (
        SELECT post_urn FROM linkedin_signal
         WHERE entities_linked_at IS NULL
           AND status = 'extracted'
      )`,
  );
  return res.affectedRows ?? 0;
}

export async function recordEntityLinks(
  db: PGliteInstance,
  postUrn: string,
  links: EntityLinkInput[],
): Promise<void> {
  // Linker also calls this with empty arrays — still stamp the timestamp
  // so the post exits the queue.
  for (const l of links) {
    await db.query(
      `INSERT INTO linkedin_entity_link
         (source_post_urn, source_kind, source_value, resolution,
          match_score, match_reason, master_company_id,
          master_company_name, contact_id, contact_display, actor_urn,
          alternates)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`,
      [
        postUrn,
        l.sourceKind,
        l.sourceValue,
        l.resolution,
        l.matchScore,
        l.matchReason,
        l.masterCompanyId,
        l.masterCompanyName,
        l.contactId,
        l.contactDisplay,
        l.actorUrn,
        l.alternates ? JSON.stringify(l.alternates) : null,
      ],
    );
  }
  await db.query(
    `UPDATE linkedin_signal
        SET entities_linked_at = NOW()
      WHERE post_urn = $1`,
    [postUrn],
  );
}

export async function lookupCacheGet(
  db: PGliteInstance,
  queryNorm: string,
): Promise<EntityLinkAlternate[] | null> {
  const res = await db.query<{ hits: unknown }>(
    `SELECT hits FROM linkedin_company_lookup_cache
      WHERE query_norm = $1
        AND cached_at > NOW() - INTERVAL '24 hours'`,
    [queryNorm],
  );
  const r = res.rows[0];
  if (!r) return null;
  try {
    const hits =
      typeof r.hits === "string"
        ? (JSON.parse(r.hits) as EntityLinkAlternate[])
        : (r.hits as EntityLinkAlternate[]);
    return Array.isArray(hits) ? hits : [];
  } catch {
    return null;
  }
}

export async function lookupCachePut(
  db: PGliteInstance,
  queryNorm: string,
  hits: EntityLinkAlternate[],
): Promise<void> {
  await db.query(
    `INSERT INTO linkedin_company_lookup_cache (query_norm, hits)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (query_norm) DO UPDATE SET
       hits = EXCLUDED.hits,
       cached_at = NOW()`,
    [queryNorm, JSON.stringify(hits)],
  );
}

export async function entityLinkStats(
  db: PGliteInstance,
): Promise<EntityLinkStats> {
  const res = await db.query<{
    pending_posts: number;
    linked_posts: number;
    matched: number;
    ambiguous: number;
    unmatched: number;
    known_companies: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM linkedin_signal
          WHERE status = 'extracted'
            AND entities_linked_at IS NULL)                                AS pending_posts,
       (SELECT COUNT(*)::int FROM linkedin_signal
          WHERE entities_linked_at IS NOT NULL)                            AS linked_posts,
       (SELECT COUNT(*)::int FROM linkedin_entity_link
          WHERE resolution = 'matched')                                    AS matched,
       (SELECT COUNT(*)::int FROM linkedin_entity_link
          WHERE resolution = 'ambiguous')                                  AS ambiguous,
       (SELECT COUNT(*)::int FROM linkedin_entity_link
          WHERE resolution = 'unmatched')                                  AS unmatched,
       (SELECT COUNT(DISTINCT master_company_id)::int FROM linkedin_entity_link
          WHERE resolution = 'matched'
            AND master_company_id IS NOT NULL)                             AS known_companies`,
  );
  const r = res.rows[0];
  return {
    pendingPosts: Number(r?.pending_posts ?? 0),
    linkedPosts: Number(r?.linked_posts ?? 0),
    matched: Number(r?.matched ?? 0),
    ambiguous: Number(r?.ambiguous ?? 0),
    unmatched: Number(r?.unmatched ?? 0),
    knownCompanies: Number(r?.known_companies ?? 0),
  };
}

/** Aggregate the post + signal + matched companies for the linker so we
 *  don't fan out N queries. Returns null if the post or signal is
 *  missing. */
export interface EntityLinkCandidate {
  postUrn: string;
  signalCompanies: string[];
  signalPeople: string[];
  detectedLogos: string[];
  surfacedActors: Array<{
    actorUrn: string;
    displayName: string;
    profileUrl: string | null;
  }>;
}

export async function loadEntityLinkCandidate(
  db: PGliteInstance,
  postUrn: string,
): Promise<EntityLinkCandidate | null> {
  const sigRes = await db.query<{ entities: unknown }>(
    `SELECT entities FROM linkedin_signal WHERE post_urn = $1`,
    [postUrn],
  );
  const sigRow = sigRes.rows[0];
  if (!sigRow) return null;
  const entities = (() => {
    try {
      const v =
        typeof sigRow.entities === "string"
          ? (JSON.parse(sigRow.entities) as SignalEntities)
          : (sigRow.entities as SignalEntities | null);
      return v ?? { companies: [], people: [] };
    } catch {
      return { companies: [] as string[], people: [] as string[] };
    }
  })();

  const logoRes = await db.query<{ detected_logos: unknown }>(
    `SELECT ia.detected_logos
       FROM linkedin_image_analysis ia
       JOIN linkedin_media m ON m.media_id = ia.media_id
      WHERE m.post_urn = $1
        AND ia.status = 'analyzed'`,
    [postUrn],
  );
  const logos: string[] = [];
  for (const r of logoRes.rows) {
    try {
      const arr =
        typeof r.detected_logos === "string"
          ? (JSON.parse(r.detected_logos) as unknown)
          : r.detected_logos;
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === "string" && item.trim()) logos.push(item.trim());
        }
      }
    } catch {
      // ignore malformed
    }
  }

  const actorRes = await db.query<{
    actor_urn: string;
    display_name: string;
    profile_url: string | null;
  }>(
    `SELECT DISTINCT a.actor_urn, a.display_name, a.profile_url
       FROM linkedin_interaction i
       JOIN linkedin_actor a ON a.actor_urn = i.actor_urn
      WHERE i.post_urn = $1
        AND i.kind IN ('like', 'comment', 'share')`,
    [postUrn],
  );

  return {
    postUrn,
    signalCompanies: Array.isArray(entities.companies)
      ? entities.companies.filter((s): s is string => typeof s === "string")
      : [],
    signalPeople: Array.isArray(entities.people)
      ? entities.people.filter((s): s is string => typeof s === "string")
      : [],
    detectedLogos: logos,
    surfacedActors: actorRes.rows.map((r) => ({
      actorUrn: r.actor_urn,
      displayName: r.display_name,
      profileUrl: r.profile_url,
    })),
  };
}

/** L6 read helper: signals that resolved to a given master companyId. */
export async function signalsForCompany(
  db: PGliteInstance,
  companyId: string,
  limit = 50,
  offset = 0,
): Promise<LinkedSignalRow[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const off = Math.max(offset, 0);
  const res = await db.query<{
    post_urn: string;
    posted_at: string | null;
    scraped_at: string;
    text: string | null;
    permalink: string | null;
    author_display_name: string;
    signal_kind: string | null;
    signal_strength: number | null;
    summary: string | null;
  }>(
    `SELECT DISTINCT p.post_urn, p.posted_at, p.scraped_at,
            p.text, p.permalink,
            a.display_name AS author_display_name,
            s.signal_kind, s.signal_strength, s.summary
       FROM linkedin_entity_link l
       JOIN linkedin_post   p ON p.post_urn = l.source_post_urn
       JOIN linkedin_actor  a ON a.actor_urn = p.author_urn
       JOIN linkedin_signal s ON s.post_urn = p.post_urn
      WHERE l.master_company_id = $1
        AND l.resolution = 'matched'
      ORDER BY p.scraped_at DESC
      LIMIT $2 OFFSET $3`,
    [companyId, lim, off],
  );
  return res.rows.map((r) => ({
    postUrn: r.post_urn,
    postedAt: r.posted_at ? new Date(r.posted_at).getTime() : null,
    scrapedAt: new Date(r.scraped_at).getTime(),
    text: r.text ?? "",
    permalink: r.permalink,
    authorDisplayName: r.author_display_name,
    signalKind: r.signal_kind,
    signalStrength: r.signal_strength,
    summary: r.summary,
    matchedCompanies: [],
  }));
}

export async function recentLinkedSignals(
  db: PGliteInstance,
  limit = 50,
): Promise<LinkedSignalRow[]> {
  const lim = Math.min(Math.max(limit, 1), 500);
  const res = await db.query<{
    post_urn: string;
    posted_at: string | null;
    scraped_at: string;
    text: string | null;
    permalink: string | null;
    author_display_name: string;
    signal_kind: string | null;
    signal_strength: number | null;
    summary: string | null;
    matched: unknown;
  }>(
    `SELECT p.post_urn, p.posted_at, p.scraped_at,
            p.text, p.permalink,
            a.display_name AS author_display_name,
            s.signal_kind, s.signal_strength, s.summary,
            (SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
                       'companyId', l.master_company_id,
                       'name', l.master_company_name)),
                     '[]'::jsonb)
               FROM linkedin_entity_link l
              WHERE l.source_post_urn = p.post_urn
                AND l.resolution = 'matched'
                AND l.master_company_id IS NOT NULL) AS matched
       FROM linkedin_signal s
       JOIN linkedin_post   p ON p.post_urn = s.post_urn
       JOIN linkedin_actor  a ON a.actor_urn = p.author_urn
      WHERE s.entities_linked_at IS NOT NULL
      ORDER BY p.scraped_at DESC
      LIMIT $1`,
    [lim],
  );
  return res.rows.map((r) => {
    let matched: Array<{ companyId: string; name: string }> = [];
    try {
      const v =
        typeof r.matched === "string"
          ? (JSON.parse(r.matched) as Array<{
              companyId: string | null;
              name: string | null;
            }>)
          : (r.matched as Array<{
              companyId: string | null;
              name: string | null;
            }> | null);
      if (Array.isArray(v)) {
        matched = v
          .filter((m) => m && m.companyId && m.name)
          .map((m) => ({
            companyId: m.companyId as string,
            name: m.name as string,
          }));
      }
    } catch {
      // ignore
    }
    return {
      postUrn: r.post_urn,
      postedAt: r.posted_at ? new Date(r.posted_at).getTime() : null,
      scrapedAt: new Date(r.scraped_at).getTime(),
      text: r.text ?? "",
      permalink: r.permalink,
      authorDisplayName: r.author_display_name,
      signalKind: r.signal_kind,
      signalStrength: r.signal_strength,
      summary: r.summary,
      matchedCompanies: matched,
    };
  });
}

export async function imageAnalysisCounts(
  db: PGliteInstance,
): Promise<ImageAnalysisCounts> {
  const res = await db.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n
       FROM linkedin_image_analysis
      GROUP BY status`,
  );
  const out: ImageAnalysisCounts = {
    pending: 0,
    analyzed: 0,
    failed: 0,
    skipped: 0,
    total: 0,
  };
  for (const r of res.rows) {
    const n = Number(r.n ?? 0);
    out.total += n;
    if (r.status === "pending") out.pending = n;
    else if (r.status === "analyzed") out.analyzed = n;
    else if (r.status === "failed") out.failed = n;
    else if (r.status === "skipped") out.skipped = n;
  }
  return out;
}
