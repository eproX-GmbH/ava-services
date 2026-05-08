import { OpenAPIHono } from "@hono/zod-openapi";
import { authMiddleware } from "../middleware/auth";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { auditMiddleware } from "../middleware/audit";
import { companiesRouter } from "./v1/companies";
import { companyWritesRouter } from "./v1/company-writes";
import { evaluationsRouter } from "./v1/evaluations";
import { evaluationWritesRouter } from "./v1/evaluation-writes";
import { importsRouter } from "./v1/imports";
import { transactionsRouter } from "./v1/transactions";
import { localAmqpRouter } from "./v1/local-amqp";
import { proxyRouter } from "./v1/proxy";
import { producersRouter } from "./v1/producers";
import { crmRouter } from "./v1/crm";
import { usageRouter } from "./v1/usage";
import { companiesMatrixRouter } from "./v1/companies-matrix";
import { companyStateRouter } from "./v1/company-state";

// /v1 router.
//
// Scope is governed by `DESKTOP_DATA_FLOW.md` — every endpoint mounted here
// must trace back to a workflow (W1..W25). Implementation order is locked
// in that doc's §11:
//   1. §4.1 Company reads     ← done
//   2. §6  SSE bridge         ← done
//   3. §4.2 Transaction reads ← done (snapshot views; live progress via SSE)
//   4. §4.3 Evaluation reads  ← done (cluster GET stubbed 501 — upstream gap)
//   5. §5.1 Excel import      ← done
//   6. §5.2 Evaluation writes ← done
//   7. §5.3 Corrections       ← done — Step 5 endpoints complete
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

// §5.1 Excel import (W1).
v1.route("/", importsRouter);

// §5.2 Evaluation writes (W14, W16, W17, W18, W20, W21).
v1.route("/", evaluationWritesRouter);

// §5.3 Manual corrections (W23, W24, W25).
v1.route("/", companyWritesRouter);

// 8.v1.3 — local-producer AMQP credential handout. Bearer-gated;
// returns the broker URL the desktop's ProducerSupervisor injects
// into spawned producer Node subprocesses.
v1.route("/", localAmqpRouter);

// §8.v3 — operator-paid API key proxies (today: valueserp). The
// localized website + company-contact producers POST here instead
// of holding the operator's key on-device.
v1.route("/", proxyRouter);

// §8.v3 cosmetics — per-producer queue depth (Settings panel).
v1.route("/", producersRouter);

// §8.v3 CRM — OAuth code-exchange + refresh proxy for Salesforce /
// HubSpot / Dynamics. Tokens never persist on the gateway; desktop
// stores them in the OS keychain via Electron safeStorage.
v1.route("/", crmRouter);

// M1 monetization (v0.1.59) — read-only quota snapshot. Writes happen
// via persist-bus side effect (lib/billing.ts) and the M3 Stripe
// webhook; the desktop just reads.
v1.route("/", usageRouter);

// v0.1.61 — global per-tenant "all companies" matrix. Aggregates
// EntityProgress per (companyId, producer) across all transactions.
v1.route("/", companiesMatrixRouter);

// v0.1.63 — F3 producer pre-check. /v1/companies/:id/state returns
// per-stage ContentFreshness (updatedAt + llmTier). Producers query
// this at compute start and skip if data is fresh+same-or-better-tier.
v1.route("/", companyStateRouter);

// Retained for smoke-testing auth end-to-end. Safe to remove once clients
// exist — no workflow reference.
v1.get("/whoami", (c) => {
  const auth = c.get("auth");
  return c.json({ tenantId: auth.tenantId, actorId: auth.actorId, scopes: auth.scopes });
});
