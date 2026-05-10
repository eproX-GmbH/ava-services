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
  return {
    posts: Number(row?.posts ?? 0),
    interactions: Number(row?.interactions ?? 0),
    actors: Number(row?.actors ?? 0),
    media: Number(row?.media ?? 0),
    mediaBytes: Number(row?.media_bytes ?? 0),
  };
}

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
