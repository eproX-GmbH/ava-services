// Load gateway-local .env BEFORE anything reads process.env. dev.sh exports
// the shared root .env.dev (JWKS, AMQP, upstream URLs, etc.) into the shell;
// the gateway's own audit DATABASE_URL/DIRECT_URL must NOT live there because
// the producers each have their own per-service Postgres on :5434 and would
// otherwise inherit the gateway's URL via dev.sh's `set -a; source` and
// silently connect to the wrong DB (dotenv won't override exported vars).
import "dotenv/config";
import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { healthRouter } from "./routes/health";
import { v1 } from "./routes/v1";

const env = loadEnv();
const app = new OpenAPIHono();

// CORS.
//
// The Electron renderer loads from `file://` (prod) or
// `http://localhost:<vite-port>` (dev). Both are cross-origin to the
// gateway, so without this middleware the browser blocks every fetch.
//
// Allow-list strategy:
//   - In dev (`NODE_ENV !== "production"`) we mirror back the request's
//     Origin so any localhost port works without config churn.
//   - In prod we restrict to GATEWAY_ALLOWED_ORIGINS (comma-separated),
//     which production deployments set explicitly. `null` origin (the
//     `file://` Electron prod load) is allow-listed when the env var
//     contains the literal string `electron`.
const allowedOrigins = (env.GATEWAY_ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(
  "*",
  cors({
    origin: (origin) => {
      if (env.NODE_ENV !== "production") return origin ?? "*";
      if (!origin || origin === "null") {
        return allowedOrigins.includes("electron") ? "null" : "";
      }
      return allowedOrigins.includes(origin) ? origin : "";
    },
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "X-Request-Id",
      "Idempotency-Key",
      // Option D — BYO-key passthrough. Browser CORS preflight rejects
      // unlisted custom headers; the renderer attaches these on every
      // dispatch request when the user has configured an LLM provider.
      "X-Ava-User-Llm-Provider",
      "X-Ava-User-Llm-Key",
      "X-Ava-User-Llm-Model",
    ],
    exposeHeaders: ["X-Request-Id", "Transaction-Id"],
    credentials: true,
    maxAge: 600,
  }),
);

// Public routes — no auth.
app.route("/health", healthRouter);

// Versioned API.
app.route("/v1", v1);

// OpenAPI spec + Swagger UI. Per D3 the REST + OpenAPI combo replaces tRPC.
app.doc("/openapi.json", {
  openapi: "3.1.0",
  info: { title: "AVA DB Gateway", version: "0.1.0" },
});
app.get("/docs", swaggerUI({ url: "/openapi.json" }));

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "db-gateway listening");
});

// §8.v3 — gateway is now the single persist service. Subscribe the
// 5 `tenant.persist.<producer>.v1` queues at boot. A failure here
// must not crash the HTTP server (read paths still work without
// persist), but it's loud in logs.
import("./lib/persist-bus")
  .then(({ persistBus }) => persistBus.ensureConnected())
  .catch((err) => {
    logger.error({ err }, "persist-bus failed to start");
  });
