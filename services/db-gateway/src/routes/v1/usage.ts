// M1 of monetization plan — read-only usage snapshot for the
// authenticated tenant.
//
// Surface:
//   GET /v1/usage → { tier, used, limit, remaining, periodEnd, periodKey }
//
// Backed by `lib/billing.ts → getUsageSnapshot`. The desktop polls
// this for the Settings "Plan & Verbrauch" card and the topbar pill;
// the agent calls it before committing a non-dryRun import to surface
// "this would put you over your quota" warnings.
//
// No write-side endpoints in M1 — quota changes happen via:
//   - lazy create on first persist (defaults to free / 25)
//   - operator hand-edit (psql) for support cases
//   - M3's Stripe webhook for paid-tier flips
//
// All under the same auth + rate-limit + audit chain as the rest of
// /v1 (mounted from routes/v1.ts).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { getUsageSnapshot } from "../../lib/billing";
import { ErrorShape } from "./schemas";

export const usageRouter = new OpenAPIHono();

const UsageResponseShape = z
  .object({
    tier: z.enum(["free", "starter", "pro", "enterprise"]),
    used: z.number().int().nonnegative(),
    /** -1 sentinel = no enforcement (enterprise tier). Otherwise the
     *  per-period quota. Clients render -1 as "∞". */
    limit: z.number().int(),
    /** Same -1 sentinel pattern; otherwise max(0, limit-used). */
    remaining: z.number().int(),
    /** ISO-8601. null for free + enterprise (no rolling reset). */
    periodEnd: z.string().nullable(),
    /** "lifetime" for free; "YYYY-MM" for paid tiers; "unlimited" for
     *  enterprise. The desktop picks a German label based on this. */
    periodKey: z.string(),
    /** v0.1.103 — true when the user has scheduled cancellation but
     *  the period hasn't ended yet. Desktop shows
     *  "Kündigung zum X vorgemerkt" while this is true. */
    cancelAtPeriodEnd: z.boolean(),
  })
  .openapi("UsageSnapshot");

const usageRoute = createRoute({
  method: "get",
  path: "/usage",
  tags: ["billing"],
  summary: "Read the calling tenant's quota usage snapshot",
  responses: {
    200: {
      content: { "application/json": { schema: UsageResponseShape } },
      description:
        "current period usage. `remaining` is clamped to >=0 even when used > limit (manual quota cuts).",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

usageRouter.openapi(usageRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const snapshot = await getUsageSnapshot(getGatewayPool(), auth.tenantId);
  return c.json(snapshot, 200);
});
