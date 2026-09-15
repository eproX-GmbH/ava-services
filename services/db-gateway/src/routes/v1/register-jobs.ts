// Register-Delta S3 — Worker-Schnittstelle (Desktop "Mithelfen", S6) und
// Status fuer die Systemseite. Betreiber-Fallback (S5) nutzt dieselben
// Routen mit einem Dienstkonto.
//
//   POST /register-jobs/lease           Job holen (oder 204)
//   POST /register-jobs/{id}/ergebnis   Ergebnis melden
//   POST /register-jobs/{id}/fehler     Fehler melden (Job faellt zurueck)
//   GET  /register-jobs/status          Queue-Statistik
//   POST /register-jobs/refresh         Auffrischung fuer konkrete Blaetter anfordern

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  abfragenJeStundeFuer,
  atAnfordern,
  JOB_ARTEN_REGISTER,
  JobFehler,
  leaseJob,
  meldeFehler,
  refreshAnfordern,
  insolvenzAnfordern,
  insolvenzFaellige,
  registriereWorker,
  statistik,
  verarbeiteErgebnis,
  type JobArt,
} from "../../lib/register-jobs";
import { ErrorShape } from "./schemas";

export const registerJobsRouter = new OpenAPIHono();
registerJobsRouter.use("*", requireScope("company:read"));

const tag = "register-jobs";
const err = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "lease invalid" },
};

export const WorkerId = z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);
export const JobArtSchema = z.enum(["front", "bekanntmachungen", "refresh", "insolvenz", "at_front", "at_refresh", "at_insolvenz"]);

const JobShape = z
  .object({
    id: z.string(),
    art: JobArtSchema,
    schluessel: z.string(),
    payload: z.record(z.string(), z.unknown()),
    prioritaet: z.number().int(),
    leaseUntil: z.string().nullable(),
    versuche: z.number().int(),
    /** Budget-Hinweis fuer den Worker (Nutzungsordnung). */
    abfragenJeStunde: z.number().int(),
  })
  .openapi("RegisterJob");

const TrefferShape = z.object({
  gericht: z.string().min(1),
  art: z.string().min(2).max(4),
  nummer: z.number().int().nonnegative(),
  zusatz: z.string().max(3).default(""),
  frueher: z.string().max(80).default(""),
  bundesland: z.string().min(1),
  name: z.string().min(1),
  sitz: z.string().default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  historie: z.array(z.object({ name: z.string(), sitz: z.string().default(""), order: z.number().int() })).default([]),
});

const BekanntmachungShape = z.object({
  datum: z.string(),
  kategorie: z.string(),
  bundesland: z.string().nullable().default(null),
  gericht: z.string().nullable().default(null),
  art: z.string().nullable().default(null),
  nummer: z.number().int().nullable().default(null),
  zusatz: z.string().default(""),
  frueher: z.string().default(""),
  firma: z.string().default(""),
  sitz: z.string().default(""),
});

const InsolvenzMeldungShape = z.object({
  companyId: z.string().min(3),
  aktenzeichen: z.string().min(1).max(60),
  insolvenzgericht: z.string().min(1).max(80),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gegenstand: z.enum(["EROEFFNUNG", "ABWEISUNG_MANGELS_MASSE", "SICHERUNGSMASSNAHME", "AUFHEBUNG", "EINSTELLUNG", "ENTSCHEIDUNG", "VERTEILUNG", "INSOLVENZPLAN", "SONSTIGES"]),
  text: z.string().max(50_000).default(""),
  quelle: z.enum(["insolvenzportal", "ediktsdatei"]).optional(),
});

/** Oesterreich: Suchtreffer oder Detail aus JustizOnline (Paket register-delta, at-firmenbuch.ts). */
const TrefferAtShape = z.object({
  fnr: z.string().regex(/^\d{1,6}[a-z]$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200).default(""),
  status: z.enum(["ACTIVE", "CLOSED"]),
  gericht: z.string().min(1).max(200),
  bundesland: z.string().max(100).default(""),
  legalForm: z.string().max(200).nullable().optional(),
  uid: z.string().max(40).nullable().optional(),
});

export const ErgebnisShape = z.object({
  workerId: WorkerId,
  abfragen: z.number().int().nonnegative(),
  gesperrt: z.boolean().optional(),
  treffer: z.array(TrefferShape).max(5000).default([]),
  insolvenz: z.object({ meldungen: z.array(InsolvenzMeldungShape).max(2000), geprueft: z.array(z.string()).max(2000) }).optional(),
  front: z.object({ maxNummer: z.number().int().nonnegative(), offeneLuecken: z.array(z.number().int()).max(500), zusaetze: z.array(z.string()).optional() }).optional(),
  bekanntmachungen: z.array(BekanntmachungShape).max(5000).optional(),
  trefferAt: z.array(TrefferAtShape).max(5000).optional(),
  atFront: z.object({ begriff: z.string().min(2).max(4), naechsteSeite: z.number().int().nonnegative(), fertig: z.boolean(), gesamt: z.number().int().nonnegative() }).optional(),
});

function auth(c: { get: (k: "auth") => { tenantId: string; actorId: string } | undefined }) {
  const a = c.get("auth");
  if (!a?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  return a;
}

function jobFehler(e: unknown): never {
  if (e instanceof JobFehler) throw new HTTPException(e.status, { message: e.message });
  throw e;
}

const leaseRoute = createRoute({
  method: "post",
  path: "/register-jobs/lease",
  tags: [tag],
  summary: "Naechsten Register-Job leasen (20 Minuten)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ workerId: WorkerId, arten: z.array(JobArtSchema).optional(), workerArt: z.enum(["desktop", "betreiber"]).default("desktop") }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: JobShape } }, description: "job" },
    204: { description: "kein Job offen" },
    ...err,
  },
});
registerJobsRouter.openapi(leaseRoute, async (c) => {
  const a = auth(c);
  const body = c.req.valid("json");
  const pool = getGatewayPool();
  await registriereWorker(pool, body.workerId, a.tenantId, a.actorId, body.workerArt);
  const job = await leaseJob(pool, body.workerId, (body.arten as JobArt[] | undefined) ?? JOB_ARTEN_REGISTER);
  if (!job) return c.body(null, 204);
  return c.json(
    { id: job.id, art: job.art, schluessel: job.schluessel, payload: job.payload, prioritaet: job.prioritaet, leaseUntil: job.leaseUntil, versuche: job.versuche, abfragenJeStunde: abfragenJeStundeFuer(job.art) },
    200,
  );
});

const ergebnisRoute = createRoute({
  method: "post",
  path: "/register-jobs/{id}/ergebnis",
  tags: [tag],
  summary: "Ergebnis eines Register-Jobs melden",
  request: { params: z.object({ id: z.string().regex(/^\d+$/) }), body: { content: { "application/json": { schema: ErgebnisShape } } } },
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "verarbeitet" }, ...err },
});
registerJobsRouter.openapi(ergebnisRoute, async (c) => {
  auth(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    return c.json(await verarbeiteErgebnis(getGatewayPool(), id, body), 200);
  } catch (e) {
    jobFehler(e);
  }
});

const fehlerRoute = createRoute({
  method: "post",
  path: "/register-jobs/{id}/fehler",
  tags: [tag],
  summary: "Fehler eines Register-Jobs melden; Job faellt in die Queue zurueck",
  request: {
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    body: { content: { "application/json": { schema: z.object({ workerId: WorkerId, grund: z.string().min(1).max(500), abfragen: z.number().int().nonnegative().default(0) }) } } },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ status: z.string() }) } }, description: "ok" }, ...err },
});
registerJobsRouter.openapi(fehlerRoute, async (c) => {
  auth(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    return c.json(await meldeFehler(getGatewayPool(), id, body.workerId, body.grund, body.abfragen), 200);
  } catch (e) {
    jobFehler(e);
  }
});

const statusRoute = createRoute({
  method: "get",
  path: "/register-jobs/status",
  tags: [tag],
  summary: "Statistik der Register-Queue",
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(statusRoute, async (c) => {
  auth(c);
  return c.json(await statistik(getGatewayPool()), 200);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/register-jobs/refresh",
  tags: [tag],
  summary: "Auffrischung konkreter Registerblaetter anfordern (Buendel zu 25)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            firmen: z.array(z.object({ gericht: z.string().min(1), art: z.string().min(2).max(4), nummer: z.number().int().nonnegative(), zusatz: z.string().max(3).optional() })).min(1).max(500),
            grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung"),
          }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(refreshRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json({ jobs: await refreshAnfordern(getGatewayPool(), body.firmen, body.grund) }, 200);
});

// Insolvenz-Delta — Pruefung konkreter Firmen anfordern (Chat, Import, Firmendetail).
const insolvenzRoute = createRoute({
  method: "post",
  path: "/register-jobs/insolvenz",
  tags: [tag],
  summary: "Insolvenzpruefung fuer konkrete Firmen anfordern (Buendel zu 15, ohne Kadenz)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().min(3)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(insolvenzRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  const firmen = await insolvenzFaellige(body.companyIds, 0);
  return c.json({ jobs: await insolvenzAnfordern(getGatewayPool(), firmen, body.grund, 1), firmen: firmen.length }, 200);
});

// Oesterreich — Detail-Refresh und Ediktsdatei fuer konkrete Firmen anfordern (Chat, Import, Firmendetail).
const atRoute = createRoute({
  method: "post",
  path: "/register-jobs/at",
  tags: [tag],
  summary: "Oesterreich: Firmenbuch-Detail und Ediktsdatei fuer konkrete Firmen anfordern (AT_FN...)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().regex(/^AT_FN[1-9][0-9]{0,5}[A-Z]$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(atRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await atAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});
