// Bestandssuche (docs/PLAN_BESTANDSSUCHE.md, Stufe S1): Volltext (BM25 ueber
// tsvector german) ueber die Belege des eigenen Firmenbestands — Stellen,
// Karriereseite, Fokus-Themen, Referenzen, Firmenprofil, Abschlussbloecke.
//
// Harte Filter zuerst (Bestand des Nutzers ohne ruhende Firmen, Quellen), dann
// Volltext je Quelle; nur Treffer, deren Text die Suchbegriffe enthaelt
// (tsquery-Match, Joyce 2026-11-04: "wenigstens im Ansatz"). Ergebnis je Firma
// mit bis zu drei Belegen (Auszug, Quelle, URL), Standard 5 Firmen, bis 100.
//
// S2: Stellen, Karriere, Themen, Referenzen, Profil kommen aus der zentralen
// Tabelle SuchBlock (lib/suchblock.ts, GIN auf tsv); Abschlussbloecke weiter
// aus PublicationBlock. S3 ergaenzt Embeddings (lokal gerechnet).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { resolveCompanyNames } from "../../lib/company-names";
import { ruhendeIds } from "../../lib/firmen-zustand";
import { masterData } from "../../lib/register-jobs";
import { istBetreiber, requireScope } from "../../middleware/auth";
import { SUCH_QUELLEN, backfillStand, embeddingsSetzen, fusioniere, offeneEmbeddings, suchblockBackfill, suchbloeckeSuchen, tsqueryAusdruck, type SuchQuelle } from "../../lib/suchblock";

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
  /** S3: lokal gerechneter Vektor der Frage (embeddinggemma); verschmilzt per RRF mit BM25. */
  frageEmbedding: z.array(z.number()).min(64).max(4096).optional(),
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
            semantik: z.object({ aktiv: z.boolean(), kandidaten: z.number(), mitVektor: z.number() }),
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
  embedding?: number[] | null;
}

const HEADLINE = "'MaxWords=45, MinWords=20, MaxFragments=2, FragmentDelimiter=\" … \", StartSel=«, StopSel=»'";

async function abschlussAbfragen(ids: string[], begriffe: string[]): Promise<Treffer[]> {
  const q = tsqueryAusdruck(begriffe.length, 3);
  const sql = `SELECT "companyId", coalesce("docName", type) || coalesce(' ' || year::text, '') AS titel, NULL::text AS url, NULL::text AS datum, embedding,
                      ts_headline('german', text, ${q}, ${HEADLINE}) AS auszug, ts_rank_cd(tsv, ${q}) AS rang
               FROM "PublicationBlock" WHERE "companyId" = ANY($1::text[]) AND tsv @@ (${q}) ORDER BY rang DESC LIMIT $2`;
  try {
    const r = await getProducerPool("company-publication").query<Omit<Treffer, "quelle">>(sql, [ids, MAX_JE_QUELLE, ...begriffe]);
    return r.rows.map((x) => ({ ...x, quelle: "abschluss" as const, rang: Number(x.rang) || 0, auszug: (x.auszug ?? "").replace(/\s+/g, " ").trim().slice(0, 600) }));
  } catch (err) {
    if ((err as { code?: string }).code === "42P01") return [];
    console.warn("[bestandssuche] abschluss:", err instanceof Error ? err.message : err);
    return [];
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
  const semantikLeer = { aktiv: Boolean(body.frageEmbedding), kandidaten: 0, mitVektor: 0 };
  if (ids.length === 0) return c.json({ anzahl: 0, gesamtTreffer: 0, limit: body.limit, bestand: 0, quellen, begriffe, firmen: [], semantik: semantikLeer }, 200);

  const suchQuellen = quellen.filter((q): q is SuchQuelle => (SUCH_QUELLEN as readonly string[]).includes(q));
  const [ausBloecken, ausAbschluessen] = await Promise.all([
    suchQuellen.length ? suchbloeckeSuchen(ids, suchQuellen, begriffe, MAX_JE_QUELLE * suchQuellen.length).catch((err) => { console.warn("[bestandssuche] suchblock:", err instanceof Error ? err.message : err); return []; }) : Promise.resolve([]),
    quellen.includes("abschluss") ? abschlussAbfragen(ids, begriffe) : Promise.resolve([] as Treffer[]),
  ]);
  const roh: Treffer[] = [...ausBloecken, ...ausAbschluessen];
  // S3: BM25 bleibt die Pflicht (nur Volltext-Treffer sind Kandidaten); der
  // Frage-Vektor sortiert die Kandidaten per RRF nach.
  const fusion = fusioniere(roh, body.frageEmbedding ?? null);
  const treffer = fusion.treffer;
  const semantik = { aktiv: Boolean(body.frageEmbedding), kandidaten: roh.length, mitVektor: fusion.mitEmbedding };

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
        belege: x.belege.map((b) => ({ quelle: b.quelle, titel: b.titel, auszug: b.auszug, url: b.url, datum: b.datum, rang: Math.round(b.rang * 10000) / 10000 })),
      })),
      semantik,
    },
    200,
  );
});

// ---- S3: Vektoren kommen vom Desktop (lokal gerechnet) ----

const offenRoute = createRoute({
  method: "get", path: "/suchblock/offen", tags: ["companies"], summary: "Bloecke der eigenen Firmen ohne Vektor (fuer den lokalen Einbetter)",
  request: { query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(40) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ bloecke: z.array(z.object({ id: z.string(), titel: z.string(), text: z.string() })) }) } }, description: "Bloecke" }, ...errorResponses },
});
bestandssucheRouter.openapi(offenRoute, async (c) => {
  const auth = c.get("auth") as { actorId?: string | null } | undefined;
  if (!auth?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  const ids = await bestandIds(auth.actorId);
  return c.json({ bloecke: await offeneEmbeddings(ids, c.req.valid("query").limit) }, 200);
});

const embeddingsRoute = createRoute({
  method: "put", path: "/suchblock/embeddings", tags: ["companies"], summary: "Lokal gerechnete Vektoren fuer Bloecke der eigenen Firmen eintragen",
  request: { body: { content: { "application/json": { schema: z.object({ modell: z.string().min(1).max(80), eintraege: z.array(z.object({ id: z.string().min(1).max(64), embedding: z.array(z.number()).min(64).max(4096) })).min(1).max(200) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ geschrieben: z.number() }) } }, description: "Anzahl" }, ...errorResponses },
});
bestandssucheRouter.openapi(embeddingsRoute, async (c) => {
  const auth = c.get("auth") as { actorId?: string | null } | undefined;
  if (!auth?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  const body = c.req.valid("json");
  const ids = await bestandIds(auth.actorId);
  return c.json({ geschrieben: await embeddingsSetzen(ids, body.modell, body.eintraege) }, 200);
});

// ---- Betreiber: Altbestand nach SuchBlock uebernehmen (einmalig) ----

const standRoute = createRoute({
  method: "get", path: "/betreiber/suchblock/stand", tags: ["companies"], summary: "Betreiber: Stand der SuchBlock-Tabelle und des Backfills",
  responses: { 200: { content: { "application/json": { schema: z.object({ zeilen: z.record(z.string(), z.number()), backfill: z.record(z.string(), z.unknown()) }) } }, description: "Stand" }, ...errorResponses },
});
bestandssucheRouter.openapi(standRoute, async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const r = await getGatewayPool().query<{ quelle: string; n: string }>(`SELECT quelle, count(*)::text AS n FROM "SuchBlock" GROUP BY quelle`).catch(() => ({ rows: [] as Array<{ quelle: string; n: string }> }));
  const zeilen: Record<string, number> = {};
  for (const x of r.rows) zeilen[x.quelle] = Number(x.n);
  return c.json({ zeilen, backfill: backfillStand() as unknown as Record<string, unknown> }, 200);
});

const backfillRoute = createRoute({
  method: "post", path: "/betreiber/suchblock/backfill", tags: ["companies"], summary: "Betreiber: alle vorhandenen Belege einmal nach SuchBlock uebernehmen (laeuft im Hintergrund)",
  responses: { 200: { content: { "application/json": { schema: z.object({ gestartet: z.boolean(), backfill: z.record(z.string(), z.unknown()) }) } }, description: "gestartet" }, ...errorResponses },
});
bestandssucheRouter.openapi(backfillRoute, async (c) => {
  if (!istBetreiber(c.get("auth"))) throw new HTTPException(404, { message: "not_found" });
  const vorher = backfillStand();
  if (!vorher.laeuft) void suchblockBackfill((m) => console.info(m));
  return c.json({ gestartet: !vorher.laeuft, backfill: backfillStand() as unknown as Record<string, unknown> }, 200);
});
