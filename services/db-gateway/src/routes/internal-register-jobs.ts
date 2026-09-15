// Register-Delta S5 — Betreiber-Fallback-Worker auf Fly spricht die Queue ueber
// den HMAC-Kanal an (kein Keycloak-Dienstkonto noetig). Gleiche Semantik wie
// /v1/register-jobs/* (routes/v1/register-jobs.ts), Zod-Pruefung dort.

import { Hono } from "hono";
import { z } from "zod";
import { internalAuthMiddleware } from "../middleware/internal-auth";
import { getGatewayPool } from "../lib/producer-pools";
import { abfragenJeStundeFuer, erzeugeAtJobs, erzeugeUkJobs, JOB_ARTEN_REGISTER, JobFehler, leaseJob, meldeFehler, registriereWorker, verarbeiteErgebnis, verarbeiteTeilergebnis, type Ergebnis, type JobArt } from "../lib/register-jobs";
import { ErgebnisShape, JobArtSchema, TeilergebnisShape, WorkerId } from "./v1/register-jobs";

export const internalRegisterJobsRouter = new Hono();
internalRegisterJobsRouter.use("*", internalAuthMiddleware);

function parse<T>(raw: string, schema: z.ZodType<T>): T | null {
  try {
    const r = schema.safeParse(JSON.parse(raw || "{}"));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

internalRegisterJobsRouter.post("/register-jobs/lease", async (c) => {
  const body = parse(c.get("internalRawBody"), z.object({ workerId: WorkerId, arten: z.array(JobArtSchema).optional() }));
  if (!body) return c.json({ error: "bad_request" }, 400);
  const pool = getGatewayPool();
  await registriereWorker(pool, body.workerId, null, null, "betreiber");
  const job = await leaseJob(pool, body.workerId, (body.arten as JobArt[] | undefined) ?? JOB_ARTEN_REGISTER);
  if (!job) return c.body(null, 204);
  return c.json({ ...job, abfragenJeStunde: abfragenJeStundeFuer(job.art) });
});

internalRegisterJobsRouter.post("/register-jobs/:id/teilergebnis", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: "bad_request" }, 400);
  const body = parse(c.get("internalRawBody"), TeilergebnisShape);
  if (!body) return c.json({ error: "bad_request" }, 400);
  try {
    return c.json(await verarbeiteTeilergebnis(getGatewayPool(), id, body));
  } catch (e) {
    if (e instanceof JobFehler) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

// UK — Monatsjobs sofort erzeugen (Betrieb; sonst Cron 02:00 UTC). Idempotent ueber Abzugsdatum und Monat.
internalRegisterJobsRouter.post("/register-jobs/uk/erzeugen", async (c) => {
  const body = parse(c.get("internalRawBody"), z.object({}).passthrough());
  if (!body) return c.json({ error: "bad_request" }, 400);
  return c.json(await erzeugeUkJobs(getGatewayPool()));
});

// Oesterreich — Monatsjobs sofort erzeugen (Betrieb; sonst Cron 02:00 UTC). Idempotent ueber den Monatsschluessel.
internalRegisterJobsRouter.post("/register-jobs/at/erzeugen", async (c) => {
  const body = parse(c.get("internalRawBody"), z.object({}).passthrough());
  if (!body) return c.json({ error: "bad_request" }, 400);
  return c.json(await erzeugeAtJobs(getGatewayPool()));
});

internalRegisterJobsRouter.post("/register-jobs/:id/ergebnis", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: "bad_request" }, 400);
  const body = parse(c.get("internalRawBody"), ErgebnisShape);
  if (!body) return c.json({ error: "bad_request" }, 400);
  try {
    return c.json(await verarbeiteErgebnis(getGatewayPool(), id, body as Ergebnis));
  } catch (e) {
    if (e instanceof JobFehler) return c.json({ error: e.message }, e.status);
    throw e;
  }
});

internalRegisterJobsRouter.post("/register-jobs/:id/fehler", async (c) => {
  const id = c.req.param("id");
  const body = parse(c.get("internalRawBody"), z.object({ workerId: WorkerId, grund: z.string().min(1).max(500), abfragen: z.number().int().nonnegative().default(0) }));
  if (!/^\d+$/.test(id) || !body) return c.json({ error: "bad_request" }, 400);
  try {
    return c.json(await meldeFehler(getGatewayPool(), id, body.workerId, body.grund, body.abfragen));
  } catch (e) {
    if (e instanceof JobFehler) return c.json({ error: e.message }, e.status);
    throw e;
  }
});
