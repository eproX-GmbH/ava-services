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
import type { Pool } from "pg";

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
      domain            TEXT,
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

export function discoveryIdFor(c: { name: string; city?: string | null; domain?: string | null }): string {
  const key = c.domain
    ? `d:${c.domain.toLowerCase()}`
    : `n:${normalizeCompanyName(c.name)}|${(c.city ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
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
  domain?: string | null;
  source: string;
}

export interface AddCandidatesResult {
  added: number;
  updated: number;
  /** Wegen Kandidaten-Cap des Scans verworfen. */
  capped: number;
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
  for (const c of args.candidates) {
    const name = c.name?.trim();
    if (!name) continue;
    const discoveryId = discoveryIdFor(c);
    if (seen.has(discoveryId)) continue;
    seen.add(discoveryId);
    rows.push({
      ...c,
      name: name.slice(0, 300),
      discoveryId,
      nameNormalized: normalizeCompanyName(name).slice(0, 300),
    });
  }
  const capped = Math.max(0, rows.length - room);
  const batch = rows.slice(0, room);
  if (batch.length === 0) {
    return { added: 0, updated: 0, capped, known: {} };
  }

  let added = 0;
  let updated = 0;
  const known: Record<string, string> = {};
  for (const r of batch) {
    const masterId = args.masterIds.get(r.discoveryId) ?? null;
    if (masterId) known[r.discoveryId] = masterId;
    const res = await pool.query<{ inserted: boolean }>(
      `INSERT INTO "DiscoveredCompany"
         ("discoveryId", name, "nameNormalized", city, plz, lat, lon, domain, source, "masterCompanyId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT ("discoveryId") DO UPDATE SET
         city = COALESCE("DiscoveredCompany".city, EXCLUDED.city),
         plz = COALESCE("DiscoveredCompany".plz, EXCLUDED.plz),
         lat = COALESCE("DiscoveredCompany".lat, EXCLUDED.lat),
         lon = COALESCE("DiscoveredCompany".lon, EXCLUDED.lon),
         domain = COALESCE("DiscoveredCompany".domain, EXCLUDED.domain),
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
        r.domain?.toLowerCase().slice(0, 200) ?? null,
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
  return { added, updated, capped, known };
}

export interface CandidateRow {
  discoveryId: string;
  name: string;
  city: string | null;
  plz: string | null;
  lat: number | null;
  lon: number | null;
  domain: string | null;
  source: string;
  masterCompanyId: string | null;
  profiledAt: string | null;
  decision: string | null;
}

/** Kandidaten im Radius (oder alle neuesten), mit der Entscheidung des
 *  anfragenden Nutzers gejoint. Verworfene bleiben sichtbar markiert —
 *  filtern ist Sache des Aufrufers. */
export async function listCandidates(
  pool: Pool,
  args: {
    userId: string;
    lat?: number;
    lon?: number;
    radiusKm?: number;
    limit: number;
  },
): Promise<CandidateRow[]> {
  await ensureSchema(pool);
  const params: unknown[] = [args.userId];
  let where = "";
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
    where = `WHERE dc.lat BETWEEN $2 AND $3 AND dc.lon BETWEEN $4 AND $5`;
  }
  params.push(args.limit);
  const r = await pool.query(
    `SELECT dc."discoveryId", dc.name, dc.city, dc.plz, dc.lat, dc.lon,
            dc.domain, dc.source, dc."masterCompanyId", dc."profiledAt",
            dd.decision
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
    source: row.source,
    masterCompanyId: row.masterCompanyId,
    profiledAt: row.profiledAt ? new Date(row.profiledAt).toISOString() : null,
    decision: row.decision,
  }));
}
