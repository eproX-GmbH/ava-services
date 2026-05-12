// Q-track v0.1.137 — Gateway-internal quota / park-state surface.
//
// HMAC-authed sibling of /v1. Master-data is the sole caller today; the
// resume-worker fan-out uses the same endpoints in the reverse
// direction. All routes are POST/GET/DELETE with JSON bodies; OpenAPI
// is intentionally skipped (this is an internal contract, not a public
// API), so we use plain Hono routes instead of @hono/zod-openapi.

import { Hono } from "hono";
import { getGatewayPool } from "../lib/producer-pools";
import { ensureBillingRowForQuota, periodKeyFor, isUnlimited, UNLIMITED } from "../lib/billing";
import { internalAuthMiddleware } from "../middleware/internal-auth";
import { logger } from "../lib/logger";

export const internalQuotaRouter = new Hono();

internalQuotaRouter.use("*", internalAuthMiddleware);

/** Parse the cached raw body (captured by the HMAC middleware) into JSON. */
function parseBody<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// POST /internal/quota/try-reserve
//
// Atomic "may this work proceed" gate. Locks the tenant's billing row,
// re-reads `used` from UsageEntry plus the live `parkedCount`, and
// returns `granted` when `used + parkedCount + count <= limit`. We DO
// NOT decrement here — the actual debit still happens via the persist-
// bus listener (`recordUsage`) when the structured-content persist
// event lands. This is just a gate that respects in-flight parks so
// two parallel imports don't race past the limit by their combined
// size.
//
// Body: { tenantId, count }
// Returns: { granted, used, limit, parkedCount }
internalQuotaRouter.post("/quota/try-reserve", async (c) => {
  const raw = c.get("internalRawBody");
  const body = parseBody<{ tenantId?: string; count?: number }>(raw);
  if (!body?.tenantId || typeof body.count !== "number" || body.count <= 0) {
    return c.json({ error: "bad_request" }, 400);
  }
  const { tenantId, count } = body;

  const pool = getGatewayPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Ensure billing row + lock it for the duration of the decision.
    const billing = await ensureBillingRowForQuota(client, tenantId);
    const periodKey = periodKeyFor(billing.tier);

    if (isUnlimited(billing.tier)) {
      await client.query("COMMIT");
      return c.json({
        granted: true,
        used: 0,
        limit: UNLIMITED,
        parkedCount: 0,
      });
    }

    const usedRes = await client.query<{ used: string }>(
      `SELECT COUNT(*)::text AS used
         FROM "UsageEntry"
        WHERE "tenantId" = $1 AND "periodKey" = $2`,
      [tenantId, periodKey],
    );
    const parkedRes = await client.query<{ parked: string }>(
      `SELECT COUNT(*)::text AS parked FROM "ParkedCompany" WHERE "tenantId" = $1`,
      [tenantId],
    );
    const used = Number(usedRes.rows[0]?.used ?? 0);
    const parkedCount = Number(parkedRes.rows[0]?.parked ?? 0);
    const limit = billing.quotaLimit;
    const granted = used + parkedCount + count <= limit;
    await client.query("COMMIT");
    return c.json({ granted, used, limit, parkedCount });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    logger.error(
      { err: err instanceof Error ? err.message : String(err), tenantId },
      "try-reserve failed",
    );
    return c.json({ error: "internal_error" }, 500);
  } finally {
    client.release();
  }
});

// POST /internal/quota/park
//
// Idempotent park insert. ON CONFLICT DO NOTHING so a retry-in-flight
// double-park collapses to a single row.
//
// Body: { tenantId, germanCompanyId, transactionId? }
// Returns: { parked: true }
internalQuotaRouter.post("/quota/park", async (c) => {
  const raw = c.get("internalRawBody");
  const body = parseBody<{
    tenantId?: string;
    germanCompanyId?: string;
    transactionId?: string | null;
  }>(raw);
  if (!body?.tenantId || !body.germanCompanyId) {
    return c.json({ error: "bad_request" }, 400);
  }
  await getGatewayPool().query(
    `INSERT INTO "ParkedCompany"
       ("tenantId", "germanCompanyId", "transactionId", "parkedAt")
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT ("tenantId", "germanCompanyId") DO NOTHING`,
    [body.tenantId, body.germanCompanyId, body.transactionId ?? null],
  );
  return c.json({ parked: true });
});

// GET /internal/quota/parked-batch?tenantId=...&limit=...
internalQuotaRouter.get("/quota/parked-batch", async (c) => {
  const tenantId = c.req.query("tenantId");
  const limitRaw = c.req.query("limit");
  const limit = Math.min(Math.max(Number(limitRaw ?? 20), 1), 100);
  if (!tenantId) return c.json({ error: "bad_request" }, 400);
  const res = await getGatewayPool().query<{
    germanCompanyId: string;
    transactionId: string | null;
    parkedAt: Date;
  }>(
    `SELECT "germanCompanyId", "transactionId", "parkedAt"
       FROM "ParkedCompany"
      WHERE "tenantId" = $1
      ORDER BY "parkedAt" ASC
      LIMIT $2`,
    [tenantId, limit],
  );
  return c.json({
    items: res.rows.map((r) => ({
      germanCompanyId: r.germanCompanyId,
      transactionId: r.transactionId,
      parkedAt: r.parkedAt.toISOString(),
    })),
  });
});

// DELETE /internal/quota/parked/:tenantId/:germanCompanyId
internalQuotaRouter.delete("/quota/parked/:tenantId/:germanCompanyId", async (c) => {
  const tenantId = c.req.param("tenantId");
  const germanCompanyId = c.req.param("germanCompanyId");
  await getGatewayPool().query(
    `DELETE FROM "ParkedCompany"
       WHERE "tenantId" = $1 AND "germanCompanyId" = $2`,
    [tenantId, germanCompanyId],
  );
  return c.json({ deleted: true });
});

// GET /internal/quota/parked-count?tenantId=...
internalQuotaRouter.get("/quota/parked-count", async (c) => {
  const tenantId = c.req.query("tenantId");
  if (!tenantId) return c.json({ error: "bad_request" }, 400);
  const res = await getGatewayPool().query<{ parked: string }>(
    `SELECT COUNT(*)::text AS parked FROM "ParkedCompany" WHERE "tenantId" = $1`,
    [tenantId],
  );
  return c.json({ parkedCount: Number(res.rows[0]?.parked ?? 0) });
});
