// v0.1.63 — F3 producer pre-check endpoint.
//
// Returns per-stage ContentFreshness for one company. Producers call
// this at the top of compute(), pass the response into the same
// `tierShouldWrite()` rule the gateway uses post-write, and skip
// their Selenium / LLM work entirely when the canonical data is
// already fresh + same-or-better-tier.
//
// This is purely an optimization over the F2 gateway-side gate. Even
// without F3, F2 already prevents bad writes from landing — F3 just
// saves the user's machine the cycles of doing the work that would
// have been thrown away anyway.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";
import { CompanyIdParam } from "./schemas";

export const companyStateRouter = new OpenAPIHono();

const StageStateShape = z
  .object({
    /** ISO-8601. null = no row yet (treat as Infinity age). */
    updatedAt: z.string().nullable(),
    /** 1..4 (C..S) — see /MODEL_TIERS.md. null for non-LLM stages
     *  OR untiered legacy writes. */
    llmTier: z.number().int().min(1).max(4).nullable(),
    /** v0.1.65 — exact model id (e.g. "gpt-4o", "qwen2.5:7b").
     *  null for non-LLM stages OR rows written before the column
     *  landed. Surfaced on CompanyDetail tooltips + agent context. */
    llmModel: z.string().nullable(),
    /** Register-Delta S7 — Registerblatt hat sich nach dem letzten Lauf
     *  geaendert; updatedAt wird dann als null gemeldet, damit der
     *  Producer neu laeuft. */
    veraltetSeit: z.string().nullable().optional(),
    veraltetGrund: z.string().nullable().optional(),
  })
  .openapi("StageState");

const CompanyStateResponseShape = z
  .object({
    companyId: z.string(),
    /** Map of producer name → freshness. Includes ALL producers,
     *  not just ones with rows; missing rows are returned as
     *  {updatedAt: null, llmTier: null}. */
    stages: z.record(z.string(), StageStateShape),
  })
  .openapi("CompanyStateResponse");

const stateRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/state",
  tags: ["companies"],
  summary:
    "Per-stage freshness snapshot for one company. Used by producer pre-check to skip already-fresh work.",
  request: { params: CompanyIdParam },
  responses: {
    200: {
      content: { "application/json": { schema: CompanyStateResponseShape } },
      description: "per-stage updatedAt + llmTier",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

const KNOWN_STAGES = [
  "structured-content",
  "company-publication",
  "website",
  "company-profile",
  "company-contact",
  "company-email",
] as const;

companyStateRouter.openapi(stateRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { companyId } = c.req.valid("param");

  const res = await getGatewayPool().query<{
    stage: string;
    llmTier: number | null;
    llmModel: string | null;
    updatedAt: Date;
  }>(
    `SELECT stage, "llmTier", "llmModel", "updatedAt"
       FROM "ContentFreshness"
      WHERE "companyId" = $1`,
    [companyId],
  );

  // Build a complete map keyed by every known stage so callers can
  // index without optional-chaining. Missing rows surface as nulls.
  const stages: Record<
    string,
    { updatedAt: string | null; llmTier: number | null; llmModel: string | null; veraltetSeit?: string | null; veraltetGrund?: string | null }
  > = {};
  for (const stage of KNOWN_STAGES) {
    stages[stage] = { updatedAt: null, llmTier: null, llmModel: null };
  }
  for (const row of res.rows) {
    stages[row.stage] = {
      updatedAt: row.updatedAt.toISOString(),
      llmTier: row.llmTier,
      llmModel: row.llmModel,
    };
  }

  // Register-Delta S7 — Veraltet-Markierung: ist das Registerblatt nach dem
  // letzten structured-content-Lauf geaendert worden, gilt die Stufe als
  // nicht frisch (updatedAt null), der Producer laeuft beim naechsten
  // Zugriff erneut. Die Markierung faellt mit dem naechsten Schreiben weg.
  const stale = await getGatewayPool().query<{ seit: Date; grund: string }>(
    `SELECT "seit", "grund" FROM "StructuredContentStale" WHERE "companyId" = $1`,
    [companyId],
  );
  const st = stale.rows[0];
  if (st) {
    const cell = stages["structured-content"];
    const alt = cell.updatedAt ? Date.parse(cell.updatedAt) : 0;
    if (st.seit.getTime() > alt) {
      stages["structured-content"] = { ...cell, updatedAt: null, veraltetSeit: st.seit.toISOString(), veraltetGrund: st.grund };
    }
  }

  return c.json({ companyId, stages }, 200);
});

// ---------------------------------------------------------------------------
// 2026-11-02 — Apify-Stand je Firma fuer den Kontakt-Producer (Vorgabe Joyce:
// beim Auffrischen nicht alles neu abrufen, sondern nur, was neu ist). Liefert,
// wie viele Personen schon ueber Apify bekannt sind, wann der letzte Apify-Lauf
// war und welche Mitarbeiterzahl das LinkedIn-Firmenprofil damals hatte. Der
// Producer ruft zuerst nur den guenstigen Details-Actor und ueberspringt den
// Mitarbeiter-Abruf, wenn sich die Zahl nicht geaendert hat.
// ---------------------------------------------------------------------------
const ApifyStandShape = z
  .object({
    companyId: z.string(),
    /** Personen mit mindestens einer Apify-Beobachtung an dieser Firma. */
    apifyPersonen: z.number().int(),
    /** ISO-Zeit der juengsten Apify-Beobachtung, null = nie. */
    letzterLauf: z.string().nullable(),
    /** Mitarbeiterzahl laut LinkedIn beim letzten Lauf (Fakt linkedin:employeeCount), null = unbekannt. */
    employeeCount: z.number().int().nullable(),
    employeeCountAm: z.string().nullable(),
  })
  .openapi("ApifyStand");

const apifyStandRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/contacts/apify-stand",
  tags: ["companies"],
  summary: "Stand des LinkedIn-Mitarbeiter-Abrufs (Apify) je Firma; der Kontakt-Producer entscheidet damit, ob ein neuer Abruf noetig ist.",
  request: { params: CompanyIdParam },
  responses: {
    200: { content: { "application/json": { schema: ApifyStandShape } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});

companyStateRouter.openapi(apifyStandRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-contact");
  const r = await pool.query<{ personen: string; letzter: Date | null; count: string | null; countAm: Date | null }>(
    `SELECT
       (SELECT count(DISTINCT o."personId") FROM "Observation" o WHERE o."companyId" = $1 AND o."personId" IS NOT NULL AND o.source LIKE 'apify%')::text AS personen,
       (SELECT max(o."observedAt") FROM "Observation" o WHERE o."companyId" = $1 AND o.source LIKE 'apify%') AS letzter,
       (SELECT o.value FROM "Observation" o WHERE o."companyId" = $1 AND o.field = 'linkedin:employeeCount' ORDER BY o."observedAt" DESC LIMIT 1) AS count,
       (SELECT o."observedAt" FROM "Observation" o WHERE o."companyId" = $1 AND o.field = 'linkedin:employeeCount' ORDER BY o."observedAt" DESC LIMIT 1) AS "countAm"`,
    [companyId],
  );
  const row = r.rows[0];
  const count = row?.count != null && Number.isFinite(Number(row.count)) ? Math.round(Number(row.count)) : null;
  return c.json(
    {
      companyId,
      apifyPersonen: Number(row?.personen ?? 0),
      letzterLauf: row?.letzter ? row.letzter.toISOString() : null,
      employeeCount: count,
      employeeCountAm: row?.countAm ? row.countAm.toISOString() : null,
    },
    200,
  );
});

// ---- Lokale Profil-Pruefung (lib/contact-extraction/profil-pruefung.ts) -------
// Der Kontakt-Producer holt sich hier die bekannten LinkedIn-Profile der aktuellen
// Ansprechpartner samt letzter Pruefung und liest sie im Hintergrund-Chrome des
// Nutzers (JSON-LD, ohne Anmeldung). Danach meldet er je Person das Ergebnis
// ueber den Persist-Pfad (result.profilPruefungen).

const LinkedinProfilShape = z
  .object({
    companyId: z.string(),
    companyName: z.string().nullable(),
    personen: z.array(
      z.object({
        personId: z.string(),
        fullName: z.string(),
        title: z.string().nullable(),
        linkedinUrl: z.string(),
        /** Letzte Pruefung (jedes Ergebnis), null = nie. */
        zuletztGeprueft: z.string().nullable(),
        letztesErgebnis: z.string().nullable(),
      }),
    ),
  })
  .openapi("LinkedinProfilListe");

const linkedinProfilRoute = createRoute({
  method: "get",
  path: "/companies/{companyId}/contacts/linkedin-profile",
  tags: ["companies"],
  summary: "Bekannte LinkedIn-Profile der aktuellen Ansprechpartner einer Firma mit Stand der letzten lokalen Profil-Pruefung.",
  request: { params: CompanyIdParam },
  responses: {
    200: { content: { "application/json": { schema: LinkedinProfilShape } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});

companyStateRouter.openapi(linkedinProfilRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const { companyId } = c.req.valid("param");
  const pool = getProducerPool("company-contact");
  const name = await pool.query<{ name: string | null }>(`SELECT name FROM "Company" WHERE id = $1`, [companyId]);
  const r = await pool.query<{ personId: string; fullName: string; title: string | null; linkedinUrl: string; zuletzt: Date | null; ergebnis: string | null }>(
    `SELECT e."personId", p."fullName", e.title, f.value AS "linkedinUrl",
            pr."observedAt" AS zuletzt, pr.value AS ergebnis
       FROM "Employment" e
       JOIN "Person" p ON p.id = e."personId"
       JOIN LATERAL (
         SELECT f.value FROM "Fact" f
          WHERE f."entityType" = 'PERSON' AND f."entityId" = e."personId" AND f.field = 'linkedinUrl' AND f.status = 'ACTIVE'
          ORDER BY f."lastSeen" DESC LIMIT 1
       ) f ON TRUE
       LEFT JOIN LATERAL (
         SELECT o."observedAt", o.value FROM "Observation" o
          WHERE o."personId" = e."personId" AND o.field = 'linkedin:pruefung'
          ORDER BY o."observedAt" DESC LIMIT 1
       ) pr ON TRUE
      WHERE e."companyId" = $1 AND e."isCurrent"
        AND f.value ~* '^https?://([a-z]{2,3}\\.)?linkedin\\.com/in/'
      ORDER BY pr."observedAt" ASC NULLS FIRST, e."lastSeen" DESC
      LIMIT 200`,
    [companyId],
  );
  return c.json(
    {
      companyId,
      companyName: name.rows[0]?.name ?? null,
      personen: r.rows.map((x) => ({
        personId: x.personId,
        fullName: x.fullName,
        title: x.title ?? null,
        linkedinUrl: x.linkedinUrl,
        zuletztGeprueft: x.zuletzt ? x.zuletzt.toISOString() : null,
        letztesErgebnis: x.ergebnis ? x.ergebnis.split(" ")[0] ?? null : null,
      })),
    },
    200,
  );
});

const ProfilStatistikShape = z
  .object({
    tage: z.number().int(),
    bestaetigt: z.number().int(),
    gewechselt: z.number().int(),
    gesperrt: z.number().int(),
    nichtGefunden: z.number().int(),
    ueberApify: z.number().int(),
  })
  .openapi("ProfilPruefungStatistik");

const profilStatistikRoute = createRoute({
  method: "get",
  path: "/contacts/linkedin-profile/statistik",
  tags: ["companies"],
  summary: "Statistik der lokalen Profil-Pruefung des aufrufenden Nutzers (letzte 30 Tage).",
  responses: {
    200: { content: { "application/json": { schema: ProfilStatistikShape } }, description: "ok" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  },
});

companyStateRouter.openapi(profilStatistikRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  const pool = getProducerPool("company-contact");
  const tage = 30;
  const r = await pool.query<{ ergebnis: string; quelle: string; n: string }>(
    `SELECT split_part(o.value, ' ', 1) AS ergebnis, o.source AS quelle, count(*)::text AS n
       FROM "Observation" o
      WHERE o.field = 'linkedin:pruefung' AND o."observedAt" > now() - ($2 || ' days')::interval
        AND ($1::text IS NULL OR o."actorId" = $1 OR o."actorId" IS NULL)
      GROUP BY 1, 2`,
    [auth.actorId ?? null, String(tage)],
  );
  const z = { tage, bestaetigt: 0, gewechselt: 0, gesperrt: 0, nichtGefunden: 0, ueberApify: 0 };
  for (const row of r.rows) {
    const n = Number(row.n);
    if (row.ergebnis === "bestaetigt") z.bestaetigt += n;
    else if (row.ergebnis === "gewechselt") z.gewechselt += n;
    else if (row.ergebnis === "gesperrt") z.gesperrt += n;
    else if (row.ergebnis === "nicht_gefunden") z.nichtGefunden += n;
    if (row.quelle.startsWith("apify")) z.ueberApify += n;
  }
  return c.json(z, 200);
});
