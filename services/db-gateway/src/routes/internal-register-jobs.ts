// Register-Delta S5 — Betreiber-Fallback-Worker auf Fly spricht die Queue ueber
// den HMAC-Kanal an (kein Keycloak-Dienstkonto noetig). Gleiche Semantik wie
// /v1/register-jobs/* (routes/v1/register-jobs.ts), Zod-Pruefung dort.

import { Hono } from "hono";
import { z } from "zod";
import { internalAuthMiddleware } from "../middleware/internal-auth";
import { getGatewayPool } from "../lib/producer-pools";
import { ABFRAGEN_JE_STUNDE, JOB_ARTEN, JobFehler, leaseJob, meldeFehler, registriereWorker, verarbeiteErgebnis, type Ergebnis, type JobArt } from "../lib/register-jobs";
import { ErgebnisShape, WorkerId } from "./v1/register-jobs";

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
  const body = parse(c.get("internalRawBody"), z.object({ workerId: WorkerId, arten: z.array(z.enum(["front", "bekanntmachungen", "refresh"])).optional() }));
  if (!body) return c.json({ error: "bad_request" }, 400);
  const pool = getGatewayPool();
  await registriereWorker(pool, body.workerId, null, null, "betreiber");
  const job = await leaseJob(pool, body.workerId, (body.arten as JobArt[] | undefined) ?? JOB_ARTEN);
  if (!job) return c.body(null, 204);
  return c.json({ ...job, abfragenJeStunde: ABFRAGEN_JE_STUNDE });
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
