import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { callUpstreamBinary, callUpstreamBinaryExpectJson } from "../../lib/upstream";
import { setTransactionName } from "../../lib/transaction-names";
import { seedEntityProgressForTransaction } from "../../lib/entity-progress-seed";
import { buildXlsx } from "../../lib/xlsx-mini";
import { assertQuotaAvailable } from "../../lib/billing";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  CompanyIngestBody,
  CompanyIngestResponseShape,
  ErrorShape,
  FromListIngestBody,
  FromListIngestResponseShape,
  ImportExcelQuery,
  ImportExcelResponseShape,
  ImportPreviewShape,
} from "./schemas";

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
    200: {
      content: { "application/json": { schema: ImportPreviewShape } },
      description: "dry-run preview (when ?dryRun=true)",
    },
    202: {
      content: { "application/json": { schema: ImportExcelResponseShape } },
      description: "transaction accepted; pipeline events published",
    },
    ...errorResponses,
  },
});

importsRouter.openapi(importExcelRoute, async (c) => {
  const { companyNameIdentifiers, city, name, isFuzzy, dryRun, expectedCount } =
    c.req.valid("query");

  // M2 — pre-import quota gate. Skips on dryRun (no usage debited).
  // `expectedCount` is desktop-supplied; we fall back to 1 so a free-
  // tier user already at quota can't sneak past with a missing param.
  if (!dryRun) {
    const auth = c.get("auth");
    if (auth?.tenantId) {
      await assertQuotaAvailable(getGatewayPool(), auth.tenantId, expectedCount ?? 1);
    }
  }

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

  // v0.1.57 — dry-run path returns the JSON preview from master-data
  // verbatim, no transaction created.
  if (dryRun) {
    const { body } = await callUpstreamBinaryExpectJson(
      c,
      "masterData",
      "/api/v1/data-care",
      bytes,
      {
        contentType: "application/octet-stream",
        query: {
          companyNameIdentifiers,
          city,
          name,
          isFuzzy: String(isFuzzy),
          dryRun: "true",
        },
      },
    );
    return c.json(body as object, 200);
  }

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

  // Master-data accepts the `name` query param but doesn't currently
  // propagate it to the company-profile transaction record that backs
  // the read endpoints. Persist the gateway-side annotation so the
  // list / detail routes can overlay it. Idempotent: re-uploading the
  // same file with the same name is a no-op.
  setTransactionName(transactionId, name ?? null);

  // §8.v3 — populate the per-(company × producer) matrix with
  // pending rows immediately so the desktop transaction view is
  // non-empty before any producer has finished its first company.
  // Best-effort: failures are logged + swallowed inside the helper.
  await seedEntityProgressForTransaction(c, transactionId);

  return c.json({ transactionId }, 202);
});

// ---- POST /v1/companies (Phase 8.h) ----------------------------------------
//
// Single-row sibling of `/v1/imports/excel`. The body is JSON `{name, city,
// transactionName?, isFuzzy?}`; the gateway hand-encodes a 2-column,
// 1-data-row xlsx (see lib/xlsx-mini.ts) and POSTs it to the same upstream
// `/api/v1/data-care` endpoint as the bulk import. Response shape matches
// the bulk endpoint exactly (`{transactionId}`) so the desktop client
// can subscribe to the same SSE progress stream regardless of how the
// transaction was started.
//
// Why not let upstream accept JSON directly: master-data's xlsx parser is
// the only ingest path, and gating one extra route at the gateway keeps
// upstream untouched. If/when master-data grows a JSON ingest, swap the
// internals here without changing the desktop-facing shape.
//
// `companyNameIdentifiers` and `city` query strings on the upstream call
// must match the xlsx column headers — we pin both to "company"/"city"
// in the encoder and the URL so the parser correctly picks up the row.

const COMPANY_HEADER = "company";
const CITY_HEADER = "city";

const companyIngestRoute = createRoute({
  method: "post",
  path: "/companies",
  tags: [tag],
  summary: "Ingest one company (single-row sibling of /imports/excel)",
  request: {
    body: {
      content: { "application/json": { schema: CompanyIngestBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportPreviewShape } },
      description: "dry-run preview (when body.dryRun=true)",
    },
    202: {
      content: { "application/json": { schema: CompanyIngestResponseShape } },
      description: "transaction accepted; pipeline events published",
    },
    ...errorResponses,
  },
});

importsRouter.openapi(companyIngestRoute, async (c) => {
  const { name, city, transactionName, isFuzzy, dryRun } = c.req.valid("json");

  // M2 — single-row ingest still costs one quota credit when not dry-run.
  if (!dryRun) {
    const auth = c.get("auth");
    if (auth?.tenantId) {
      await assertQuotaAvailable(getGatewayPool(), auth.tenantId, 1);
    }
  }

  const xlsx = buildXlsx({
    headers: [COMPANY_HEADER, CITY_HEADER],
    rows: [[name, city]],
  });

  const effectiveTxName = transactionName ?? `Single ingest: ${name}`;

  // v0.1.57 — dry-run preview path.
  if (dryRun) {
    const { body } = await callUpstreamBinaryExpectJson(
      c,
      "masterData",
      "/api/v1/data-care",
      xlsx,
      {
        contentType: "application/octet-stream",
        query: {
          companyNameIdentifiers: COMPANY_HEADER,
          city: CITY_HEADER,
          name: effectiveTxName,
          isFuzzy: String(isFuzzy ?? false),
          dryRun: "true",
        },
      },
    );
    return c.json(body as object, 200);
  }

  const { headers } = await callUpstreamBinary(
    c,
    "masterData",
    "/api/v1/data-care",
    xlsx,
    {
      contentType: "application/octet-stream",
      query: {
        companyNameIdentifiers: COMPANY_HEADER,
        city: CITY_HEADER,
        // Mirror the bulk endpoint's default-fallback name shape.
        name: effectiveTxName,
        isFuzzy: String(isFuzzy ?? false),
      },
    },
  );

  const transactionId =
    headers.get("transaction-id") ?? headers.get("Transaction-Id");
  if (!transactionId) {
    throw new HTTPException(502, {
      message: "upstream omitted Transaction-Id header",
    });
  }
  // Persist the gateway-side annotation so list/detail reads can
  // surface it; same rationale as POST /v1/imports/excel.
  setTransactionName(transactionId, effectiveTxName);
  // §8.v3 — same matrix-seeding rationale as the bulk endpoint above.
  await seedEntityProgressForTransaction(c, transactionId);
  return c.json({ transactionId }, 202);
});

// ---- POST /v1/imports/from-list (v0.1.57 — CRM Phase 2) --------------------
//
// Bulk JSON ingest used by the desktop's CRM-import flow. The agent fetches
// companies from the user's connected CRM (HubSpot/Salesforce/Dynamics),
// shapes them into `[{name, city}]`, and POSTs here. The gateway hand-encodes
// a multi-row xlsx and forwards it to master-data exactly like the file-
// upload endpoint — same upstream contract, same downstream pipeline.
//
// Why JSON-in / xlsx-out: master-data's xlsx parser is the canonical ingest
// path; teaching it a second JSON path doubles the surface area of the
// trickiest service in the cluster. The xlsx-mini encoder is already in the
// gateway and was always designed for multi-row output (this just exercises
// the path the single-row endpoint above doesn't).
//
// One transaction with N companies — NOT N transactions with 1 each — so the
// resulting matrix view stays coherent and SSE progress updates land on the
// same view the user opened after the import.

const fromListIngestRoute = createRoute({
  method: "post",
  path: "/imports/from-list",
  tags: [tag],
  summary:
    "Ingest a list of companies (JSON) and start one transaction. Used by the CRM-import flow; otherwise prefer /imports/excel for file uploads.",
  request: {
    body: {
      content: { "application/json": { schema: FromListIngestBody } },
      required: true,
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ImportPreviewShape } },
      description: "dry-run preview (when body.dryRun=true)",
    },
    202: {
      content: { "application/json": { schema: FromListIngestResponseShape } },
      description: "transaction accepted; pipeline events published",
    },
    ...errorResponses,
  },
});

importsRouter.openapi(fromListIngestRoute, async (c) => {
  const { companies, transactionName, isFuzzy, dryRun } = c.req.valid("json");

  // M2 — quota gate sized to the JSON list length (atomic; no partial
  // imports). Dry-run skips the gate so the user can still see the
  // preview when over quota.
  if (!dryRun) {
    const auth = c.get("auth");
    if (auth?.tenantId) {
      await assertQuotaAvailable(
        getGatewayPool(),
        auth.tenantId,
        companies.length,
      );
    }
  }

  const xlsx = buildXlsx({
    headers: [COMPANY_HEADER, CITY_HEADER],
    rows: companies.map((c) => [c.name, c.city]),
  });

  const effectiveTxName =
    transactionName ?? `CRM import: ${companies.length} companies`;

  // v0.1.57 — dry-run preview path. Returns master-data's JSON envelope.
  if (dryRun) {
    const { body } = await callUpstreamBinaryExpectJson(
      c,
      "masterData",
      "/api/v1/data-care",
      xlsx,
      {
        contentType: "application/octet-stream",
        query: {
          companyNameIdentifiers: COMPANY_HEADER,
          city: CITY_HEADER,
          name: effectiveTxName,
          isFuzzy: String(isFuzzy ?? false),
          dryRun: "true",
        },
      },
    );
    return c.json(body as object, 200);
  }

  const { headers } = await callUpstreamBinary(
    c,
    "masterData",
    "/api/v1/data-care",
    xlsx,
    {
      contentType: "application/octet-stream",
      query: {
        companyNameIdentifiers: COMPANY_HEADER,
        city: CITY_HEADER,
        name: effectiveTxName,
        isFuzzy: String(isFuzzy ?? false),
      },
    },
  );

  const transactionId =
    headers.get("transaction-id") ?? headers.get("Transaction-Id");
  if (!transactionId) {
    throw new HTTPException(502, {
      message: "upstream omitted Transaction-Id header",
    });
  }
  setTransactionName(transactionId, effectiveTxName);
  await seedEntityProgressForTransaction(c, transactionId);
  return c.json(
    { transactionId, companyCount: companies.length },
    202,
  );
});
