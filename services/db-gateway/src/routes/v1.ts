import { OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { auditMiddleware } from "../middleware/audit";
import { companiesRouter } from "./v1/companies";
import { transactionsRouter } from "./v1/transactions";

// /v1 router.
//
// Scope is governed by `DESKTOP_DATA_FLOW.md` — every endpoint mounted here
// must trace back to a workflow (W1..W25). Implementation order is locked
// in that doc's §11:
//   1. §4.1 Company reads ← implemented below
//   2. §6  SSE bridge   ← pending
//   3. §4.2 Transaction reads (blocked on 2)
//   4. §4.3 Evaluation reads
//   5-7. Writes
//
// Every /v1 route runs: auth → rate-limit → audit.
export const v1 = new OpenAPIHono();

v1.use("*", authMiddleware);
v1.use("*", rateLimitMiddleware);
v1.use("*", auditMiddleware);

// §4.1 Company reads (W6-W13).
v1.route("/", companiesRouter);

// §6 SSE bridge — transaction progress streaming (W4).
v1.route("/", transactionsRouter);

// Retained for smoke-testing auth end-to-end. Safe to remove once clients
// exist — no workflow reference.
v1.get("/whoami", (c) => {
  const auth = c.get("auth");
  return c.json({ tenantId: auth.tenantId, actorId: auth.actorId, scopes: auth.scopes });
});
