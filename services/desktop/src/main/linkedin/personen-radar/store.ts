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

import { app } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getDb } from "../db";
import { ENGAGEMENT_DEFAULT_ACTORS } from "./engagement";

export interface PersonenRadarConfig {
  enabled: boolean;
  /** Quell-Posts (volle LinkedIn-Post-URLs). */
  postUrls: string[];
  intervalHours: 24 | 168;
  maxItemsPerPost: number;
  /** Teuerster Hebel: Profil-Aufloesungen je Lauf ($4/1000 + Company-Calls). */
  maxResolvesPerRun: number;
  actorIds: typeof ENGAGEMENT_DEFAULT_ACTORS;
  lastRunAt: string | null;
  lastOutcome: string | null;
  /** v0.1.519 — Zeitstempel der einmaligen Freigabe aller Ungeklaerten
   *  nach dem Positionen-Bugfix (v0.1.518). */
  unklarFreigegebenAm: string | null;
}

const DEFAULT_CONFIG: PersonenRadarConfig = {
  enabled: false,
  postUrls: [],
  intervalHours: 168,
  maxItemsPerPost: 50,
  maxResolvesPerRun: 10,
  actorIds: { ...ENGAGEMENT_DEFAULT_ACTORS },
  lastRunAt: null,
  lastOutcome: null,
  unklarFreigegebenAm: null,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pradar_seen (
  profile_url TEXT PRIMARY KEY,
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
    this.dir = dir ?? join(app.getPath("userData"), "linkedin");
  }

  private cfgPath(): string {
    return join(this.dir, "personen-radar-config.json");
  }

  getConfig(): PersonenRadarConfig {
    if (this.cfgCache) return { ...this.cfgCache, postUrls: [...this.cfgCache.postUrls] };
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
          maxResolvesPerRun:
            typeof p.maxResolvesPerRun === "number" && Number.isFinite(p.maxResolvesPerRun)
              ? Math.min(50, Math.max(1, Math.floor(p.maxResolvesPerRun)))
              : DEFAULT_CONFIG.maxResolvesPerRun,
          actorIds: {
            ...ENGAGEMENT_DEFAULT_ACTORS,
            ...(p.actorIds && typeof p.actorIds === "object" ? p.actorIds : {}),
          },
          lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : null,
          lastOutcome: typeof p.lastOutcome === "string" ? p.lastOutcome : null,
          unklarFreigegebenAm:
            typeof p.unklarFreigegebenAm === "string" ? p.unklarFreigegebenAm : null,
        };
        return this.getConfig();
      }
    } catch {
      /* korrupt → Defaults */
    }
    this.cfgCache = { ...DEFAULT_CONFIG, actorIds: { ...ENGAGEMENT_DEFAULT_ACTORS } };
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
