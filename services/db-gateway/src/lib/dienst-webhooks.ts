// Rueckkanal fremder Dienste (docs/PLAN_CLOSE_MCP.md, C4): je Nutzer und Dienst
// eine Empfangsadresse mit geheimem Token; eingehende Ereignisse landen roh in
// DienstEreignis und werden von der AVA des Nutzers gelesen (Werkzeug,
// Benachrichtigung, spaeter Workflow-Ausloeser).

import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { getProducerPool } from "./producer-pools";

export interface Empfaenger {
  id: string;
  token: string;
  tenantId: string;
  actorId: string;
  dienst: string;
  createdAt: Date;
  zuletztAt: Date | null;
  anzahl: number;
}

export interface Ereignis {
  id: string;
  dienst: string;
  typ: string | null;
  nutzlast: unknown;
  personId: string | null;
  companyId: string | null;
  empfangenAt: Date;
  gelesenAt: Date | null;
}

/** LinkedIn-Kurzname aus einer Profiladresse ("https://www.linkedin.com/in/max-muster/" → "max-muster"). */
export function linkedinSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!).toLowerCase().replace(/\/+$/, "") || null;
  } catch {
    return m[1]!.toLowerCase();
  }
}

/** LinkedIn-Adresse aus einer beliebigen Nutzlast (CompLeadly: leadData.linkedinUrl). */
export function linkedinAusNutzlast(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  const lead = (o.leadData && typeof o.leadData === "object" ? o.leadData : o.lead && typeof o.lead === "object" ? o.lead : {}) as Record<string, unknown>;
  for (const quelle of [lead, o]) {
    for (const k of ["linkedinUrl", "linkedin_url", "linkedInUrl", "profileUrl", "profile_url", "linkedin"]) {
      const v = quelle[k];
      if (typeof v === "string" && /linkedin\.com\/in\//i.test(v)) return v;
    }
  }
  return null;
}

/**
 * Person und Firma zu einem LinkedIn-Kurznamen, nur innerhalb der Firmen des
 * Bestands (keine Zuordnung zu fremden Firmen). Best-effort, null ohne Treffer.
 */
export async function personZuSlug(slug: string, bestand: string[]): Promise<{ personId: string; companyId: string } | null> {
  if (!slug || bestand.length === 0) return null;
  try {
    const r = await getProducerPool("company-contact").query<{ personId: string; companyId: string }>(
      `SELECT e."personId", e."companyId"
         FROM "Employment" e
         JOIN "Fact" f ON f."entityType" = 'PERSON' AND f."entityId" = e."personId" AND f.field = 'linkedinUrl' AND f.status = 'ACTIVE'
        WHERE e."companyId" = ANY($1::text[])
          AND lower(regexp_replace(f.value, '^.*linkedin\\.com/in/([^/?#]+).*$', '\\1')) = $2
        ORDER BY e."isCurrent" DESC, e."lastSeen" DESC
        LIMIT 1`,
      [bestand, slug],
    );
    return r.rows[0] ?? null;
  } catch {
    return null;
  }
}

const MAX_JE_NUTZER = 5000;

export function empfangsUrl(basis: string, token: string): string {
  return `${basis.replace(/\/$/, "")}/v1/webhooks/ereignis/${token}`;
}

export async function empfaengerListe(pool: Pool, actorId: string): Promise<Empfaenger[]> {
  const r = await pool.query<Empfaenger>(`SELECT id, token, "tenantId", "actorId", dienst, "createdAt", "zuletztAt", anzahl FROM "WebhookEmpfaenger" WHERE "actorId" = $1 ORDER BY "createdAt"`, [actorId]);
  return r.rows;
}

/** Anlegen oder vorhandenen zurueckgeben (ein Empfaenger je Nutzer und Dienst). */
export async function empfaengerAnlegen(pool: Pool, args: { tenantId: string; actorId: string; dienst: string }): Promise<Empfaenger> {
  const dienst = args.dienst.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "dienst";
  const vorhanden = await pool.query<Empfaenger>(`SELECT id, token, "tenantId", "actorId", dienst, "createdAt", "zuletztAt", anzahl FROM "WebhookEmpfaenger" WHERE "actorId" = $1 AND dienst = $2`, [args.actorId, dienst]);
  if (vorhanden.rows[0]) return vorhanden.rows[0];
  const id = "we_" + randomBytes(8).toString("hex");
  const token = randomBytes(24).toString("base64url");
  const r = await pool.query<Empfaenger>(
    `INSERT INTO "WebhookEmpfaenger" (id, token, "tenantId", "actorId", dienst) VALUES ($1, $2, $3, $4, $5)
     RETURNING id, token, "tenantId", "actorId", dienst, "createdAt", "zuletztAt", anzahl`,
    [id, token, args.tenantId, args.actorId, dienst],
  );
  return r.rows[0]!;
}

export async function empfaengerLoeschen(pool: Pool, actorId: string, id: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM "WebhookEmpfaenger" WHERE id = $1 AND "actorId" = $2`, [id, actorId]);
  return (r.rowCount ?? 0) > 0;
}

/** Eingehendes Ereignis ablegen; liefert null, wenn das Token unbekannt ist. */
export async function ereignisAblegen(
  pool: Pool,
  token: string,
  nutzlast: unknown,
  bestandVon?: (actorId: string) => Promise<string[]>,
): Promise<{ empfaenger: Empfaenger; id: string } | null> {
  const e = await pool.query<Empfaenger>(`SELECT id, token, "tenantId", "actorId", dienst, "createdAt", "zuletztAt", anzahl FROM "WebhookEmpfaenger" WHERE token = $1`, [token]);
  const emp = e.rows[0];
  if (!emp) return null;
  const typ = typOf(nutzlast);
  const id = "de_" + randomBytes(8).toString("hex");
  const slug = linkedinSlug(linkedinAusNutzlast(nutzlast));
  const treffer = slug && bestandVon ? await personZuSlug(slug, await bestandVon(emp.actorId).catch(() => [])) : null;
  await pool.query(
    `INSERT INTO "DienstEreignis" (id, "empfaengerId", "tenantId", "actorId", dienst, typ, nutzlast, "personId", "companyId", "linkedinSlug")
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
    [id, emp.id, emp.tenantId, emp.actorId, emp.dienst, typ, JSON.stringify(nutzlast ?? null), treffer?.personId ?? null, treffer?.companyId ?? null, slug],
  );
  await pool.query(`UPDATE "WebhookEmpfaenger" SET "zuletztAt" = NOW(), anzahl = anzahl + 1 WHERE id = $1`, [emp.id]);
  // Deckel je Nutzer: aelteste Ereignisse fallen weg.
  await pool.query(
    `DELETE FROM "DienstEreignis" WHERE "actorId" = $1 AND id IN (
       SELECT id FROM "DienstEreignis" WHERE "actorId" = $1 ORDER BY "empfangenAt" DESC OFFSET $2)`,
    [emp.actorId, MAX_JE_NUTZER],
  ).catch(() => undefined);
  return { empfaenger: emp, id };
}

function typOf(n: unknown): string | null {
  if (!n || typeof n !== "object") return null;
  const o = n as Record<string, unknown>;
  for (const k of ["eventType", "event_type", "event", "type", "typ", "kind"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 80);
  }
  return null;
}

export async function ereignisseLesen(pool: Pool, args: { actorId: string; dienst?: string; seit?: Date; nurUngelesen?: boolean; limit: number }): Promise<Ereignis[]> {
  const bed: string[] = [`"actorId" = $1`];
  const werte: unknown[] = [args.actorId];
  if (args.dienst) {
    werte.push(args.dienst);
    bed.push(`dienst = $${werte.length}`);
  }
  if (args.seit) {
    werte.push(args.seit);
    bed.push(`"empfangenAt" > $${werte.length}`);
  }
  if (args.nurUngelesen) bed.push(`"gelesenAt" IS NULL`);
  werte.push(args.limit);
  const r = await pool.query<Ereignis>(
    `SELECT id, dienst, typ, nutzlast, "personId", "companyId", "empfangenAt", "gelesenAt" FROM "DienstEreignis" WHERE ${bed.join(" AND ")} ORDER BY "empfangenAt" DESC LIMIT $${werte.length}`,
    werte,
  );
  return r.rows;
}

export async function ereignisseGelesen(pool: Pool, actorId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const r = await pool.query(`UPDATE "DienstEreignis" SET "gelesenAt" = NOW() WHERE "actorId" = $1 AND id = ANY($2::text[]) AND "gelesenAt" IS NULL`, [actorId, ids]);
  return r.rowCount ?? 0;
}
