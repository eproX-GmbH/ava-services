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
  ABFRAGEN_JE_STUNDE,
  JOB_ARTEN,
  JobFehler,
  leaseJob,
  meldeFehler,
  refreshAnfordern,
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
const JobArtSchema = z.enum(["front", "bekanntmachungen", "refresh"]);

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

export const ErgebnisShape = z.object({
  workerId: WorkerId,
  abfragen: z.number().int().nonnegative(),
  gesperrt: z.boolean().optional(),
  treffer: z.array(TrefferShape).max(5000).default([]),
  front: z.object({ maxNummer: z.number().int().nonnegative(), offeneLuecken: z.array(z.number().int()).max(500), zusaetze: z.array(z.string()).optional() }).optional(),
  bekanntmachungen: z.array(BekanntmachungShape).max(5000).optional(),
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
  const job = await leaseJob(pool, body.workerId, (body.arten as JobArt[] | undefined) ?? JOB_ARTEN);
  if (!job) return c.body(null, 204);
  return c.json(
    { id: job.id, art: job.art, schluessel: job.schluessel, payload: job.payload, prioritaet: job.prioritaet, leaseUntil: job.leaseUntil, versuche: job.versuche, abfragenJeStunde: ABFRAGEN_JE_STUNDE },
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
