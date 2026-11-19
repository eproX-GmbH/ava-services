// Personen-Radar PR3 — Konfiguration + Dedupe/Ungeklaert (PLAN §8).
//
// Quellen v1: konkrete POST-URLs (eigene Posts, Wettbewerber-Posts).
// Autoren-Profile + thematische Suche sind Ausbaustufe (deren
// Actor-Schemata sind noch nicht live verifiziert).
//
// Dedupe auf PERSONEN-Ebene: ein Engager wird EINMAL aufgeloest,
// egal auf wie vielen Quell-Posts er auftaucht (90-Tage-TTL).
// "Ungeklaert" (kein belastbarer Firmen-Match) mit kurzer TTL
// (14 Tage, §8.2 — DSGVO-Gewicht).

import { paths } from "../../../core/platform";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getDb } from "../db";
import { ENGAGEMENT_DEFAULT_ACTORS, type Engager } from "./engagement";

export interface PersonenRadarConfig {
  enabled: boolean;
  /** Quell-Posts (volle LinkedIn-Post-URLs). */
  postUrls: string[];
  intervalHours: 24 | 168;
  maxItemsPerPost: number;
  actorIds: typeof ENGAGEMENT_DEFAULT_ACTORS;
  lastRunAt: string | null;
  lastOutcome: string | null;
  /** v0.1.519 — Zeitstempel der einmaligen Freigabe aller Ungeklaerten
   *  nach dem Positionen-Bugfix (v0.1.518). */
  unklarFreigegebenAm: string | null;
  /** PM-2026-0052 — Stand je Post: wann alle Kommentare geholt wurden und wann zuletzt.
   *  Nach dem vollen Nachladen holen Folgelaeufe nur Kommentare seit dem letzten Abruf. */
  postStand: Record<string, PostStand>;
}

export interface PostStand {
  vollGeladenAt: string | null;
  letzterAbrufAt: string | null;
}

const DEFAULT_CONFIG: PersonenRadarConfig = {
  enabled: false,
  postUrls: [],
  intervalHours: 168,
  maxItemsPerPost: 50,
  actorIds: { ...ENGAGEMENT_DEFAULT_ACTORS },
  lastRunAt: null,
  lastOutcome: null,
  unklarFreigegebenAm: null,
  postStand: {},
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pradar_seen (
  profile_url TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pradar_firma (
  profile_url TEXT PRIMARY KEY,
  matches     JSONB NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pradar_offen (
  paar       TEXT PRIMARY KEY,
  engager    JSONB NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS pradar_unklar (
  profile_url TEXT PRIMARY KEY,
  name        TEXT,
  headline    TEXT,
  grund       TEXT,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export class PersonenRadarStore {
  private readonly dir: string;
  private cfgCache: PersonenRadarConfig | null = null;
  private schemaReady: Promise<void> | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(paths().get("userData"), "linkedin");
  }

  private cfgPath(): string {
    return join(this.dir, "personen-radar-config.json");
  }

  getConfig(): PersonenRadarConfig {
    if (this.cfgCache) return { ...this.cfgCache, postUrls: [...this.cfgCache.postUrls], postStand: { ...this.cfgCache.postStand } };
    try {
      if (existsSync(this.cfgPath())) {
        const p = JSON.parse(readFileSync(this.cfgPath(), "utf8")) as Partial<PersonenRadarConfig>;
        this.cfgCache = {
          enabled: p.enabled === true,
          postUrls: Array.isArray(p.postUrls)
            ? p.postUrls.filter((u): u is string => typeof u === "string" && u.includes("linkedin.com")).slice(0, 25)
            : [],
          intervalHours: p.intervalHours === 24 ? 24 : 168,
          maxItemsPerPost:
            typeof p.maxItemsPerPost === "number" && Number.isFinite(p.maxItemsPerPost)
              ? Math.min(200, Math.max(5, Math.floor(p.maxItemsPerPost)))
              : DEFAULT_CONFIG.maxItemsPerPost,
          actorIds: {
            ...ENGAGEMENT_DEFAULT_ACTORS,
            ...(p.actorIds && typeof p.actorIds === "object" ? p.actorIds : {}),
          },
          lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : null,
          lastOutcome: typeof p.lastOutcome === "string" ? p.lastOutcome : null,
          unklarFreigegebenAm:
            typeof p.unklarFreigegebenAm === "string" ? p.unklarFreigegebenAm : null,
          postStand: postStandLesen(p.postStand),
        };
        return this.getConfig();
      }
    } catch {
      /* korrupt → Defaults */
    }
    this.cfgCache = { ...DEFAULT_CONFIG, actorIds: { ...ENGAGEMENT_DEFAULT_ACTORS }, postStand: {} };
    return this.getConfig();
  }

  setConfig(patch: Partial<PersonenRadarConfig>): PersonenRadarConfig {
    const next = { ...this.getConfig(), ...patch };
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.cfgPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      renameSync(tmp, this.cfgPath());
    } catch (err) {
      console.warn("[personen-radar] config persist failed:", err);
    }
    this.cfgCache = next;
    return this.getConfig();
  }

  private async db() {
    const db = await getDb();
    if (!this.schemaReady) this.schemaReady = db.exec(SCHEMA).then(() => undefined);
    await this.schemaReady;
    return db;
  }

  /** Noch nie gesehene Profile herausfiltern. */
  async filterNewPersons(profileUrls: string[]): Promise<Set<string>> {
    if (profileUrls.length === 0) return new Set();
    const db = await this.db();
    const r = await db.query<{ profile_url: string }>(
      `SELECT profile_url FROM pradar_seen WHERE profile_url = ANY($1::text[])`,
      [profileUrls],
    );
    const seen = new Set(r.rows.map((x) => x.profile_url));
    return new Set(profileUrls.filter((u) => !seen.has(u)));
  }

  async markPersonsSeen(profileUrls: string[]): Promise<void> {
    const db = await this.db();
    for (const u of profileUrls) {
      await db.query(
        `INSERT INTO pradar_seen (profile_url) VALUES ($1) ON CONFLICT DO NOTHING`,
        [u],
      );
    }
    await db.query(`DELETE FROM pradar_seen WHERE first_seen < NOW() - interval '90 days'`);
  }

  /** PM-2026-0052 — Stand eines Posts fortschreiben (nur fuer konfigurierte Posts). */
  setPostStand(postUrl: string, patch: Partial<PostStand>): void {
    const cfg = this.getConfig();
    const stand: Record<string, PostStand> = {};
    for (const u of cfg.postUrls) if (cfg.postStand[u]) stand[u] = cfg.postStand[u]!;
    stand[postUrl] = { vollGeladenAt: null, letzterAbrufAt: null, ...(stand[postUrl] ?? {}), ...patch };
    this.setConfig({ postStand: stand });
  }

  /** PM-2026-0052 — Personen, die ein Lauf geholt, aber (noch) nicht aufgeloest
   *  hat. Ohne diese Warteschlange gingen sie verloren, sobald Folgelaeufe nur noch neue
   *  Kommentare holen. Haelt 30 Tage. */
  async offeneAblegen(engager: Engager[]): Promise<void> {
    if (engager.length === 0) return;
    const db = await this.db();
    for (const e of engager) {
      await db.query(
        `INSERT INTO pradar_offen (paar, engager) VALUES ($1, $2::jsonb)
         ON CONFLICT (paar) DO UPDATE SET engager = CASE WHEN EXCLUDED.engager->>'activityType' = 'comment' THEN EXCLUDED.engager ELSE pradar_offen.engager END`,
        [`${e.profileUrl}|${e.postUrl}`, JSON.stringify(e)],
      );
    }
    await db.query(`DELETE FROM pradar_offen WHERE at < NOW() - interval '30 days'`);
  }

  /** Aelteste offene Personen zuerst (optional nur ein Post). */
  async offeneHolen(limit: number, postUrl?: string | null): Promise<Engager[]> {
    const db = await this.db();
    const r = await db.query<{ engager: unknown }>(
      postUrl
        ? `SELECT engager FROM pradar_offen WHERE engager->>'postUrl' = $2 ORDER BY at ASC LIMIT $1`
        : `SELECT engager FROM pradar_offen ORDER BY at ASC LIMIT $1`,
      postUrl ? [limit, postUrl] : [limit],
    );
    return r.rows.map((x) => x.engager as Engager).filter((e) => e && typeof e.profileUrl === "string" && typeof e.postUrl === "string");
  }

  async offeneEntfernen(paare: string[]): Promise<void> {
    if (paare.length === 0) return;
    const db = await this.db();
    await db.query(`DELETE FROM pradar_offen WHERE paar = ANY($1::text[])`, [paare]);
  }

  async offeneAnzahl(): Promise<Record<string, number>> {
    const db = await this.db();
    const r = await db.query<{ post: string; n: number | string }>(`SELECT engager->>'postUrl' AS post, COUNT(*) AS n FROM pradar_offen GROUP BY 1`);
    return Object.fromEntries(r.rows.map((x) => [x.post, Number(x.n)]));
  }

  /** v0.1.519 — Ungeklaerte GEZIELT freigeben: ihre 90-Tage-Sperre
   *  (pradar_seen) faellt, der naechste Lauf versucht sie erneut. Die
   *  Ungeklaert-Liste wird geleert. Liefert die Anzahl. */
  async releaseUnklar(): Promise<number> {
    const db = await this.db();
    const r = await db.query<{ profile_url: string }>(
      `SELECT profile_url FROM pradar_unklar`,
    );
    const urls = r.rows.map((x) => x.profile_url);
    if (urls.length === 0) return 0;
    await db.query(`DELETE FROM pradar_seen WHERE profile_url = ANY($1::text[])`, [urls]);
    await db.query(`DELETE FROM pradar_unklar WHERE profile_url = ANY($1::text[])`, [urls]);
    return urls.length;
  }

  async addUnklar(rows: Array<{ profileUrl: string; name: string | null; headline: string | null; grund: string }>): Promise<void> {
    const db = await this.db();
    for (const r of rows) {
      await db.query(
        `INSERT INTO pradar_unklar (profile_url, name, headline, grund)
         VALUES ($1, $2, $3, $4) ON CONFLICT (profile_url) DO NOTHING`,
        [r.profileUrl, r.name, r.headline, r.grund.slice(0, 200)],
      );
    }
    await db.query(`DELETE FROM pradar_unklar WHERE first_seen < NOW() - interval '14 days'`);
  }

  /** docs/PLAN_LINKEDIN_LEADS.md L2 — Firmenaufloesung je Person 90 Tage merken: dieselbe
   *  Person auf einem zweiten Post kostet keinen Profil-Lookup mehr. */
  async getFirmenCache(profileUrls: string[]): Promise<Map<string, unknown[]>> {
    const out = new Map<string, unknown[]>();
    if (profileUrls.length === 0) return out;
    const db = await this.db();
    const r = await db.query<{ profile_url: string; matches: unknown }>(
      `SELECT profile_url, matches FROM pradar_firma WHERE profile_url = ANY($1::text[]) AND at > NOW() - interval '90 days'`,
      [profileUrls],
    );
    for (const x of r.rows) if (Array.isArray(x.matches)) out.set(x.profile_url, x.matches);
    return out;
  }

  async setFirmenCache(profileUrl: string, matches: unknown[]): Promise<void> {
    const db = await this.db();
    await db.query(
      `INSERT INTO pradar_firma (profile_url, matches, at) VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (profile_url) DO UPDATE SET matches = EXCLUDED.matches, at = NOW()`,
      [profileUrl, JSON.stringify(matches)],
    );
    await db.query(`DELETE FROM pradar_firma WHERE at < NOW() - interval '90 days'`);
  }

  async listUnklar(): Promise<Array<{ profileUrl: string; name: string | null; headline: string | null; grund: string | null; firstSeen: string }>> {
    const db = await this.db();
    const r = await db.query<{
      profile_url: string; name: string | null; headline: string | null; grund: string | null; first_seen: string | Date;
    }>(`SELECT * FROM pradar_unklar ORDER BY first_seen DESC LIMIT 100`);
    return r.rows.map((x) => ({
      profileUrl: x.profile_url,
      name: x.name,
      headline: x.headline,
      grund: x.grund,
      firstSeen: x.first_seen instanceof Date ? x.first_seen.toISOString() : String(x.first_seen),
    }));
  }
}

function postStandLesen(v: unknown): Record<string, PostStand> {
  if (!v || typeof v !== "object") return {};
  const out: Record<string, PostStand> = {};
  for (const [url, x] of Object.entries(v as Record<string, unknown>)) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    out[url] = {
      vollGeladenAt: typeof o.vollGeladenAt === "string" ? o.vollGeladenAt : null,
      letzterAbrufAt: typeof o.letzterAbrufAt === "string" ? o.letzterAbrufAt : null,
    };
  }
  return out;
}
