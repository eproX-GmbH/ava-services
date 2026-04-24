import { Hono } from "hono";

// Liveness probe only — no dependency checks. Readiness (with upstream DB
// ping) can be added once operational endpoints land; per D11 the client
// fails fast on first real request anyway.
export const healthRouter = new Hono().get("/", (c) =>
  c.json({ status: "ok", service: "db-gateway", version: "0.1.0" }),
);
