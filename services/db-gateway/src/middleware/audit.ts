import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";

// Prisma client is loaded lazily so typecheck and dev-time edits don't
// require `prisma generate` to have run. At runtime this is a hard failure
// path — deploys must run `prisma generate` in the Docker build.
type AuditWrite = { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
let auditLog: AuditWrite | undefined;
function getAuditLog(): AuditWrite {
  if (!auditLog) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { PrismaClient } = require("../../prisma/generated/client") as {
      PrismaClient: new () => { auditLog: AuditWrite };
    };
    auditLog = new PrismaClient().auditLog;
  }
  return auditLog;
}

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
  getAuditLog()
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
    .catch((err: unknown) => logger.error({ err, requestId }, "audit write failed"));
});
