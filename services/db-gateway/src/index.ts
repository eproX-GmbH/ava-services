import { serve } from "@hono/node-server";
import { swaggerUI } from "@hono/swagger-ui";
import { OpenAPIHono } from "@hono/zod-openapi";
import { loadEnv } from "./lib/env";
import { logger } from "./lib/logger";
import { healthRouter } from "./routes/health";
import { v1 } from "./routes/v1";

const env = loadEnv();
const app = new OpenAPIHono();

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
