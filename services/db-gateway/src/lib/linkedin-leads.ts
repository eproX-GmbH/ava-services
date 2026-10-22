// LinkedIn-Leads (docs/PLAN_LINKEDIN_LEADS.md L1): Personen, die auf einen beobachteten
// Post reagiert oder kommentiert haben, je Tenant. Einheit ist die Person mit Anlass;
// die Firma haengt als Kontext dran (Domain = Discovery-ID, Mini-Profil ueber
// DiscoveredCompany). Kein ICP-Tor: der Score wird nur gespiegelt.
//
// Aufbewahrung: offene/ungeklaerte Leads verfallen nach AUFBEWAHRUNG_TAGE (Verhaltens-
// daten Unbeteiligter, PLAN_LINKEDIN_WATCHLIST §8.2). Uebernommene und ignorierte
// bleiben als Protokoll, Kommentartexte werden beim Ignorieren geleert.

import { createHash } from "node:crypto";
import type { Pool } from "pg";

export const AUFBEWAHRUNG_TAGE = 90;

export type LeadStatus = "offen" | "uebernommen" | "ignoriert" | "ungeklaert";

export interface LeadEingabe {
  postUrl: string;
  postTitel?: string | null;
  personName: string | null;
  profileUrl: string;
  headline?: string | null;
  rolle?: string | null;
  aktivitaet: "reaction" | "comment";
  reactionType?: string | null;
  kommentar?: string | null;
  firmaDomain?: string | null;
  firmaName?: string | null;
  konfidenz?: number | null;
  /** ungeklaert = keine belastbare Firma (kein Raten). */
  status?: "offen" | "ungeklaert";
  grund?: string | null;
}

export interface LeadZeile {
  id: string;
  postUrl: string;
  postTitel: string | null;
  personName: string | null;
  profileUrl: string;
  headline: string | null;
  rolle: string | null;
  aktivitaet: string;
  reactionType: string | null;
  kommentar: string | null;
  firmaDomain: string | null;
  firmaName: string | null;
  companyId: string | null;
  konfidenz: number | null;
  status: LeadStatus;
  grund: string | null;
  ignoriertGrund: string | null;
  personId: string | null;
  uebernommenAt: string | null;
  /** Leads gelten je Organisation: wer uebernommen/ignoriert hat (Name oder E-Mail aus der Mitgliederliste). */
  uebernommenVon: string | null;
  ignoriertVon: string | null;
  createdAt: string;
  /** Aus DiscoveredCompany (Mini-Profil), wenn vorhanden. */
  firmaOrt: string | null;
  firmaPlz: string | null;
  firmaBranche: string | null;
  firmaKurz: string | null;
  masterCompanyId: string | null;
  /** Wie oft dieselbe Person insgesamt reagiert hat (ueber alle Posts). */
  reaktionen: number;
}

let schemaReady = false;

export async function ensureLeadsSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "LinkedInLead" (
      "id"            TEXT PRIMARY KEY,
      "tenantId"      TEXT NOT NULL,
      "actorId"       TEXT,
      "postUrl"       TEXT NOT NULL,
      "postTitel"     TEXT,
      "personName"    TEXT,
      "profileUrl"    TEXT NOT NULL,
      "headline"      TEXT,
      "rolle"         TEXT,
      "aktivitaet"    TEXT NOT NULL,
      "reactionType"  TEXT,
      "kommentar"     TEXT,
      "firmaDomain"   TEXT,
      "firmaName"     TEXT,
      "companyId"     TEXT,
      "konfidenz"     DOUBLE PRECISION,
      "status"        TEXT NOT NULL DEFAULT 'offen',
      "grund"         TEXT,
      "ignoriertGrund" TEXT,
      "personId"      TEXT,
      "uebernommenAt" TIMESTAMPTZ,
      "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "loeschenAb"    TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "LinkedInLead_tenant_person_post_idx"
      ON "LinkedInLead" ("tenantId", "profileUrl", "postUrl");
    CREATE INDEX IF NOT EXISTS "LinkedInLead_tenant_status_idx"
      ON "LinkedInLead" ("tenantId", "status", "createdAt" DESC);
    ALTER TABLE "LinkedInLead" ADD COLUMN IF NOT EXISTS "uebernommenVon" TEXT;
    ALTER TABLE "LinkedInLead" ADD COLUMN IF NOT EXISTS "ignoriertVon" TEXT;
  `);
  schemaReady = true;
}

function leadId(tenantId: string, profileUrl: string, postUrl: string): string {
  return createHash("sha256").update(`${tenantId}|${profileUrl}|${postUrl}`).digest("hex").slice(0, 24);
}

/** Leads eines Laufs ablegen; je (Person, Post) genau einer. Vorhandene bleiben unveraendert,
 *  ausser ein bisher ungeklaerter Lead bekommt jetzt eine Firma. */
export async function leadsAblegen(pool: Pool, tenantId: string, actorId: string | null, leads: LeadEingabe[]): Promise<{ neu: number; aktualisiert: number; vorhanden: number }> {
  await ensureLeadsSchema(pool);
  let neu = 0;
  let aktualisiert = 0;
  let vorhanden = 0;
  for (const l of leads) {
    const id = leadId(tenantId, l.profileUrl, l.postUrl);
    const status = l.status ?? (l.firmaDomain ? "offen" : "ungeklaert");
    const r = await pool.query<{ eingefuegt: boolean; aktualisiert: boolean }>(
      `INSERT INTO "LinkedInLead" ("id", "tenantId", "actorId", "postUrl", "postTitel", "personName", "profileUrl", "headline", "rolle",
                                   "aktivitaet", "reactionType", "kommentar", "firmaDomain", "firmaName", "konfidenz", "status", "grund", "loeschenAb")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW() + ($18 || ' days')::interval)
       ON CONFLICT ("tenantId", "profileUrl", "postUrl") DO UPDATE SET
         "firmaDomain" = COALESCE("LinkedInLead"."firmaDomain", EXCLUDED."firmaDomain"),
         "firmaName"   = COALESCE("LinkedInLead"."firmaName", EXCLUDED."firmaName"),
         "rolle"       = COALESCE("LinkedInLead"."rolle", EXCLUDED."rolle"),
         "konfidenz"   = COALESCE("LinkedInLead"."konfidenz", EXCLUDED."konfidenz"),
         "postTitel"   = COALESCE("LinkedInLead"."postTitel", EXCLUDED."postTitel"),
         "status"      = CASE WHEN "LinkedInLead"."status" = 'ungeklaert' AND EXCLUDED."firmaDomain" IS NOT NULL THEN 'offen' ELSE "LinkedInLead"."status" END,
         "updatedAt"   = NOW()
       RETURNING (xmax = 0) AS eingefuegt,
                 (xmax <> 0 AND "LinkedInLead"."status" = 'offen' AND "LinkedInLead"."firmaDomain" IS NOT NULL) AS aktualisiert`,
      [id, tenantId, actorId, l.postUrl, l.postTitel ?? null, l.personName, l.profileUrl, l.headline ?? null, l.rolle ?? null,
       l.aktivitaet, l.reactionType ?? null, l.kommentar?.slice(0, 200) ?? null, l.firmaDomain ?? null, l.firmaName ?? null, l.konfidenz ?? null, status, l.grund ?? null, String(AUFBEWAHRUNG_TAGE)],
    );
    if (r.rows[0]?.eingefuegt) neu++;
    else if (r.rows[0]?.aktualisiert) aktualisiert++;
    else vorhanden++;
  }
  return { neu, aktualisiert, vorhanden };
}

/** Abgelaufene offene/ungeklaerte Leads entfernen (bei jedem Listenaufruf, billig). */
async function aufraeumen(pool: Pool, tenantId: string): Promise<void> {
  await pool.query(`DELETE FROM "LinkedInLead" WHERE "tenantId" = $1 AND "status" IN ('offen', 'ungeklaert') AND "loeschenAb" < NOW()`, [tenantId]).catch(() => undefined);
}

export async function leadsListe(pool: Pool, tenantId: string, q: { status?: LeadStatus | "alle"; postUrl?: string; nurKommentare?: boolean; seite: number; groesse: number }): Promise<{ gesamt: number; items: LeadZeile[] }> {
  await ensureLeadsSchema(pool);
  await aufraeumen(pool, tenantId);
  const params: unknown[] = [tenantId];
  const bed: string[] = [`l."tenantId" = $1`];
  if (q.status && q.status !== "alle") { params.push(q.status); bed.push(`l."status" = $${params.length}`); }
  else if (!q.status) bed.push(`l."status" IN ('offen', 'ungeklaert')`);
  if (q.postUrl) { params.push(q.postUrl); bed.push(`l."postUrl" = $${params.length}`); }
  if (q.nurKommentare) bed.push(`l."aktivitaet" = 'comment'`);
  const where = bed.join(" AND ");
  const n = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "LinkedInLead" l WHERE ${where}`, params);
  params.push(q.groesse, (q.seite - 1) * q.groesse);
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT l.*, dc."city" AS "firmaOrt", dc."plz" AS "firmaPlz", dc."masterCompanyId",
            dc."profileJson"->>'branche' AS "firmaBranche", dc."profileJson"->>'kurzbeschreibung' AS "firmaKurz",
            (SELECT COUNT(*) FROM "LinkedInLead" x WHERE x."tenantId" = l."tenantId" AND x."profileUrl" = l."profileUrl")::int AS "reaktionen",
            COALESCE(mu."name", mu."email") AS "uebernommenVonName", COALESCE(mi."name", mi."email") AS "ignoriertVonName"
       FROM "LinkedInLead" l
       LEFT JOIN "DiscoveredCompany" dc ON dc."discoveryId" = l."firmaDomain"
       LEFT JOIN "TenantMember" mu ON mu."actorId" = l."uebernommenVon"
       LEFT JOIN "TenantMember" mi ON mi."actorId" = l."ignoriertVon"
      WHERE ${where}
      ORDER BY (l."aktivitaet" = 'comment') DESC, l."createdAt" DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { gesamt: Number(n.rows[0]?.n ?? 0), items: rows.rows.map(zeile) };
}

function zeile(r: Record<string, unknown>): LeadZeile {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null);
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : null);
  return {
    id: String(r.id),
    postUrl: String(r.postUrl),
    postTitel: s("postTitel"),
    personName: s("personName"),
    profileUrl: String(r.profileUrl),
    headline: s("headline"),
    rolle: s("rolle"),
    aktivitaet: String(r.aktivitaet),
    reactionType: s("reactionType"),
    kommentar: s("kommentar"),
    firmaDomain: s("firmaDomain"),
    firmaName: s("firmaName"),
    companyId: s("companyId"),
    konfidenz: typeof r.konfidenz === "number" ? r.konfidenz : null,
    status: String(r.status) as LeadStatus,
    grund: s("grund"),
    ignoriertGrund: s("ignoriertGrund"),
    personId: s("personId"),
    uebernommenAt: iso(r.uebernommenAt),
    uebernommenVon: s("uebernommenVonName") ?? s("uebernommenVon"),
    ignoriertVon: s("ignoriertVonName") ?? s("ignoriertVon"),
    createdAt: iso(r.createdAt) ?? new Date().toISOString(),
    firmaOrt: s("firmaOrt"),
    firmaPlz: s("firmaPlz"),
    firmaBranche: s("firmaBranche"),
    firmaKurz: s("firmaKurz"),
    masterCompanyId: s("masterCompanyId"),
    reaktionen: Number(r.reaktionen ?? 1),
  };
}

export async function leadsPosts(pool: Pool, tenantId: string): Promise<Array<{ postUrl: string; postTitel: string | null; leads: number; offen: number; kommentare: number; uebernommen: number; ungeklaert: number; zuletzt: string }>> {
  await ensureLeadsSchema(pool);
  const r = await pool.query<Record<string, unknown>>(
    `SELECT "postUrl", MAX("postTitel") AS "postTitel", COUNT(*)::int AS leads,
            COUNT(*) FILTER (WHERE "status" = 'offen')::int AS offen,
            COUNT(*) FILTER (WHERE "aktivitaet" = 'comment')::int AS kommentare,
            COUNT(*) FILTER (WHERE "status" = 'uebernommen')::int AS uebernommen,
            COUNT(*) FILTER (WHERE "status" = 'ungeklaert')::int AS ungeklaert,
            MAX("createdAt") AS zuletzt
       FROM "LinkedInLead" WHERE "tenantId" = $1 GROUP BY "postUrl" ORDER BY MAX("createdAt") DESC`,
    [tenantId],
  );
  return r.rows.map((x) => ({
    postUrl: String(x.postUrl),
    postTitel: typeof x.postTitel === "string" ? x.postTitel : null,
    leads: Number(x.leads), offen: Number(x.offen), kommentare: Number(x.kommentare), uebernommen: Number(x.uebernommen), ungeklaert: Number(x.ungeklaert),
    zuletzt: x.zuletzt instanceof Date ? x.zuletzt.toISOString() : String(x.zuletzt),
  }));
}

export async function leadAendern(pool: Pool, tenantId: string, id: string, patch: { status?: LeadStatus; ignoriertGrund?: string | null; companyId?: string | null; personId?: string | null; firmaDomain?: string | null; firmaName?: string | null }, actorId: string | null = null): Promise<LeadZeile | null> {
  await ensureLeadsSchema(pool);
  const sets: string[] = [`"updatedAt" = NOW()`];
  const params: unknown[] = [tenantId, id];
  const setze = (spalte: string, wert: unknown) => { params.push(wert); sets.push(`"${spalte}" = $${params.length}`); };
  if (patch.status) {
    setze("status", patch.status);
    if (patch.status === "uebernommen") { sets.push(`"uebernommenAt" = NOW()`, `"loeschenAb" = NULL`); setze("uebernommenVon", actorId); }
    if (patch.status === "ignoriert") { sets.push(`"kommentar" = NULL`, `"loeschenAb" = NOW() + interval '365 days'`); setze("ignoriertVon", actorId); }
    if (patch.status === "offen") sets.push(`"uebernommenAt" = NULL`, `"uebernommenVon" = NULL`, `"ignoriertVon" = NULL`, `"loeschenAb" = NOW() + interval '${AUFBEWAHRUNG_TAGE} days'`);
  }
  if (patch.ignoriertGrund !== undefined) setze("ignoriertGrund", patch.ignoriertGrund);
  if (patch.companyId !== undefined) setze("companyId", patch.companyId);
  if (patch.personId !== undefined) setze("personId", patch.personId);
  if (patch.firmaDomain !== undefined) setze("firmaDomain", patch.firmaDomain);
  if (patch.firmaName !== undefined) setze("firmaName", patch.firmaName);
  const r = await pool.query<Record<string, unknown>>(`UPDATE "LinkedInLead" SET ${sets.join(", ")} WHERE "tenantId" = $1 AND "id" = $2 RETURNING *`, params);
  const row = r.rows[0];
  return row ? zeile({ ...row, reaktionen: 1 }) : null;
}

export async function leadLesen(pool: Pool, tenantId: string, id: string): Promise<LeadZeile | null> {
  const r = await leadsListeNachId(pool, tenantId, id);
  return r;
}

async function leadsListeNachId(pool: Pool, tenantId: string, id: string): Promise<LeadZeile | null> {
  await ensureLeadsSchema(pool);
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT l.*, dc."city" AS "firmaOrt", dc."plz" AS "firmaPlz", dc."masterCompanyId",
            dc."profileJson"->>'branche' AS "firmaBranche", dc."profileJson"->>'kurzbeschreibung' AS "firmaKurz", 1 AS reaktionen,
            COALESCE(mu."name", mu."email") AS "uebernommenVonName", COALESCE(mi."name", mi."email") AS "ignoriertVonName"
       FROM "LinkedInLead" l LEFT JOIN "DiscoveredCompany" dc ON dc."discoveryId" = l."firmaDomain"
       LEFT JOIN "TenantMember" mu ON mu."actorId" = l."uebernommenVon"
       LEFT JOIN "TenantMember" mi ON mi."actorId" = l."ignoriertVon"
      WHERE l."tenantId" = $1 AND l."id" = $2`,
    [tenantId, id],
  );
  return rows.rows[0] ? zeile(rows.rows[0]) : null;
}
