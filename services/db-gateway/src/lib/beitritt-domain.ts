// Onboarding O11 (docs/PLAN_ONBOARDING.md, Joyce 2026-11-08): Wer sich mit einer
// Adresse der eigenen Firma registriert (jrafflenbeul@eprox-gmbh.de), wird der
// Organisation dieser Firma sofort als OFFENE Beitrittsanfrage zugeordnet. Ein Admin
// muss freigeben. "Organisation wechseln" zieht die Anfrage zurueck.
//
// Eine Organisation "besitzt" eine Domain, wenn mind. ein Owner/Admin eine Adresse
// dieser Domain hat. Freemail/Baukasten zaehlen nie. Je Organisation abschaltbar
// (Tenant.domainBeitritt). Mehrere passende Organisationen → keine automatische
// Anfrage, die App zeigt die Auswahl.

import { randomBytes } from "node:crypto";
import type pg from "pg";
import { loadEnv } from "./env";
import { logger } from "./logger";
import { domainAusEmail, istFreemail } from "./start-analyse/freemail";
import { mailKonto, mailSenden, versandBereit } from "./mail/versand";
import { beitrittsanfrageMail } from "./mail/vorlagen";

export interface OrgVorschlag { tenantId: string; name: string | null }

export async function passendeOrganisationen(pool: pg.Pool, email: string | null | undefined): Promise<OrgVorschlag[]> {
  const domain = email ? domainAusEmail(email) : null;
  if (!domain || istFreemail(domain)) return [];
  const r = await pool.query<OrgVorschlag>(
    `SELECT DISTINCT t."id" AS "tenantId", t."name"
       FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId"
      WHERE t."kind" = 'organisation' AND t."deletedAt" IS NULL AND t."domainBeitritt" = TRUE
        AND m."role" IN ('owner', 'admin') AND lower(split_part(m."email", '@', 2)) = $1
      ORDER BY t."name" LIMIT 5`,
    [domain],
  );
  return r.rows;
}

async function istInOrganisation(pool: pg.Pool, actorId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId" WHERE m."actorId" = $1 AND t."kind" = 'organisation' LIMIT 1`, [actorId]);
  return r.rows.length > 0;
}

async function offeneAnfrage(pool: pg.Pool, actorId: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM "TenantJoinRequest" WHERE "actorId" = $1 AND "status" = 'open' LIMIT 1`, [actorId]);
  return r.rows.length > 0;
}

async function anfrageAnlegen(pool: pg.Pool, e: { tenantId: string; actorId: string; email: string | null; name: string | null; quelle: "link" | "domain" }): Promise<string> {
  await pool.query(`UPDATE "TenantJoinRequest" SET "status" = 'withdrawn', "decidedAt" = CURRENT_TIMESTAMP WHERE "actorId" = $1 AND "status" = 'open'`, [e.actorId]);
  const id = `jr_${randomBytes(9).toString("base64url")}`;
  await pool.query(
    `INSERT INTO "TenantJoinRequest" ("id", "tenantId", "actorId", "email", "name", "quelle") VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, e.tenantId, e.actorId, e.email, e.name, e.quelle],
  );
  return id;
}

/** Automatisch beim Registrieren/ersten Anmelden: genau eine passende Organisation → offene Anfrage. */
export async function domainZuordnen(pool: pg.Pool, e: { actorId: string; email: string | null | undefined; name?: string | null }): Promise<OrgVorschlag | null> {
  if (!e.email) return null;
  if (await istInOrganisation(pool, e.actorId)) return null;
  if (await offeneAnfrage(pool, e.actorId)) return null;
  const orgs = await passendeOrganisationen(pool, e.email);
  if (orgs.length !== 1) return null;
  const org = orgs[0]!;
  await anfrageAnlegen(pool, { tenantId: org.tenantId, actorId: e.actorId, email: e.email.trim().toLowerCase(), name: e.name ?? null, quelle: "domain" });
  logger.info({ actorId: e.actorId, tenantId: org.tenantId }, "[beitritt-domain] automatisch zugeordnet (offene Anfrage)");
  void adminsBenachrichtigen(pool, org.tenantId, { wer: e.name ?? e.email, email: e.email, quelle: "domain" }).catch(() => undefined);
  return org;
}

/** Aus der Auswahl (mehrere passende Organisationen) eine anfragen; nur mit passender Domain. */
export async function anfrageNachDomain(pool: pg.Pool, e: { actorId: string; email: string | null | undefined; name?: string | null; tenantId: string }): Promise<OrgVorschlag> {
  const orgs = await passendeOrganisationen(pool, e.email);
  const org = orgs.find((o) => o.tenantId === e.tenantId);
  if (!org) throw Object.assign(new Error("Diese Organisation passt nicht zu deiner E-Mail-Adresse."), { status: 404 });
  await anfrageAnlegen(pool, { tenantId: org.tenantId, actorId: e.actorId, email: e.email?.trim().toLowerCase() ?? null, name: e.name ?? null, quelle: "domain" });
  void adminsBenachrichtigen(pool, org.tenantId, { wer: e.name ?? e.email ?? "Jemand", email: e.email ?? null, quelle: "domain" }).catch(() => undefined);
  return org;
}

/** "Organisation wechseln": offene Anfrage zurueckziehen. */
export async function anfrageZurueckziehen(pool: pg.Pool, actorId: string): Promise<boolean> {
  const r = await pool.query(`UPDATE "TenantJoinRequest" SET "status" = 'withdrawn', "decidedAt" = CURRENT_TIMESTAMP WHERE "actorId" = $1 AND "status" = 'open'`, [actorId]);
  return (r.rowCount ?? 0) > 0;
}

/** Mail an Owner/Admins einer Organisation ueber eine neue Beitrittsanfrage (Link oder Domain). */
export async function adminsBenachrichtigen(pool: pg.Pool, tenantId: string, e: { wer: string; email: string | null; quelle: "link" | "domain" }): Promise<number> {
  if (!versandBereit()) return 0;
  const org = (await pool.query<{ name: string | null }>(`SELECT "name" FROM "Tenant" WHERE "id" = $1`, [tenantId])).rows[0];
  const admins = await pool.query<{ actorId: string; email: string | null; name: string | null }>(
    `SELECT "actorId", "email", "name" FROM "TenantMember" WHERE "tenantId" = $1 AND "role" IN ('owner', 'admin') AND "email" IS NOT NULL`,
    [tenantId],
  );
  const konsole = `${loadEnv().AVA_KONSOLE_URL.replace(/\/+$/, "")}/mitglieder`;
  let n = 0;
  for (const a of admins.rows) {
    const konto = await mailKonto(pool, { actorId: a.actorId, email: a.email!, vorname: a.name?.split(/\s+/)[0] ?? null });
    const r = await mailSenden(pool, konto, "beitritt", beitrittsanfrageMail({ vorname: konto.vorname, organisation: org?.name ?? "eure Organisation", wer: e.wer, email: e.email, quelle: e.quelle, konsoleUrl: konsole }));
    if (r.ok) n++;
  }
  return n;
}

/** Admin-Schalter je Organisation. */
export async function domainBeitrittSetzen(pool: pg.Pool, tenantId: string, an: boolean): Promise<void> {
  await pool.query(`UPDATE "Tenant" SET "domainBeitritt" = $2, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "kind" = 'organisation'`, [tenantId, an]);
}
