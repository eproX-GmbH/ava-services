import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstreamBinary } from "../../lib/upstream";
import { ErrorShape, ImportExcelQuery, ImportExcelResponseShape } from "./schemas";

// =============================================================================
// §5.1 Excel import (W1 — start a transaction).
//
// Pipeline shape:
//
//   Desktop ──multipart──▶ db-gateway ──octet-stream──▶ master-data
//                                                          │
//                                                          ├─ create transaction row
//                                                          ├─ publish 6× CloudEvents
//                                                          │  (createStructuredContent,
//                                                          │   createWebsite, …)
//                                                          └─ Transaction-Id response header
//                                                          ▼
//                                                   gateway returns { transactionId }
//                                                          ▼
//                                              Desktop opens SSE on /v1/transactions/:id
//
// Why we route the binary through the gateway rather than letting Desktop
// hit master-data directly: scope/audit/JWT enforcement live here, the
// upstream URLs aren't reachable from outside the cluster, and uploads are
// the single largest payload we proxy — keeping the limit centralized
// (env: GATEWAY_MAX_UPLOAD_BYTES) avoids each upstream tuning its own.
// =============================================================================

export const importsRouter = new OpenAPIHono();
importsRouter.use("*", requireScope("import:write"));

const tag = "imports";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  413: { content: { "application/json": { schema: ErrorShape } }, description: "payload too large" },
  429: { content: { "application/json": { schema: ErrorShape } }, description: "rate limited" },
  502: { content: { "application/json": { schema: ErrorShape } }, description: "upstream failure" },
} as const;

// ---- POST /v1/imports/excel ------------------------------------------------
//
// Spec (DESKTOP_DATA_FLOW.md §5.1):
//   Body:    multipart/form-data; the xlsx file under the `file` field.
//   Query:   companyNameIdentifiers[], city, name?, isFuzzy?
//   Returns: 202 { transactionId }
//
// We document multipart as the input contract because that's what HTML form
// uploads / fetch+FormData produce. Internally we extract the file's bytes
// and POST them as `application/octet-stream` to master-data — the existing
// upstream contract — capturing the `Transaction-Id` response header.

const importExcelRoute = createRoute({
  method: "post",
  path: "/imports/excel",
  tags: [tag],
  summary: "Upload companies excel and start a transaction (W1)",
  request: {
    query: ImportExcelQuery,
    body: {
      content: {
        "multipart/form-data": {
          schema: z
            .object({
              file: z
                .any()
                .openapi({ type: "string", format: "binary", description: "xlsx file" }),
            })
            .openapi("ImportExcelMultipart"),
        },
      },
      required: true,
    },
  },
  responses: {
    202: {
      content: { "application/json": { schema: ImportExcelResponseShape } },
      description: "transaction accepted; pipeline events published",
    },
    ...errorResponses,
  },
});

importsRouter.openapi(importExcelRoute, async (c) => {
  const { companyNameIdentifiers, city, name, isFuzzy } = c.req.valid("query");

  // Pull the file out of the multipart form. Hono's parseBody returns a File
  // (Web API) for binary parts. We accept either field name `file` or the
  // first binary part (forgiving for clients that name it `excel`/`xlsx`).
  const form = await c.req.parseBody().catch(() => null);
  if (!form || typeof form !== "object") {
    throw new HTTPException(400, { message: "expected multipart/form-data body" });
  }

  let file: File | undefined;
  const named = (form as Record<string, unknown>)["file"];
  if (named instanceof File) {
    file = named;
  } else {
    for (const v of Object.values(form)) {
      if (v instanceof File) { file = v; break; }
    }
  }
  if (!file) {
    throw new HTTPException(400, { message: "missing file part" });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  const { headers } = await callUpstreamBinary(
    c,
    "masterData",
    "/api/v1/data-care",
    bytes,
    {
      contentType: "application/octet-stream",
      query: { companyNameIdentifiers, city, name, isFuzzy: String(isFuzzy) },
    },
  );

  const transactionId = headers.get("transaction-id") ?? headers.get("Transaction-Id");
  if (!transactionId) {
    // Defensive: master-data >= the version that adds the header always sets
    // it. If it's missing we have a deploy mismatch — fail loudly rather than
    // hand back a useless 202.
    throw new HTTPException(502, { message: "upstream omitted Transaction-Id header" });
  }

  return c.json({ transactionId }, 202);
});
