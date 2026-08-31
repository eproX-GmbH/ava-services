// WL2 (PLAN_LINKEDIN_WATCHLIST.md §4.2) — Watchlist-Store + Dedupe-Historie.
//
// Lebt in der bestehenden LinkedIn-PGlite (userData/linkedin/db) —
// damit gelten Kill-Switch (store.reset wischt den ganzen Baum) und
// Werksreset ("linkedin" in den topLevelTargets) automatisch mit.
//
// Plan-Deckel (§6/§2c) werden HIER durchgesetzt: Free 0 Plaetze
// (Feature aus, Teaser), Starter 25 (davon 5 Fokus), Pro/Enterprise
// 200 (davon 25 Fokus). Tier unbekannt (offline/Erststart) → kein
// Deckel; der Supervisor prueft zur Laufzeit erneut.

import { getDb } from "../db";
import { normalizeLinkedInProfileUrl } from "./normalize";
import {
  activityDedupeKey,
  type ProfileActivitySignal,
} from "./types";

const SEEN_TTL_DAYS = 90;
const SEEN_CAP = 5000;

export interface WatchlistEntry {
  profileUrl: string;
  label: string;
  quelle: "manuell" | "kontakt";
  companyId: string | null;
  aktiv: boolean;
  fokus: boolean;
  addedAt: string;
  lastCheckedAt: string | null;
}

export interface WatchlistLimits {
  maxEintraege: number;
  maxFokus: number;
}

export function watchlistLimitsForTier(tier: string | null): WatchlistLimits | null {
  switch (tier) {
    case "free":
      return { maxEintraege: 0, maxFokus: 0 };
    case "starter":
      return { maxEintraege: 25, maxFokus: 5 };
    case "pro":
    case "enterprise":
      return { maxEintraege: 200, maxFokus: 25 };
    default:
      return null; // unbekannt → kein Deckel (nie Verknappung aus Cache-Miss)
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watchlist_entry (
  profile_url     TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  quelle          TEXT NOT NULL,
  company_id      TEXT,
  aktiv           BOOLEAN NOT NULL DEFAULT TRUE,
  fokus           BOOLEAN NOT NULL DEFAULT FALSE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS watchlist_seen (
  dedupe_key    TEXT PRIMARY KEY,
  person_url    TEXT NOT NULL,
  post_url      TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS watchlist_seen_first_idx
  ON watchlist_seen (first_seen);
CREATE TABLE IF NOT EXISTS watchlist_bestand (
  profile_url     TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  company_id      TEXT,
  last_checked_at TIMESTAMPTZ,
  refreshed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

interface EntryRow {
  profile_url: string;
  label: string;
  quelle: string;
  company_id: string | null;
  aktiv: boolean;
  fokus: boolean;
  added_at: string | Date;
  last_checked_at: string | Date | null;
}

function iso(v: string | Date | null): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function rowToEntry(r: EntryRow): WatchlistEntry {
  return {
    profileUrl: r.profile_url,
    label: r.label,
    quelle: r.quelle === "kontakt" ? "kontakt" : "manuell",
    companyId: r.company_id,
    aktiv: r.aktiv === true,
    fokus: r.fokus === true,
    addedAt: iso(r.added_at) ?? new Date(0).toISOString(),
    lastCheckedAt: iso(r.last_checked_at),
  };
}

export interface WatchlistStoreDeps {
  /** Plan-Tier (synchroner Cache aus index.ts); null = unbekannt. */
  getTier: () => string | null;
}

export class WatchlistStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly deps: WatchlistStoreDeps) {}

  private async db() {
    const db = await getDb();
    if (!this.schemaReady) {
      this.schemaReady = db.exec(SCHEMA).then(() => undefined);
    }
    await this.schemaReady;
    return db;
  }

  async list(): Promise<WatchlistEntry[]> {
    const db = await this.db();
    const r = await db.query<EntryRow>(
      `SELECT * FROM watchlist_entry ORDER BY fokus DESC, added_at DESC`,
    );
    return r.rows.map(rowToEntry);
  }

  /**
   * Eintrag anlegen/aktualisieren. Profil-URL wird kanonisiert;
   * keine Profil-URL → Fehler. Plan-Deckel: siehe Kopfkommentar.
   */
  async add(input: {
    profileUrl: string;
    label?: string;
    quelle?: "manuell" | "kontakt";
    companyId?: string | null;
    fokus?: boolean;
  }): Promise<WatchlistEntry | { error: string }> {
    const url = normalizeLinkedInProfileUrl(input.profileUrl);
    if (!url) {
      return {
        error: `"${input.profileUrl}" ist keine LinkedIn-Profil-URL (erwartet linkedin.com/in/<slug>).`,
      };
    }
    const db = await this.db();
    const existing = await db.query<EntryRow>(
      `SELECT * FROM watchlist_entry WHERE profile_url = $1`,
      [url],
    );
    const limits = watchlistLimitsForTier(this.deps.getTier());
    if (limits && existing.rows.length === 0) {
      if (limits.maxEintraege === 0) {
        return {
          error:
            "Die Personen-Watchlist ist im Free-Plan nicht enthalten — ab Starter beobachtest du bis zu 25 Ansprechpartner (Einstellungen → Abo).",
        };
      }
      const count = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM watchlist_entry`,
      );
      if ((count.rows[0]?.n ?? 0) >= limits.maxEintraege) {
        return {
          error: `Watchlist voll (${limits.maxEintraege} Plaetze in deinem Plan). Entferne Eintraege oder upgrade.`,
        };
      }
    }
    // undefined = "nicht angefasst": beim Update bleiben Fokus/Label
    // erhalten (Smoke-Befund: der alte UPSERT loeschte das Fokus-Flag
    // bei jedem Add ohne explizites fokus).
    const wantFokus = input.fokus === true;
    if (limits && wantFokus) {
      const fokusCount = await db.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM watchlist_entry WHERE fokus = TRUE AND profile_url <> $1`,
        [url],
      );
      if ((fokusCount.rows[0]?.n ?? 0) >= limits.maxFokus) {
        return {
          error: `Fokus-Plaetze voll (${limits.maxFokus} in deinem Plan). Nimm eine andere Person aus dem Fokus.`,
        };
      }
    }
    const labelParam = input.label?.trim() ? input.label.trim().slice(0, 200) : null;
    const slugLabel = decodeURIComponent(url.split("/in/")[1] ?? url).slice(0, 200);
    const fokusParam = input.fokus === undefined ? null : input.fokus;
    await db.query(
      `INSERT INTO watchlist_entry (profile_url, label, quelle, company_id, aktiv, fokus)
       VALUES ($1, COALESCE($2, $6), $3, $4, TRUE, COALESCE($5, FALSE))
       ON CONFLICT (profile_url) DO UPDATE SET
         label = COALESCE($2, watchlist_entry.label),
         quelle = EXCLUDED.quelle,
         company_id = COALESCE($4, watchlist_entry.company_id),
         aktiv = TRUE,
         fokus = COALESCE($5, watchlist_entry.fokus)`,
      [url, labelParam, input.quelle ?? "manuell", input.companyId ?? null, fokusParam, slugLabel],
    );
    const row = await db.query<EntryRow>(
      `SELECT * FROM watchlist_entry WHERE profile_url = $1`,
      [url],
    );
    return rowToEntry(row.rows[0]!);
  }

  async remove(profileUrl: string): Promise<boolean> {
    const url = normalizeLinkedInProfileUrl(profileUrl) ?? profileUrl;
    const db = await this.db();
    const r = await db.query(
      `DELETE FROM watchlist_entry WHERE profile_url = $1`,
      [url],
    );
    return (r.affectedRows ?? 0) > 0;
  }

  async setFokus(profileUrl: string, fokus: boolean): Promise<boolean | { error: string }> {
    const url = normalizeLinkedInProfileUrl(profileUrl) ?? profileUrl;
    const db = await this.db();
    if (fokus) {
      const limits = watchlistLimitsForTier(this.deps.getTier());
      if (limits) {
        const fokusCount = await db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM watchlist_entry WHERE fokus = TRUE AND profile_url <> $1`,
          [url],
        );
        if ((fokusCount.rows[0]?.n ?? 0) >= limits.maxFokus) {
          return {
            error: `Fokus-Plaetze voll (${limits.maxFokus} in deinem Plan).`,
          };
        }
      }
    }
    const r = await db.query(
      `UPDATE watchlist_entry SET fokus = $2 WHERE profile_url = $1`,
      [url, fokus],
    );
    return (r.affectedRows ?? 0) > 0;
  }

  async setAktiv(profileUrl: string, aktiv: boolean): Promise<boolean> {
    const url = normalizeLinkedInProfileUrl(profileUrl) ?? profileUrl;
    const db = await this.db();
    const r = await db.query(
      `UPDATE watchlist_entry SET aktiv = $2 WHERE profile_url = $1`,
      [url, aktiv],
    );
    return (r.affectedRows ?? 0) > 0;
  }

  async markChecked(profileUrls: string[]): Promise<void> {
    if (profileUrls.length === 0) return;
    const db = await this.db();
    await db.query(
      `UPDATE watchlist_entry SET last_checked_at = NOW()
        WHERE profile_url = ANY($1::text[])`,
      [profileUrls],
    );
  }

  // ---- Bestands-Rotation (v0.1.479, §2c-Erweiterung) ------------------------
  //
  // Pool = alle Kontakte MIT LinkedIn-Profil aus dem verarbeiteten
  // Firmen-Bestand. Wird periodisch vom Supervisor aufgefrischt
  // (Gateway-Route); die Rotation nimmt je Lauf die am laengsten
  // ungeprueften. Watchlist-Eintraege werden NICHT doppelt gefuehrt.

  async refreshBestandPool(
    rows: Array<{ profileUrl: string; label: string; companyId: string | null }>,
  ): Promise<number> {
    const db = await this.db();
    const aufWatchlist = new Set(
      (await this.list()).map((e) => e.profileUrl),
    );
    const now = new Date().toISOString();
    const kept = new Set<string>();
    for (const r of rows) {
      const url = normalizeLinkedInProfileUrl(r.profileUrl);
      if (!url || aufWatchlist.has(url)) continue;
      kept.add(url);
      await db.query(
        `INSERT INTO watchlist_bestand (profile_url, label, company_id, refreshed_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (profile_url) DO UPDATE SET
           label = EXCLUDED.label,
           company_id = COALESCE(EXCLUDED.company_id, watchlist_bestand.company_id),
           refreshed_at = EXCLUDED.refreshed_at`,
        [url, r.label.slice(0, 200), r.companyId, now],
      );
    }
    // Nicht mehr im Bestand (oder auf die Watchlist gewandert) → raus.
    await db.query(
      `DELETE FROM watchlist_bestand WHERE refreshed_at < $1`,
      [now],
    );
    return kept.size;
  }

  async bestandPoolInfo(): Promise<{ count: number; refreshedAt: string | null }> {
    const db = await this.db();
    const r = await db.query<{ n: number; newest: string | Date | null }>(
      `SELECT COUNT(*)::int AS n, MAX(refreshed_at) AS newest FROM watchlist_bestand`,
    );
    return {
      count: r.rows[0]?.n ?? 0,
      refreshedAt: iso(r.rows[0]?.newest ?? null),
    };
  }

  /** Die N am laengsten ungeprueften Bestands-Kontakte. */
  async nextBestandBatch(n: number): Promise<
    Array<{ profileUrl: string; label: string; companyId: string | null; lastCheckedAt: string | null }>
  > {
    const db = await this.db();
    const r = await db.query<{
      profile_url: string;
      label: string;
      company_id: string | null;
      last_checked_at: string | Date | null;
    }>(
      `SELECT profile_url, label, company_id, last_checked_at
         FROM watchlist_bestand
        ORDER BY last_checked_at ASC NULLS FIRST
        LIMIT $1`,
      [Math.max(0, n)],
    );
    return r.rows.map((x) => ({
      profileUrl: x.profile_url,
      label: x.label,
      companyId: x.company_id,
      lastCheckedAt: iso(x.last_checked_at),
    }));
  }

  async markBestandChecked(profileUrls: string[]): Promise<void> {
    if (profileUrls.length === 0) return;
    const db = await this.db();
    await db.query(
      `UPDATE watchlist_bestand SET last_checked_at = NOW()
        WHERE profile_url = ANY($1::text[])`,
      [profileUrls],
    );
  }

  // ---- Dedupe-Historie ------------------------------------------------------

  /** Nur die noch NIE gesehenen Signale zurueckgeben (Reihenfolge bleibt). */
  async filterNew(signals: ProfileActivitySignal[]): Promise<ProfileActivitySignal[]> {
    if (signals.length === 0) return [];
    const db = await this.db();
    const keyed = signals.map((s) => ({ s, key: activityDedupeKey(s) }));
    const r = await db.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM watchlist_seen WHERE dedupe_key = ANY($1::text[])`,
      [keyed.map((k) => k.key)],
    );
    const seen = new Set(r.rows.map((x) => x.dedupe_key));
    // Innerhalb des Batches ebenfalls dedupen (zwei Actors koennen
    // dasselbe Paar liefern).
    const out: ProfileActivitySignal[] = [];
    for (const { s, key } of keyed) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  }

  async markSeen(signals: ProfileActivitySignal[]): Promise<void> {
    if (signals.length === 0) return;
    const db = await this.db();
    for (const s of signals) {
      await db.query(
        `INSERT INTO watchlist_seen (dedupe_key, person_url, post_url, activity_type)
         VALUES ($1, $2, $3, $4) ON CONFLICT (dedupe_key) DO NOTHING`,
        [activityDedupeKey(s), s.personProfileUrl, s.targetPostUrl, s.activityType],
      );
    }
    // Loeschkonzept (§5): TTL 90 Tage + hartes Cap.
    await db.query(
      `DELETE FROM watchlist_seen
        WHERE first_seen < NOW() - make_interval(days => $1)`,
      [SEEN_TTL_DAYS],
    );
    await db.query(
      `DELETE FROM watchlist_seen WHERE dedupe_key IN (
         SELECT dedupe_key FROM watchlist_seen
          ORDER BY first_seen DESC OFFSET $1)`,
      [SEEN_CAP],
    );
  }
}
