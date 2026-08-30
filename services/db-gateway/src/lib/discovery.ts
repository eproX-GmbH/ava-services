// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — zentrale
// Kandidaten-Ablage + Scan-Quota.
//
// DiscoveredCompany ist GETEILTER Bestand (Muster PublicationBlock /
// CompanyNameCache): ein Nutzer scannt eine Region, alle profitieren
// von den gefundenen Kandidaten. Nutzer-spezifisch sind nur die
// Entscheidungen (DiscoveryDecision, Phase 3) — importiert/verworfen.
//
// Quota (Entscheidung O3): Scans/Tag und Kandidaten/Scan sind zentral
// begrenzt — Env-Default fuer alle, Override pro Tenant in
// DiscoveryQuotaOverride (Muster ProxyQuotaOverride). Der Scan-Verlauf
// (DiscoveryScan) ist zugleich Audit-Trail und Zaehlbasis.
//
// Spalten profileJson/profileText/embedding werden erst in Phase 2
// (Mini-Profile) befuellt; sie sind hier schon angelegt, damit Phase 2
// ohne Schema-Drift aufsetzen kann.

import { createHash } from "node:crypto";
import pg, { type Pool } from "pg";
import { loadEnv } from "./env";

let schemaReady = false;

async function ensureSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "DiscoveredCompany" (
      "discoveryId"     TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      "nameNormalized"  TEXT NOT NULL,
      city              TEXT,
      plz               TEXT,
      lat               DOUBLE PRECISION,
      lon               DOUBLE PRECISION,
      domain            TEXT NOT NULL,
      category          TEXT,
      "metaJson"        JSONB,
      source            TEXT NOT NULL,
      "masterCompanyId" TEXT,
      "profileJson"     JSONB,
      "profileText"     TEXT,
      embedding         REAL[],
      "profiledAt"      TIMESTAMPTZ,
      "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "DiscoveredCompany_nameNorm_idx"
      ON "DiscoveredCompany" ("nameNormalized");
    CREATE INDEX IF NOT EXISTS "DiscoveredCompany_latlon_idx"
      ON "DiscoveredCompany" (lat, lon);
    ALTER TABLE "DiscoveredCompany" ADD COLUMN IF NOT EXISTS tsv tsvector;
    CREATE INDEX IF NOT EXISTS "DiscoveredCompany_tsv_idx"
      ON "DiscoveredCompany" USING GIN (tsv);
    CREATE TABLE IF NOT EXISTS "DiscoveryScan" (
      "scanId"          TEXT PRIMARY KEY,
      "tenantId"        TEXT NOT NULL,
      "actorId"         TEXT NOT NULL,
      ort               TEXT NOT NULL,
      "radiusKm"        INTEGER NOT NULL,
      "candidatesAdded" INTEGER NOT NULL DEFAULT 0,
      "startedAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS "DiscoveryScan_tenant_day_idx"
      ON "DiscoveryScan" ("tenantId", "startedAt");
    CREATE TABLE IF NOT EXISTS "DiscoveryDecision" (
      "userId"      TEXT NOT NULL,
      "discoveryId" TEXT NOT NULL,
      decision      TEXT NOT NULL,
      reason        TEXT,
      "decidedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("userId", "discoveryId")
    );
    CREATE TABLE IF NOT EXISTS "DiscoveryQuotaOverride" (
      "tenantId"             TEXT PRIMARY KEY,
      "maxScansPerDay"       INTEGER,
      "maxCandidatesPerScan" INTEGER
    );
  `);
  schemaReady = true;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export interface DiscoveryLimits {
  maxScansPerDay: number;
  maxCandidatesPerScan: number;
}

async function effectiveLimits(pool: Pool, tenantId: string): Promise<DiscoveryLimits> {
  const defaults: DiscoveryLimits = {
    maxScansPerDay: envInt("DISCOVERY_MAX_SCANS_PER_DAY", 10),
    maxCandidatesPerScan: envInt("DISCOVERY_MAX_CANDIDATES_PER_SCAN", 200),
  };
  const r = await pool.query<{
    maxScansPerDay: number | null;
    maxCandidatesPerScan: number | null;
  }>(
    `SELECT "maxScansPerDay", "maxCandidatesPerScan"
       FROM "DiscoveryQuotaOverride" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const o = r.rows[0];
  return {
    maxScansPerDay: o?.maxScansPerDay ?? defaults.maxScansPerDay,
    maxCandidatesPerScan: o?.maxCandidatesPerScan ?? defaults.maxCandidatesPerScan,
  };
}

/** Firmennamen normalisieren: lowercase, Rechtsformen + Satzzeichen raus.
 *  Dient als Dedup-/Vergleichsschluessel, nie als Anzeige. */
export function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(gmbh & co\.? kga?a?|gmbh & co\.? kg|se & co\.? kga?a?|ag & co\.? kg|gmbh|mbh|ag|se|kgaa|kg|ohg|gbr|ug|e\.?\s?k\.?|e\.?\s?v\.?|inc\.?|ltd\.?|co\.?)\b/g, " ")
    .replace(/\(haftungsbeschraenkt\)|\(haftungsbeschränkt\)/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * URL/Hostname → normierte KERN-Domain (Zielbild-Entscheidung: die
 * Website-Domain IST die Firmen-ID im Discovery-Kontext, weil die
 * HRB+Registergericht-ID der normalen Verarbeitung hier nicht
 * zuverlaessig vorliegt). Normierung: lowercase, www.-Praefix und
 * Sub-Domains runter auf die registrierbare Domain (Heuristik mit
 * den gaengigen Second-Level-TLDs), kein Pfad/Slash/Port.
 * null, wenn keine brauchbare Domain extrahierbar ist.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let host = input.trim().toLowerCase();
  try {
    host = new URL(host.startsWith("http") ? host : `https://${host}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take =
    labels.length > 2 && tld.length === 2 && SECOND_LEVEL.has(sld) ? 3 : 2;
  const core = labels.slice(-take).join(".");
  if (core.length < 4 || core.length > 100) return null;
  return core;
}

/** Discovery-ID = normierte Kern-Domain. Kandidaten ohne Website haben
 *  keine ID und werden nicht aufgenommen (Zielbild: komplett skippen). */
export function discoveryIdFor(c: { domain?: string | null }): string | null {
  return normalizeDomain(c.domain);
}

export type StartScanResult =
  | { ok: true; scanId: string; limits: DiscoveryLimits; scansUsedToday: number }
  | { ok: false; reason: "quota"; limits: DiscoveryLimits; scansUsedToday: number };

export async function startScan(
  pool: Pool,
  args: { tenantId: string; actorId: string; ort: string; radiusKm: number },
): Promise<StartScanResult> {
  await ensureSchema(pool);
  const limits = await effectiveLimits(pool, args.tenantId);
  const used = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "DiscoveryScan"
      WHERE "tenantId" = $1 AND "startedAt" >= date_trunc('day', NOW())`,
    [args.tenantId],
  );
  const scansUsedToday = used.rows[0]?.n ?? 0;
  if (scansUsedToday >= limits.maxScansPerDay) {
    return { ok: false, reason: "quota", limits, scansUsedToday };
  }
  const scanId = createHash("sha256")
    .update(`${args.tenantId}|${args.actorId}|${Date.now()}|${Math.random()}`)
    .digest("hex")
    .slice(0, 24);
  await pool.query(
    `INSERT INTO "DiscoveryScan" ("scanId", "tenantId", "actorId", ort, "radiusKm")
     VALUES ($1, $2, $3, $4, $5)`,
    [scanId, args.tenantId, args.actorId, args.ort.slice(0, 120), args.radiusKm],
  );
  return { ok: true, scanId, limits, scansUsedToday: scansUsedToday + 1 };
}

export interface CandidateInput {
  name: string;
  city?: string | null;
  plz?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Website — Pflicht. Kandidaten ohne verwertbare Domain werden
   *  verworfen (Zielbild: ohne Website keine Beruecksichtigung). */
  domain: string;
  /** Quell-Kategorie (z. B. Google-Places-Kategorie, OSM office-Tag). */
  category?: string | null;
  /** Weitere Quell-Metadaten (Rating, Telefon, …) — roh, klein halten. */
  meta?: Record<string, unknown> | null;
  /** Vom Aufrufer bereits bekannte master-data-ID (Register-Kanal) —
   *  hat Vorrang vor dem Fuzzy-Dedup der Route. */
  masterCompanyId?: string | null;
  source: string;
}

export interface AddCandidatesResult {
  added: number;
  updated: number;
  /** Wegen Kandidaten-Cap des Scans verworfen. */
  capped: number;
  /** Ohne verwertbare Website-Domain verworfen (Zielbild-Regel). */
  skippedNoDomain: number;
  /** discoveryId → masterCompanyId fuer bereits bekannte Firmen. */
  known: Record<string, string>;
}

/**
 * Kandidaten-Batch in den geteilten Bestand mergen. Upsert per
 * discoveryId; vorhandene Zeilen werden nur mit BESSEREN Daten
 * angereichert (COALESCE-Richtung: Bestand gewinnt, Luecken werden
 * gefuellt). masterCompanyIds kommen vom Aufrufer (Dedup-Hook in der
 * Route — master-data-Fuzzy per Dry-Run).
 */
export async function addCandidates(
  pool: Pool,
  args: {
    scanId: string;
    tenantId: string;
    candidates: CandidateInput[];
    masterIds: Map<string, string>;
  },
): Promise<AddCandidatesResult | { error: "scan_not_found" | "cap_exhausted" }> {
  await ensureSchema(pool);
  const scan = await pool.query<{ tenantId: string; candidatesAdded: number }>(
    `SELECT "tenantId", "candidatesAdded" FROM "DiscoveryScan" WHERE "scanId" = $1`,
    [args.scanId],
  );
  if (scan.rows.length === 0 || scan.rows[0].tenantId !== args.tenantId) {
    return { error: "scan_not_found" };
  }
  const limits = await effectiveLimits(pool, args.tenantId);
  const room = limits.maxCandidatesPerScan - scan.rows[0].candidatesAdded;
  if (room <= 0) return { error: "cap_exhausted" };

  const seen = new Set<string>();
  const rows: Array<CandidateInput & { discoveryId: string; nameNormalized: string }> = [];
  let skippedNoDomain = 0;
  for (const c of args.candidates) {
    const name = c.name?.trim();
    if (!name) continue;
    const discoveryId = discoveryIdFor(c);
    if (!discoveryId) {
      skippedNoDomain++;
      continue;
    }
    if (seen.has(discoveryId)) continue;
    seen.add(discoveryId);
    rows.push({
      ...c,
      name: name.slice(0, 300),
      domain: discoveryId,
      discoveryId,
      nameNormalized: normalizeCompanyName(name).slice(0, 300),
    });
  }
  const capped = Math.max(0, rows.length - room);
  const batch = rows.slice(0, room);
  if (batch.length === 0) {
    return { added: 0, updated: 0, capped, skippedNoDomain, known: {} };
  }

  let added = 0;
  let updated = 0;
  const known: Record<string, string> = {};
  for (const r of batch) {
    const masterId =
      r.masterCompanyId ?? args.masterIds.get(r.discoveryId) ?? null;
    if (masterId) known[r.discoveryId] = masterId;
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO "DiscoveredCompany"
         ("discoveryId", name, "nameNormalized", city, plz, lat, lon, domain, category, "metaJson", source, "masterCompanyId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT ("discoveryId") DO UPDATE SET
         city = COALESCE("DiscoveredCompany".city, EXCLUDED.city),
         plz = COALESCE("DiscoveredCompany".plz, EXCLUDED.plz),
         lat = COALESCE("DiscoveredCompany".lat, EXCLUDED.lat),
         lon = COALESCE("DiscoveredCompany".lon, EXCLUDED.lon),
         category = COALESCE("DiscoveredCompany".category, EXCLUDED.category),
         "metaJson" = COALESCE("DiscoveredCompany"."metaJson", EXCLUDED."metaJson"),
         "masterCompanyId" = COALESCE("DiscoveredCompany"."masterCompanyId", EXCLUDED."masterCompanyId"),
         "updatedAt" = NOW()
       RETURNING (xmax = 0) AS inserted`,
      [
        r.discoveryId,
        r.name,
        r.nameNormalized,
        r.city?.trim().slice(0, 120) ?? null,
        r.plz?.trim().slice(0, 10) ?? null,
        r.lat ?? null,
        r.lon ?? null,
        r.domain,
        r.category?.trim().slice(0, 120) ?? null,
        r.meta ? JSON.stringify(r.meta).slice(0, 4000) : null,
        r.source.slice(0, 20),
        masterId,
      ],
    );
    if (res.rows[0]?.inserted) added++;
    else updated++;
  }
  await pool.query(
    `UPDATE "DiscoveryScan" SET "candidatesAdded" = "candidatesAdded" + $2
      WHERE "scanId" = $1`,
    [args.scanId, batch.length],
  );
  return { added, updated, capped, skippedNoDomain, known };
}

// ---- Kanal 3 (Phase 4): Register-Bestand im Umkreis ------------------------
//
// master-data's globale GermanCompany-Tabelle (HRB-basiert) liegt auf
// demselben MPG-Cluster in der DB ava_master_data — nur das
// Datenbank-Segment der URL unterscheidet sich (Muster db-urls.ts).
// Lesender Zugriff mit hartem Pool-Cap 2 (geteiltes
// Verbindungsbudget!).

let masterPool: Pool | null = null;

function getMasterDataPool(): Pool {
  if (masterPool) return masterPool;
  const url = new URL(loadEnv().DATABASE_URL);
  url.pathname = "/ava_master_data";
  masterPool = new pg.Pool({
    connectionString: url.toString(),
    max: 2,
    idleTimeoutMillis: 30_000,
  });
  masterPool.on("error", (err) => {
    console.warn("[discovery] master-data pool error:", err.message);
  });
  return masterPool;
}

export interface RegisterCandidate {
  companyId: string;
  name: string;
  location: string;
}

/**
 * Firmen aus dem globalen Register-Bestand (GermanCompany), deren
 * Sitzort in der uebergebenen Ortsmenge liegt und die im Radar noch
 * NICHT als Kandidat existieren und noch nie in AVA verarbeitet
 * wurden (Proxy: CompanyNameCache). Der Aufrufer (Desktop-Scan)
 * ermittelt anschliessend die Website — ohne Website kein Kandidat
 * (A8).
 */
export async function findRegisterCandidates(
  gatewayPool: Pool,
  placeNames: string[],
  limit: number,
): Promise<RegisterCandidate[]> {
  await ensureSchema(gatewayPool);
  const places = [...new Set(placeNames.map((p) => p.trim()).filter(Boolean))];
  if (places.length === 0) return [];
  let rows: RegisterCandidate[];
  try {
    const r = await getMasterDataPool().query<RegisterCandidate>(
      `SELECT "companyId", name, location FROM "GermanCompany"
        WHERE location = ANY($1::text[])
        ORDER BY "companyId"
        LIMIT $2`,
      [places, Math.min(500, limit * 10)],
    );
    rows = r.rows;
  } catch (err) {
    console.warn("[discovery] register query failed:", err);
    return [];
  }
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.companyId);
  const [known, cached] = await Promise.all([
    gatewayPool.query<{ masterCompanyId: string }>(
      `SELECT "masterCompanyId" FROM "DiscoveredCompany"
        WHERE "masterCompanyId" = ANY($1::text[])`,
      [ids],
    ),
    gatewayPool
      .query<{ companyId: string }>(
        `SELECT "companyId" FROM "CompanyNameCache"
          WHERE "companyId" = ANY($1::text[])`,
        [ids],
      )
      .catch(() => ({ rows: [] as Array<{ companyId: string }> })),
  ]);
  const exclude = new Set<string>([
    ...known.rows.map((r) => r.masterCompanyId),
    ...cached.rows.map((r) => r.companyId),
  ]);
  return rows.filter((r) => !exclude.has(r.companyId)).slice(0, limit);
}

/** Juengste Verwerf-Entscheidungen MIT Grund (Feedback-Loop Phase 4):
 *  fliessen als Nutzer-Praeferenzen in den Match-Prompt ein. */
export async function listDismissedWithReasons(
  pool: Pool,
  userId: string,
  limit: number,
): Promise<Array<{ discoveryId: string; name: string; reason: string; decidedAt: string }>> {
  await ensureSchema(pool);
  const r = await pool.query(
    `SELECT dd."discoveryId", dc.name, dd.reason, dd."decidedAt"
       FROM "DiscoveryDecision" dd
       JOIN "DiscoveredCompany" dc ON dc."discoveryId" = dd."discoveryId"
      WHERE dd."userId" = $1 AND dd.decision = 'dismissed'
        AND dd.reason IS NOT NULL AND length(trim(dd.reason)) > 0
      ORDER BY dd."decidedAt" DESC
      LIMIT $2`,
    [userId, limit],
  );
  return r.rows.map((row) => ({
    discoveryId: row.discoveryId,
    name: row.name,
    reason: row.reason,
    decidedAt: new Date(row.decidedAt).toISOString(),
  }));
}

export type SaveProfileResult =
  | { saved: true }
  | { skipped: "fresh"; profiledAt: string }
  | { error: "not_found" };

/**
 * Mini-Profil (Phase 2) speichern. Setzt profiledAt = NOW() und baut
 * den deutschen tsvector fuer die BM25-Suche (Phase 3).
 *
 * Verarbeitungs-Sperre A9: Ist bereits ein Profil juenger als 6 Monate
 * vorhanden, wird NICHT ueberschrieben — der Aufrufer bekommt
 * {skipped: "fresh"} samt Zeitstempel. So koennen sich mehrere Nutzer
 * nicht gegenseitig Verarbeitungs-Kosten verursachen.
 */
export async function saveProfile(
  pool: Pool,
  args: {
    discoveryId: string;
    profileJson: Record<string, unknown>;
    profileText: string;
    embedding: number[] | null;
  },
): Promise<SaveProfileResult> {
  await ensureSchema(pool);
  const updated = await pool.query(
    `UPDATE "DiscoveredCompany" SET
       "profileJson" = $2,
       "profileText" = $3,
       tsv = to_tsvector('german', left($3, 20000)),
       embedding = $4,
       "profiledAt" = NOW(),
       "updatedAt" = NOW()
     WHERE "discoveryId" = $1
       AND ("profiledAt" IS NULL OR "profiledAt" < NOW() - INTERVAL '6 months')`,
    [
      args.discoveryId,
      JSON.stringify(args.profileJson).slice(0, 8000),
      args.profileText.slice(0, 20000),
      args.embedding,
    ],
  );
  if ((updated.rowCount ?? 0) > 0) return { saved: true };
  const existing = await pool.query<{ profiledAt: Date | null }>(
    `SELECT "profiledAt" FROM "DiscoveredCompany" WHERE "discoveryId" = $1`,
    [args.discoveryId],
  );
  if (existing.rows.length === 0) return { error: "not_found" };
  const at = existing.rows[0].profiledAt;
  return { skipped: "fresh", profiledAt: at ? at.toISOString() : "" };
}

export interface CandidateRow {
  discoveryId: string;
  name: string;
  city: string | null;
  plz: string | null;
  lat: number | null;
  lon: number | null;
  domain: string;
  category: string | null;
  source: string;
  masterCompanyId: string | null;
  profiledAt: string | null;
  decision: string | null;
  /** Nur bei withProfiles=true befuellt (Match-Lauf, Phase 3). */
  profileJson?: Record<string, unknown> | null;
  profileText?: string | null;
  embedding?: number[] | null;
}

/** Entscheidungen (imported/dismissed) fuer einen Nutzer upserten.
 *  Idempotent; eine neue Entscheidung ueberschreibt die alte. */
export async function saveDecisions(
  pool: Pool,
  args: {
    userId: string;
    decisions: Array<{ discoveryId: string; decision: "imported" | "dismissed"; reason?: string | null }>;
  },
): Promise<{ saved: number }> {
  await ensureSchema(pool);
  let saved = 0;
  for (const d of args.decisions) {
    const r = await pool.query(
      `INSERT INTO "DiscoveryDecision" ("userId", "discoveryId", decision, reason)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ("userId", "discoveryId") DO UPDATE SET
         decision = EXCLUDED.decision,
         reason = EXCLUDED.reason,
         "decidedAt" = NOW()`,
      [args.userId, d.discoveryId, d.decision, d.reason?.slice(0, 500) ?? null],
    );
    saved += r.rowCount ?? 0;
  }
  return { saved };
}

/** Kandidaten im Radius (oder alle neuesten), mit der Entscheidung des
 *  anfragenden Nutzers gejoint. Default: bereits ENTSCHIEDENE
 *  (importiert/verworfen) fliegen raus — Zielbild: die Kandidaten-
 *  Tabelle zeigt nur Offenes und macht nach einer Entscheidung Platz. */
export async function listCandidates(
  pool: Pool,
  args: {
    userId: string;
    lat?: number;
    lon?: number;
    radiusKm?: number;
    limit: number;
    includeDecided?: boolean;
    /** Profil-Text + Embedding mitliefern (Match-Lauf). Impliziert
     *  "nur profilierte Kandidaten". */
    withProfiles?: boolean;
  },
): Promise<CandidateRow[]> {
  await ensureSchema(pool);
  const params: unknown[] = [args.userId];
  const conditions: string[] = [];
  if (!args.includeDecided) {
    conditions.push("dd.decision IS NULL");
  }
  if (args.withProfiles) {
    conditions.push(`dc."profiledAt" IS NOT NULL`);
  }
  if (
    args.lat !== undefined &&
    args.lon !== undefined &&
    args.radiusKm !== undefined
  ) {
    const latDelta = args.radiusKm / 111;
    const lonDelta =
      args.radiusKm / (111 * Math.max(0.2, Math.cos((args.lat * Math.PI) / 180)));
    params.push(
      args.lat - latDelta,
      args.lat + latDelta,
      args.lon - lonDelta,
      args.lon + lonDelta,
    );
    // Kandidaten OHNE Koordinaten (v. a. Register-Kanal: nur Sitzort-
    // Name) duerfen nicht stillschweigend am Geo-Filter scheitern —
    // NULL BETWEEN waere NULL und die Zeile fiele raus, obwohl sie aus
    // einem ortsgebundenen Scan stammt. Der LLM-Match sieht den Ort im
    // Profil und kann selbst abwerten.
    conditions.push(
      `((dc.lat BETWEEN $${params.length - 3} AND $${params.length - 2} AND dc.lon BETWEEN $${params.length - 1} AND $${params.length}) OR dc.lat IS NULL)`,
    );
  }
  params.push(args.limit);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const profileCols = args.withProfiles
    ? `, dc."profileJson", dc."profileText", dc.embedding`
    : "";
  const r = await pool.query(
    `SELECT dc."discoveryId", dc.name, dc.city, dc.plz, dc.lat, dc.lon,
            dc.domain, dc.category, dc.source, dc."masterCompanyId",
            dc."profiledAt", dd.decision${profileCols}
       FROM "DiscoveredCompany" dc
       LEFT JOIN "DiscoveryDecision" dd
         ON dd."discoveryId" = dc."discoveryId" AND dd."userId" = $1
      ${where}
      ORDER BY dc."updatedAt" DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    discoveryId: row.discoveryId,
    name: row.name,
    city: row.city,
    plz: row.plz,
    lat: row.lat,
    lon: row.lon,
    domain: row.domain,
    category: row.category,
    source: row.source,
    masterCompanyId: row.masterCompanyId,
    profiledAt: row.profiledAt ? new Date(row.profiledAt).toISOString() : null,
    decision: row.decision,
    ...(args.withProfiles
      ? {
          profileJson: row.profileJson ?? null,
          profileText: row.profileText ?? null,
          embedding: row.embedding ?? null,
        }
      : {}),
  }));
}
