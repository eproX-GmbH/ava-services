import { OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { auditMiddleware } from "../middleware/audit";
import { companiesRouter } from "./v1/companies";
import { evaluationsRouter } from "./v1/evaluations";
import { transactionsRouter } from "./v1/transactions";

// /v1 router.
//
// Scope is governed by `DESKTOP_DATA_FLOW.md` — every endpoint mounted here
// must trace back to a workflow (W1..W25). Implementation order is locked
// in that doc's §11:
//   1. §4.1 Company reads     ← done
//   2. §6  SSE bridge         ← done
//   3. §4.2 Transaction reads ← done (snapshot views; live progress via SSE)
//   4. §4.3 Evaluation reads  ← done (cluster GET stubbed 501 — upstream gap)
//   5-7. Writes               ← pending
//
// Every /v1 route runs: auth → rate-limit → audit.
export const v1 = new OpenAPIHono();

v1.use("*", authMiddleware);
v1.use("*", rateLimitMiddleware);
v1.use("*", auditMiddleware);

// §4.1 Company reads (W6-W13).
v1.route("/", companiesRouter);

// §4.2 Transaction reads (W2-W5) + §6 SSE bridge (W4).
v1.route("/", transactionsRouter);

// §4.3 Evaluation reads (W15, W19, W22).
v1.route("/", evaluationsRouter);

// Retained for smoke-testing auth end-to-end. Safe to remove once clients
// exist — no workflow reference.
v1.get("/whoami", (c) => {
  const auth = c.get("auth");
  return c.json({ tenantId: auth.tenantId, actorId: auth.actorId, scopes: auth.scopes });
});
