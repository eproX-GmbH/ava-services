import { OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { auditMiddleware } from "../middleware/audit";

// /v1 router.
//
// Operational endpoints are intentionally empty. Per DECISIONS.md D3 the
// scope is derived in Step 5 from the Desktop-App's data flow — NOT by
// mirroring the full Postgres schema. As each endpoint is defined, register
// it here with its OpenAPI schema so the generated spec stays truthful.
//
// Every route under /v1 runs: auth → rate-limit → audit. Scope-guarding
// is per-route via requireScope() from middleware/auth.
export const v1 = new OpenAPIHono();

v1.use("*", authMiddleware);
v1.use("*", rateLimitMiddleware);
v1.use("*", auditMiddleware);

// Placeholder so the router is not empty. Remove when the first real
// endpoint lands.
v1.get("/whoami", (c) => {
  const auth = c.get("auth");
  return c.json({ tenantId: auth.tenantId, actorId: auth.actorId, scopes: auth.scopes });
});
