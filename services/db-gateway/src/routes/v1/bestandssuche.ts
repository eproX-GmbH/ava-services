// Bestandssuche (docs/PLAN_BESTANDSSUCHE.md, Stufe S1): Volltext (BM25 ueber
// tsvector german) ueber die Belege des eigenen Firmenbestands — Stellen,
// Karriereseite, Fokus-Themen, Referenzen, Firmenprofil, Abschlussbloecke.
//
// Harte Filter zuerst (Bestand des Nutzers ohne ruhende Firmen, Quellen), dann
// Volltext je Quelle; nur Treffer, deren Text die Suchbegriffe enthaelt
// (tsquery-Match, Joyce 2026-11-04: "wenigstens im Ansatz"). Ergebnis je Firma
// mit bis zu drei Belegen (Auszug, Quelle, URL), Standard 5 Firmen, bis 100.
//
// S2 ersetzt die Abfragen je Tabelle durch die zentrale Tabelle SuchBlock mit
// Embeddings (lokal gerechnet) — die Schnittstelle bleibt.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type pg from "pg";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { resolveCompanyNames } from "../../lib/company-names";
import { ruhendeIds } from "../../lib/firmen-zustand";
import { masterData } from "../../lib/register-jobs";
import { requireScope } from "../../middleware/auth";

const ErrorShape = z.object({ error: z.string() });
const errorResponses = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

const QUELLEN = ["stelle", "karriere", "thema", "kunde", "profil", "abschluss"] as const;
type Quelle = (typeof QUELLEN)[number];
const MAX_BESTAND = 5000;
const MAX_JE_QUELLE = 400;
const BELEGE_JE_FIRMA = 3;

export const bestandssucheRouter = new OpenAPIHono();
bestandssucheRouter.use("*", requireScope("company:read"));

const Body = z.object({
  begriffe: z.array(z.string().trim().min(2).max(60)).min(1).max(12),
  quellen: z.array(z.enum(QUELLEN)).max(QUELLEN.length).optional(),
  limit: z.number().int().min(1).max(100).default(5),
  /** Optional: Teilmenge statt des ganzen Bestands (z. B. eine Liste aus dem Chat). */
  companyIds: z.array(z.string().min(1).max(120)).max(MAX_BESTAND).optional(),
});

const Beleg = z.object({
  quelle: z.enum(QUELLEN),
  titel: z.string(),
  auszug: z.string(),
  url: z.string().nullable(),
  datum: z.string().nullable(),
  rang: z.number(),
});

const route = createRoute({
  method: "post",
  path: "/companies/bestand/suche",
  tags: ["companies"],
  summary: "Bestandssuche: Volltext ueber Belege der eigenen Firmen (Stellen, Karriere, Fokus-Themen, Referenzen, Profil, Abschluesse)",
  request: { body: { content: { "application/json": { schema: Body } } } },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            anzahl: z.number(),
            gesamtTreffer: z.number(),
            limit: z.number(),
            bestand: z.number(),
            quellen: z.array(z.enum(QUELLEN)),
            begriffe: z.array(z.string()),
            firmen: z.array(z.object({ companyId: z.string(), name: z.string().nullable(), rang: z.number(), quellen: z.array(z.enum(QUELLEN)), belege: z.array(Beleg) })),
          }),
        },
      },
      description: "Firmen mit Belegen, nach Relevanz",
    },
    ...errorResponses,
  },
});

interface Treffer {
  companyId: string;
  quelle: Quelle;
  titel: string;
  auszug: string;
  url: string | null;
  datum: string | null;
  rang: number;
}

/** tsquery-Ausdruck: jeder Begriff als websearch-Query, alle ODER-verknuepft. */
function tsqueryAusdruck(anzahl: number, offset: number): string {
  return Array.from({ length: anzahl }, (_, i) => `websearch_to_tsquery('german', $${offset + i})`).join(" || ");
}

const HEADLINE = "'MaxWords=45, MinWords=20, MaxFragments=2, FragmentDelimiter=\" … \", StartSel=«, StopSel=»'";

async function quelleAbfragen(pool: pg.Pool, quelle: Quelle, ids: string[], begriffe: string[]): Promise<Treffer[]> {
  const q = tsqueryAusdruck(begriffe.length, 3);
  const params: unknown[] = [ids, MAX_JE_QUELLE, ...begriffe];
  let sql: string;
  switch (quelle) {
    case "stelle":
      sql = `WITH t AS (
          SELECT "companyId", title AS titel, "sourceUrl" AS url, to_char("releaseDate", 'YYYY-MM-DD') AS datum,
                 concat_ws(' ', title, description, array_to_string(requirements, ' '), array_to_string(technologies, ' '), array_to_string(benefits, ' ')) AS text
          FROM "JobPosting" WHERE "companyId" = ANY($1::text[]))
        SELECT "companyId", titel, url, datum, ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
               ts_rank_cd(to_tsvector('german', text), ${q}) AS rang
        FROM t WHERE to_tsvector('german', text) @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
    case "karriere":
      sql = `WITH t AS (
          SELECT "companyId", 'Karriereseite' AS titel, "quelleUrl" AS url, to_char("updatedAt", 'YYYY-MM-DD') AS datum,
                 concat_ws(' • ', array_to_string(benefits, ' • '), auszug) AS text
          FROM "CompanyKarriere" WHERE "companyId" = ANY($1::text[]))
        SELECT "companyId", titel, url, datum, ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
               ts_rank_cd(to_tsvector('german', text), ${q}) AS rang
        FROM t WHERE to_tsvector('german', text) @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
    case "thema":
      sql = `WITH t AS (
          SELECT "companyId", 'Fokus-Thema: ' || name || ' (' || status || ')' AS titel, "quelleUrl" AS url, to_char("updatedAt", 'YYYY-MM-DD') AS datum,
                 concat_ws(' ', name, zitat, ueberschrift, begruendung) AS text
          FROM "CompanyThema" WHERE "companyId" = ANY($1::text[]) AND status IN ('gefunden', 'unklar'))
        SELECT "companyId", titel, url, datum, ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
               ts_rank_cd(to_tsvector('german', text), ${q}) AS rang
        FROM t WHERE to_tsvector('german', text) @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
    case "kunde":
      sql = `WITH t AS (
          SELECT "companyId", 'Referenz/Partner: ' || name AS titel, quelle AS url, to_char("zuletztGesehen", 'YYYY-MM-DD') AS datum,
                 concat_ws(' ', name, art, beleg) AS text
          FROM "CompanyKunde" WHERE "companyId" = ANY($1::text[]))
        SELECT "companyId", titel, url, datum, ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
               ts_rank_cd(to_tsvector('german', text), ${q}) AS rang
        FROM t WHERE to_tsvector('german', text) @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
    case "profil":
      sql = `WITH t AS (
          SELECT id AS "companyId", 'Firmenprofil' AS titel, url, to_char("updatedAt", 'YYYY-MM-DD') AS datum, profile AS text
          FROM "CompanyProfile" WHERE id = ANY($1::text[]))
        SELECT "companyId", titel, url, datum, ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug,
               ts_rank_cd(to_tsvector('german', text), ${q}) AS rang
        FROM t WHERE to_tsvector('german', text) @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
    case "abschluss":
      sql = `SELECT "companyId", coalesce("docName", type) || coalesce(' ' || year::text, '') AS titel, NULL::text AS url, NULL::text AS datum,
                    ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug, ts_rank_cd(tsv, ${q}) AS rang
             FROM "PublicationBlock" WHERE "companyId" = ANY($1::text[]) AND tsv @@ (${q}) ORDER BY rang DESC LIMIT $2`;
      break;
  }
  try {
    const r = await pool.query<Omit<Treffer, "quelle">>(sql, params);
    return r.rows.map((x) => ({ ...x, quelle, rang: Number(x.rang) || 0, auszug: (x.auszug ?? "").replace(/\s+/g, " ").trim().slice(0, 600) }));
  } catch (err) {
    // 42P01 = Tabelle existiert (noch) nicht — Quelle ohne Treffer.
    if ((err as { code?: string }).code === "42P01") return [];
    console.warn(`[bestandssuche] ${quelle}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

function poolFuer(quelle: Quelle): pg.Pool {
  switch (quelle) {
    case "stelle":
    case "karriere":
    case "thema":
      return getProducerPool("website");
    case "kunde":
      return getGatewayPool();
    case "profil":
      return getProducerPool("company-profile");
    case "abschluss":
      return getProducerPool("company-publication");
  }
}

/** Bestand des Nutzers: eigene Firmen aus master-data ohne ruhende (P10). */
export async function bestandIds(actorId: string): Promise<string[]> {
  const alle = await masterData<{ rows: Array<{ companyId: string }> }>("POST", "/internal/transactions/companies-by-users", { userIds: [actorId] }).catch(() => ({ rows: [] as Array<{ companyId: string }> }));
  const ruhend = await ruhendeIds(getGatewayPool(), actorId);
  return [...new Set(alle.rows.map((x) => x.companyId))].filter((id) => id && !ruhend.has(id)).slice(0, MAX_BESTAND);
}

bestandssucheRouter.openapi(route, async (c) => {
  const auth = c.get("auth") as { tenantId?: string | null; actorId?: string | null } | undefined;
  if (!auth?.tenantId || !auth.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  const body = c.req.valid("json");
  const begriffe = [...new Set(body.begriffe.map((b) => b.trim()).filter(Boolean))];
  const quellen: Quelle[] = body.quellen && body.quellen.length > 0 ? [...new Set(body.quellen)] : [...QUELLEN];

  let ids = await bestandIds(auth.actorId);
  if (body.companyIds && body.companyIds.length > 0) {
    const menge = new Set(body.companyIds);
    ids = ids.filter((id) => menge.has(id));
  }
  if (ids.length === 0) return c.json({ anzahl: 0, gesamtTreffer: 0, limit: body.limit, bestand: 0, quellen, begriffe, firmen: [] }, 200);

  const treffer = (await Promise.all(quellen.map((q) => quelleAbfragen(poolFuer(q), q, ids, begriffe)))).flat();

  // Je Firma: bester Rang plus kleiner Bonus je weiterer Quelle; Belege nach Rang.
  const jeFirma = new Map<string, Treffer[]>();
  for (const t of treffer) {
    const l = jeFirma.get(t.companyId) ?? [];
    l.push(t);
    jeFirma.set(t.companyId, l);
  }
  const gereiht = [...jeFirma.entries()]
    .map(([companyId, belege]) => {
      belege.sort((a, b) => b.rang - a.rang);
      const quellenDerFirma = [...new Set(belege.map((b) => b.quelle))];
      const rang = (belege[0]?.rang ?? 0) * (1 + 0.1 * (quellenDerFirma.length - 1));
      return { companyId, rang, quellen: quellenDerFirma, belege: belege.slice(0, BELEGE_JE_FIRMA) };
    })
    .sort((a, b) => b.rang - a.rang);
  const auswahl = gereiht.slice(0, body.limit);
  const names = await resolveCompanyNames(getGatewayPool(), auswahl.map((x) => x.companyId));
  return c.json(
    {
      anzahl: auswahl.length,
      gesamtTreffer: gereiht.length,
      limit: body.limit,
      bestand: ids.length,
      quellen,
      begriffe,
      firmen: auswahl.map((x) => ({
        companyId: x.companyId,
        name: names.get(x.companyId) ?? null,
        rang: Math.round(x.rang * 1000) / 1000,
        quellen: x.quellen,
        belege: x.belege.map((b) => ({ quelle: b.quelle, titel: b.titel, auszug: b.auszug, url: b.url, datum: b.datum, rang: Math.round(b.rang * 1000) / 1000 })),
      })),
    },
    200,
  );
});
