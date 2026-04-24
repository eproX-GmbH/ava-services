import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "../../prisma/generated/client";
import { logger } from "../lib/logger";

// Singleton — gateway has a single audit DB. Real DATABASE_URL comes from
// fly.io secrets.
const prisma = new PrismaClient();

// Audit middleware: assigns a request id, times the request, writes one
// row to audit_log post-response. Errors in the audit path must NEVER
// block the response, so we log-and-swallow.
export const auditMiddleware = createMiddleware(async (c, next) => {
  const requestId = c.req.header("x-request-id") ?? randomUUID();
  c.set("requestId", requestId);
  c.set("startedAt", Date.now());
  c.header("X-Request-Id", requestId);

  await next();

  const auth = c.get("auth");
  if (!auth) return; // unauthenticated request — nothing to pin audit to

  const durationMs = Date.now() - c.get("startedAt");
  prisma.auditLog
    .create({
      data: {
        tenantId: auth.tenantId,
        actorId: auth.actorId,
        method: c.req.method,
        path: c.req.path,
        statusCode: c.res.status,
        requestId,
        durationMs,
      },
    })
    .catch((err) => logger.error({ err, requestId }, "audit write failed"));
});
