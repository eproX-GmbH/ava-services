// T4 (docs/PLAN_TENANT_MULTI_ACCOUNT.md) — Tenant-Zugehoerigkeit.
//
// Tabellen Tenant / TenantMember (Migration 20260903_tenants). Pflege
// vorerst manuell durch den Operator; dieses Modul sorgt nur dafuer,
// dass jeder authentifizierte User einen Tenant-Eintrag und eine
// Mitgliedschaft hat (Upsert beim /whoami-Aufruf, nicht pro Request),
// und liefert die Anzeige-Daten fuer den Desktop.

import type pg from "pg";
import { randomBytes } from "node:crypto";
import type { AuthContext } from "../middleware/auth";
import { moveUserToTenantGroup } from "./keycloak-admin";
import { invalidateMembership } from "./membership-cache";
import { invalidateFeatures } from "./policy-guard";
import { logger } from "./logger";

export interface TenantPolicyShape {
  features: Record<string, boolean>;
  providerLock: boolean;
  chatModel: string | null;
  producerModel: string | null;
  promptAudit: boolean;
}

export const DEFAULT_POLICY: TenantPolicyShape = {
  features: {},
  providerLock: false,
  chatModel: null,
  producerModel: null,
  promptAudit: false,
};

export interface WhoamiPayload {
  tenantId: string;
  actorId: string;
  scopes: string[];
  tenantName: string | null;
  role: string;
  memberCount: number;
  email: string | null;
  /** "claim" = tenant_id aus dem Token; "membership" = aus TenantMember (O2); "sub" = Kompatibilitaets-Fallback. */
  tenantSource: "claim" | "sub" | "membership";
  /** O1 */
  tenantKind: "personal" | "organisation";
  policy: TenantPolicyShape;
  /** O1 — offene Beitrittsanfrage des Nutzers (Zielorganisation), falls vorhanden. */
  openJoinRequest: { tenantId: string; tenantName: string | null; requestedAt: string } | null;
}

type Q = { query: pg.Pool["query"] };

async function readPolicy(q: Q, tenantId: string): Promise<TenantPolicyShape> {
  const r = await q.query<{ features: unknown; providerLock: boolean; chatModel: string | null; producerModel: string | null; promptAudit: boolean }>(
    `SELECT "features", "providerLock", "chatModel", "producerModel", "promptAudit" FROM "TenantPolicy" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const row = r.rows[0];
  if (!row) return DEFAULT_POLICY;
  const feats: Record<string, boolean> = {};
  if (row.features && typeof row.features === "object") {
    for (const [k, v] of Object.entries(row.features as Record<string, unknown>)) feats[k] = v !== false;
  }
  return { features: feats, providerLock: row.providerLock, chatModel: row.chatModel, producerModel: row.producerModel, promptAudit: row.promptAudit };
}

/** Keycloak-Gruppe nachziehen — best-effort NACH dem DB-Commit; ein
 *  Fehler dort beschaedigt die Gateway-Wahrheit nicht. */
async function syncKeycloak(actorId: string, tenantId: string, tenantName: string | null): Promise<void> {
  try {
    await moveUserToTenantGroup(actorId, tenantId, tenantName ?? tenantId);
  } catch (err) {
    logger.warn({ actorId, tenantId, err: err instanceof Error ? err.message : String(err) }, "keycloak group sync failed");
  }
}

/** Tenant + Mitgliedschaft sicherstellen und Anzeige-Daten lesen. */
export async function ensureTenantForAuth(
  pool: pg.Pool,
  auth: AuthContext,
): Promise<WhoamiPayload> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Name aus dem Claim uebernehmen, wenn der Tenant noch keinen hat
    // (Operator-Pflege gewinnt: vorhandener Name bleibt).
    await client.query(
      `INSERT INTO "Tenant" ("id", "name") VALUES ($1, $2)
       ON CONFLICT ("id") DO UPDATE
         SET "name" = COALESCE("Tenant"."name", EXCLUDED."name"),
             "updatedAt" = CASE WHEN "Tenant"."name" IS NULL AND EXCLUDED."name" IS NOT NULL
                                THEN CURRENT_TIMESTAMP ELSE "Tenant"."updatedAt" END`,
      [auth.tenantId, auth.tenantName ?? null],
    );
    // Genau ein Tenant je User: eine bestehende Mitgliedschaft in einem
    // ANDEREN Tenant wird NICHT stillschweigend umgehaengt (das ist
    // Operator-Sache) — dann bleibt die alte Zeile und der Claim ist
    // massgeblich fuer die Datenzuordnung; whoami zeigt beides.
    // Reparatur (2026-09-04): Mitgliedschaft in einem FREMDEN persoenlichen
    // Tenant (Kompatibilitaets-Altbestand "pilot") loeschen — persoenliche
    // Tenants sind per Definition id = sub. Der Insert darunter legt die
    // eigene Mitgliedschaft neu an.
    await client.query(
      `DELETE FROM "TenantMember" m USING "Tenant" t
       WHERE m."actorId" = $1 AND t."id" = m."tenantId" AND t."kind" = 'personal' AND m."tenantId" <> $1`,
      [auth.actorId],
    );
    await client.query(
      `INSERT INTO "TenantMember" ("tenantId", "actorId", "role")
       VALUES ($1, $2, $3)
       ON CONFLICT ("actorId") DO NOTHING`,
      [auth.tenantId, auth.actorId, auth.actorId === auth.tenantId ? "owner" : "member"],
    );
    const t = await client.query<{ name: string | null }>(
      `SELECT "name" FROM "Tenant" WHERE "id" = $1`,
      [auth.tenantId],
    );
    const m = await client.query<{ role: string; tenantId: string }>(
      `SELECT "role", "tenantId" FROM "TenantMember" WHERE "actorId" = $1`,
      [auth.actorId],
    );
    const n = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1`,
      [auth.tenantId],
    );
    const k = await client.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [auth.tenantId]);
    const jr = await client.query<{ tenantId: string; name: string | null; requestedAt: Date }>(
      `SELECT r."tenantId", t."name", r."requestedAt" FROM "TenantJoinRequest" r JOIN "Tenant" t ON t."id" = r."tenantId"
       WHERE r."actorId" = $1 AND r."status" = 'open' ORDER BY r."requestedAt" DESC LIMIT 1`,
      [auth.actorId],
    );
    const policy = await readPolicy(client, auth.tenantId);
    await client.query("COMMIT");
    const membership = m.rows[0];
    const open = jr.rows[0];
    return {
      tenantId: auth.tenantId,
      actorId: auth.actorId,
      scopes: auth.scopes,
      tenantName: t.rows[0]?.name ?? auth.tenantName ?? null,
      role: membership && membership.tenantId === auth.tenantId ? membership.role : "member",
      memberCount: Number(n.rows[0]?.n ?? "0"),
      email: auth.email ?? null,
      tenantSource: auth.tenantSource,
      tenantKind: k.rows[0]?.kind === "organisation" ? "organisation" : "personal",
      policy,
      openJoinRequest: open
        ? { tenantId: open.tenantId, tenantName: open.name, requestedAt: new Date(open.requestedAt).toISOString() }
        : null,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}


// ---- O1 — Organisationen -------------------------------------------------

export class TenantError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

function neuerInviteToken(): string {
  return randomBytes(18).toString("base64url");
}

async function istAdmin(q: Q, tenantId: string, actorId: string): Promise<boolean> {
  const r = await q.query<{ role: string }>(
    `SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`,
    [tenantId, actorId],
  );
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

/** Persoenlichen Tenant (id = sub) sicherstellen und Mitgliedschaft dorthin setzen. */
async function setzeAufPersoenlichenTenant(client: Q, actorId: string, email: string | null): Promise<void> {
  await client.query(
    `INSERT INTO "Tenant" ("id", "name", "kind") VALUES ($1, $2, 'personal')
     ON CONFLICT ("id") DO UPDATE SET "kind" = CASE WHEN "Tenant"."kind" = 'organisation' THEN "Tenant"."kind" ELSE 'personal' END`,
    [actorId, email],
  );
  await client.query(`DELETE FROM "TenantMember" WHERE "actorId" = $1`, [actorId]);
  await client.query(
    `INSERT INTO "TenantMember" ("tenantId", "actorId", "role") VALUES ($1, $1, 'owner')`,
    [actorId],
  );
}

export async function createOrganisation(
  pool: pg.Pool,
  auth: AuthContext,
  name: string,
): Promise<{ tenantId: string; name: string; inviteToken: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const aktuell = await client.query<{ kind: string }>(
      `SELECT t."kind" FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId" WHERE m."actorId" = $1`,
      [auth.actorId],
    );
    if (aktuell.rows[0]?.kind === "organisation") {
      throw new TenantError(409, "Du bist bereits Mitglied einer Organisation. Erst austreten, dann eine neue anlegen.");
    }
    const id = `org_${randomBytes(9).toString("base64url")}`;
    const inviteToken = neuerInviteToken();
    await client.query(
      `INSERT INTO "Tenant" ("id", "name", "kind", "inviteToken") VALUES ($1, $2, 'organisation', $3)`,
      [id, name, inviteToken],
    );
    await client.query(`INSERT INTO "TenantPolicy" ("tenantId", "updatedBy") VALUES ($1, $2)`, [id, auth.actorId]);
    await client.query(`DELETE FROM "TenantMember" WHERE "actorId" = $1`, [auth.actorId]);
    await client.query(
      `INSERT INTO "TenantMember" ("tenantId", "actorId", "role") VALUES ($1, $2, 'owner')`,
      [id, auth.actorId],
    );
    await client.query("COMMIT");
    invalidateMembership(auth.actorId);
    void syncKeycloak(auth.actorId, id, name);
    return { tenantId: id, name, inviteToken };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function requestJoin(
  pool: pg.Pool,
  auth: AuthContext,
  inviteToken: string,
): Promise<{ requestId: string; tenantId: string; tenantName: string | null }> {
  const t = await pool.query<{ id: string; name: string | null }>(
    `SELECT "id", "name" FROM "Tenant" WHERE "inviteToken" = $1 AND "kind" = 'organisation'`,
    [inviteToken],
  );
  const ziel = t.rows[0];
  if (!ziel) throw new TenantError(404, "Einladungslink ungueltig oder abgelaufen.");
  const schon = await pool.query<{ tenantId: string }>(
    `SELECT "tenantId" FROM "TenantMember" WHERE "actorId" = $1`,
    [auth.actorId],
  );
  if (schon.rows[0]?.tenantId === ziel.id) throw new TenantError(409, "Du bist bereits Mitglied dieser Organisation.");
  await pool.query(
    `UPDATE "TenantJoinRequest" SET "status" = 'withdrawn', "decidedAt" = CURRENT_TIMESTAMP WHERE "actorId" = $1 AND "status" = 'open'`,
    [auth.actorId],
  );
  const id = `jr_${randomBytes(9).toString("base64url")}`;
  await pool.query(
    `INSERT INTO "TenantJoinRequest" ("id", "tenantId", "actorId", "email", "name") VALUES ($1, $2, $3, $4, $5)`,
    [id, ziel.id, auth.actorId, auth.email ?? null, null],
  );
  return { requestId: id, tenantId: ziel.id, tenantName: ziel.name };
}

export interface OrgState {
  tenantId: string;
  name: string | null;
  kind: "personal" | "organisation";
  myRole: string;
  inviteToken: string | null;
  members: Array<{ actorId: string; role: string; joinedAt: string; email: string | null; name: string | null }>;
  openRequests: Array<{ id: string; actorId: string; email: string | null; name: string | null; requestedAt: string }>;
  policy: TenantPolicyShape;
  /** O4 — hinterlegte Organisationsschluessel (nur Anbieter + Hinweis). */
  providers: Array<{ kind: string; keyHint: string; updatedAt: string }>;
}

export async function getOrgState(pool: pg.Pool, auth: AuthContext): Promise<OrgState> {
  const t = await pool.query<{ id: string; name: string | null; kind: string; inviteToken: string | null }>(
    `SELECT "id", "name", "kind", "inviteToken" FROM "Tenant" WHERE "id" = $1`,
    [auth.tenantId],
  );
  const row = t.rows[0];
  if (!row) throw new TenantError(404, "Tenant nicht gefunden.");
  const admin = await istAdmin(pool, auth.tenantId, auth.actorId);
  const me = await pool.query<{ role: string }>(
    `SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`,
    [auth.tenantId, auth.actorId],
  );
  // E-Mail/Name der Mitglieder kennen wir aus ihren Beitrittsanfragen
  // (oder aus dem Audit); Keycloak fragen wir hier nicht.
  const members = await pool.query<{ actorId: string; role: string; joinedAt: Date; email: string | null; name: string | null }>(
    `SELECT m."actorId", m."role", m."joinedAt",
            (SELECT r."email" FROM "TenantJoinRequest" r WHERE r."actorId" = m."actorId" ORDER BY r."requestedAt" DESC LIMIT 1) AS "email",
            (SELECT r."name" FROM "TenantJoinRequest" r WHERE r."actorId" = m."actorId" ORDER BY r."requestedAt" DESC LIMIT 1) AS "name"
     FROM "TenantMember" m WHERE m."tenantId" = $1 ORDER BY m."joinedAt"`,
    [auth.tenantId],
  );
  const reqs = admin
    ? await pool.query<{ id: string; actorId: string; email: string | null; name: string | null; requestedAt: Date }>(
        `SELECT "id", "actorId", "email", "name", "requestedAt" FROM "TenantJoinRequest" WHERE "tenantId" = $1 AND "status" = 'open' ORDER BY "requestedAt"`,
        [auth.tenantId],
      )
    : { rows: [] as Array<{ id: string; actorId: string; email: string | null; name: string | null; requestedAt: Date }> };
  return {
    tenantId: row.id,
    name: row.name,
    kind: row.kind === "organisation" ? "organisation" : "personal",
    myRole: me.rows[0]?.role ?? "member",
    inviteToken: admin ? row.inviteToken : null,
    members: members.rows.map((m) => ({ ...m, joinedAt: new Date(m.joinedAt).toISOString() })),
    openRequests: reqs.rows.map((r) => ({ ...r, requestedAt: new Date(r.requestedAt).toISOString() })),
    policy: await readPolicy(pool, auth.tenantId),
    providers: (
      await pool.query<{ kind: string; keyHint: string; updatedAt: Date }>(
        `SELECT "kind", "keyHint", "updatedAt" FROM "TenantProvider" WHERE "tenantId" = $1 ORDER BY "kind"`,
        [auth.tenantId],
      )
    ).rows.map((r) => ({ kind: r.kind, keyHint: r.keyHint, updatedAt: new Date(r.updatedAt).toISOString() })),
  };
}

export async function decideJoinRequest(
  pool: pg.Pool,
  auth: AuthContext,
  requestId: string,
  entscheidung: "approve" | "reject",
): Promise<{ actorId: string; tenantId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ tenantId: string; actorId: string; status: string }>(
      `SELECT "tenantId", "actorId", "status" FROM "TenantJoinRequest" WHERE "id" = $1 FOR UPDATE`,
      [requestId],
    );
    const req = r.rows[0];
    if (!req) throw new TenantError(404, "Anfrage nicht gefunden.");
    if (req.tenantId !== auth.tenantId || !(await istAdmin(client, auth.tenantId, auth.actorId))) {
      throw new TenantError(403, "Nur Admins dieser Organisation duerfen entscheiden.");
    }
    if (req.status !== "open") throw new TenantError(409, "Anfrage ist bereits entschieden.");
    await client.query(
      `UPDATE "TenantJoinRequest" SET "status" = $2, "decidedAt" = CURRENT_TIMESTAMP, "decidedBy" = $3 WHERE "id" = $1`,
      [requestId, entscheidung === "approve" ? "approved" : "rejected", auth.actorId],
    );
    let tenantName: string | null = null;
    if (entscheidung === "approve") {
      await client.query(`DELETE FROM "TenantMember" WHERE "actorId" = $1`, [req.actorId]);
      await client.query(
        `INSERT INTO "TenantMember" ("tenantId", "actorId", "role") VALUES ($1, $2, 'member')`,
        [req.tenantId, req.actorId],
      );
      tenantName = (await client.query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [req.tenantId])).rows[0]?.name ?? null;
    }
    await client.query("COMMIT");
    invalidateMembership(req.actorId);
    if (entscheidung === "approve") void syncKeycloak(req.actorId, req.tenantId, tenantName);
    return { actorId: req.actorId, tenantId: req.tenantId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Mitglied entfernen (Admin) oder selbst austreten → zurueck auf den
 *  persoenlichen Tenant, nie auf eine fruehere Organisation. */
export async function removeMember(pool: pg.Pool, auth: AuthContext, actorId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const selbst = actorId === auth.actorId;
    if (!selbst && !(await istAdmin(client, auth.tenantId, auth.actorId))) {
      throw new TenantError(403, "Nur Admins duerfen Mitglieder entfernen.");
    }
    const m = await client.query<{ role: string }>(
      `SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2 FOR UPDATE`,
      [auth.tenantId, actorId],
    );
    if (!m.rows[0]) throw new TenantError(404, "Kein Mitglied dieser Organisation.");
    if (m.rows[0].role === "owner") {
      const owners = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM "TenantMember" WHERE "tenantId" = $1 AND "role" = 'owner'`,
        [auth.tenantId],
      );
      if (Number(owners.rows[0]?.n ?? "0") <= 1) {
        throw new TenantError(409, "Der letzte Owner kann nicht entfernt werden. Erst einen Nachfolger ernennen.");
      }
    }
    const email = (await client.query<{ email: string | null }>(
      `SELECT "email" FROM "TenantJoinRequest" WHERE "actorId" = $1 ORDER BY "requestedAt" DESC LIMIT 1`,
      [actorId],
    )).rows[0]?.email ?? null;
    await setzeAufPersoenlichenTenant(client, actorId, email);
    await client.query("COMMIT");
    invalidateMembership(actorId);
    void syncKeycloak(actorId, actorId, email);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function setMemberRole(pool: pg.Pool, auth: AuthContext, actorId: string, role: "admin" | "member" | "owner"): Promise<void> {
  const me = await pool.query<{ role: string }>(
    `SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`,
    [auth.tenantId, auth.actorId],
  );
  if (me.rows[0]?.role !== "owner") throw new TenantError(403, "Nur der Owner darf Rollen aendern.");
  const r = await pool.query(
    `UPDATE "TenantMember" SET "role" = $3 WHERE "tenantId" = $1 AND "actorId" = $2`,
    [auth.tenantId, actorId, role],
  );
  if (r.rowCount === 0) throw new TenantError(404, "Kein Mitglied dieser Organisation.");
}

export async function setPolicy(pool: pg.Pool, auth: AuthContext, patch: Partial<TenantPolicyShape>): Promise<TenantPolicyShape> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen Vorgaben aendern.");
  const alt = await readPolicy(pool, auth.tenantId);
  const neu: TenantPolicyShape = {
    features: patch.features ? { ...alt.features, ...patch.features } : alt.features,
    providerLock: patch.providerLock ?? alt.providerLock,
    chatModel: patch.chatModel === undefined ? alt.chatModel : patch.chatModel,
    producerModel: patch.producerModel === undefined ? alt.producerModel : patch.producerModel,
    promptAudit: patch.promptAudit ?? alt.promptAudit,
  };
  await pool.query(
    `INSERT INTO "TenantPolicy" ("tenantId", "features", "providerLock", "chatModel", "producerModel", "promptAudit", "updatedAt", "updatedBy")
     VALUES ($1, $2::jsonb, $3, $4, $5, $6, CURRENT_TIMESTAMP, $7)
     ON CONFLICT ("tenantId") DO UPDATE SET "features" = EXCLUDED."features", "providerLock" = EXCLUDED."providerLock",
       "chatModel" = EXCLUDED."chatModel", "producerModel" = EXCLUDED."producerModel", "promptAudit" = EXCLUDED."promptAudit",
       "updatedAt" = CURRENT_TIMESTAMP, "updatedBy" = EXCLUDED."updatedBy"`,
    [auth.tenantId, JSON.stringify(neu.features), neu.providerLock, neu.chatModel, neu.producerModel, neu.promptAudit, auth.actorId],
  );
  invalidateFeatures(auth.tenantId);
  return neu;
}

export async function rotateInvite(pool: pg.Pool, auth: AuthContext): Promise<string> {
  if (!(await istAdmin(pool, auth.tenantId, auth.actorId))) throw new TenantError(403, "Nur Admins duerfen den Einladungslink erneuern.");
  const token = neuerInviteToken();
  const r = await pool.query(`UPDATE "Tenant" SET "inviteToken" = $2 WHERE "id" = $1 AND "kind" = 'organisation'`, [auth.tenantId, token]);
  if (r.rowCount === 0) throw new TenantError(409, "Ein persoenlicher Tenant hat keinen Einladungslink.");
  return token;
}
