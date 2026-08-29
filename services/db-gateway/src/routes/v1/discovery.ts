// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Scan-Routen.
//
//   POST /v1/discovery/scans                       Scan starten (Quota-Gate)
//   POST /v1/discovery/scans/{scanId}/candidates   Kandidaten-Batch mergen
//   GET  /v1/discovery/candidates                  Kandidaten lesen (Radius)
//
// Der Scan selbst (Overpass, valueserp) laeuft auf der Nutzer-Maschine
// (Compute-Locality, Entscheidung A2); das Gateway haelt den geteilten
// Bestand, das Quota-Gate (O3) und den Dedup-Hook gegen master-data
// (Fuzzy Name+Ort per Dry-Run, gleiche Mechanik wie der Excel-Import).
//
// Alle Pfade sind literal (kein {param} an erster Stelle) — keine
// Kollision mit anderen Routern.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  addCandidates,
  listCandidates,
  startScan,
  saveProfile,
  discoveryIdFor,
  type CandidateInput,
} from "../../lib/discovery";
import { buildXlsx } from "../../lib/xlsx-mini";
import { callUpstreamBinaryExpectJson } from "../../lib/upstream";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const discoveryRouter = new OpenAPIHono();

// ---- POST /discovery/scans -------------------------------------------------

const StartScanResponseShape = z
  .object({
    scanId: z.string(),
    maxCandidatesPerScan: z.number(),
    maxScansPerDay: z.number(),
    scansUsedToday: z.number(),
  })
  .openapi("DiscoveryStartScanResponse");

const startScanRoute = createRoute({
  method: "post",
  path: "/discovery/scans",
  tags: ["discovery"],
  summary: "Discovery-Scan starten (Quota-Gate: Scans/Tag pro Tenant).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            ort: z.string().min(2).max(120),
            radiusKm: z.number().int().min(1).max(200),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: { "application/json": { schema: StartScanResponseShape } },
      description: "Scan angelegt",
    },
    429: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Tages-Quota erschoepft",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(startScanRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { ort, radiusKm } = c.req.valid("json");
  const result = await startScan(getGatewayPool(), {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    ort,
    radiusKm,
  });
  if (!result.ok) {
    throw new HTTPException(429, {
      message: `Discovery-Tageslimit erreicht (${result.scansUsedToday}/${result.limits.maxScansPerDay} Scans heute)`,
    });
  }
  return c.json(
    {
      scanId: result.scanId,
      maxCandidatesPerScan: result.limits.maxCandidatesPerScan,
      maxScansPerDay: result.limits.maxScansPerDay,
      scansUsedToday: result.scansUsedToday,
    },
    201,
  );
});

// ---- POST /discovery/scans/{scanId}/candidates -----------------------------

const CandidateInputShape = z.object({
  name: z.string().min(2).max(300),
  city: z.string().max(120).nullish(),
  plz: z.string().max(10).nullish(),
  lat: z.number().nullish(),
  lon: z.number().nullish(),
  /** Website — Pflicht (Zielbild: Firmen ohne Website werden komplett
   *  uebersprungen; die normierte Kern-Domain ist die Discovery-ID). */
  domain: z.string().min(4).max(200),
  category: z.string().max(120).nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
  source: z.enum(["osm", "serp", "register"]),
});

const AddCandidatesResponseShape = z
  .object({
    added: z.number(),
    updated: z.number(),
    capped: z.number(),
    skippedNoDomain: z.number(),
    /** discoveryId → master-data companyId (bereits bekannte Firmen). */
    known: z.record(z.string(), z.string()),
  })
  .openapi("DiscoveryAddCandidatesResponse");

const addCandidatesRoute = createRoute({
  method: "post",
  path: "/discovery/scans/{scanId}/candidates",
  tags: ["discovery"],
  summary:
    "Kandidaten-Batch in den geteilten Discovery-Bestand mergen (inkl. master-data-Dedup).",
  request: {
    params: z.object({ scanId: z.string().min(8).max(64) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            candidates: z.array(CandidateInputShape).min(1).max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: AddCandidatesResponseShape } },
      description: "Merge-Ergebnis",
    },
    404: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Scan unbekannt (oder fremder Tenant)",
    },
    409: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Kandidaten-Cap des Scans erschoepft",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

/** Dedup-Hook: Kandidaten fuzzy gegen master-data aufloesen (Dry-Run
 *  mit Mini-xlsx, Muster Excel-Import). Best-effort — liefert bei
 *  jedem Upstream-Problem eine leere Map, der Merge laeuft trotzdem. */
async function resolveMasterIds(
  c: Parameters<typeof callUpstreamBinaryExpectJson>[0],
  candidates: CandidateInput[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const rows = candidates.map((cand) => [cand.name, cand.city ?? ""]);
  if (rows.length === 0) return out;
  try {
    const xlsx = buildXlsx({ headers: ["company", "city"], rows });
    const { body } = await callUpstreamBinaryExpectJson(
      c,
      "masterData",
      "/api/v1/data-care",
      xlsx,
      {
        contentType: "application/octet-stream",
        query: {
          companyNameIdentifiers: "company",
          city: "city",
          isFuzzy: "true",
          dryRun: "true",
        },
      },
    );
    const preview = body as {
      matched?: Array<{ name: string; location: string; companyId: string }>;
    };
    const byKey = new Map<string, string>();
    for (const m of preview.matched ?? []) {
      byKey.set(
        `${m.name.trim().toLowerCase()}|${m.location.trim().toLowerCase()}`,
        m.companyId,
      );
    }
    for (const cand of candidates) {
      const key = `${cand.name.trim().toLowerCase()}|${(cand.city ?? "").trim().toLowerCase()}`;
      const companyId = byKey.get(key);
      const discoveryId = discoveryIdFor(cand);
      if (companyId && discoveryId) out.set(discoveryId, companyId);
    }
  } catch (err) {
    logger.warn({ err }, "discovery: master-data dedup dry-run failed (best-effort, skipping)");
  }
  return out;
}

discoveryRouter.openapi(addCandidatesRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { scanId } = c.req.valid("param");
  const { candidates } = c.req.valid("json");

  const masterIds = await resolveMasterIds(c, candidates);
  const result = await addCandidates(getGatewayPool(), {
    scanId,
    tenantId: auth.tenantId,
    candidates,
    masterIds,
  });
  if ("error" in result) {
    if (result.error === "scan_not_found") {
      throw new HTTPException(404, { message: "scan_not_found" });
    }
    throw new HTTPException(409, { message: "candidate_cap_exhausted" });
  }
  return c.json(result, 200);
});

// ---- PUT /discovery/candidates/{discoveryId}/profile -----------------------
//
// Phase 2: Mini-Profil + Embedding zentral ablegen. 6-Monats-Sperre
// (A9) wird HIER durchgesetzt, nicht nur im Client — sonst koennten
// sich parallel scannende Nutzer gegenseitig Crawl-/LLM-Kosten
// verursachen.

const SaveProfileResponseShape = z
  .object({
    saved: z.boolean(),
    skipped: z.string().optional(),
    profiledAt: z.string().optional(),
  })
  .openapi("DiscoverySaveProfileResponse");

const saveProfileRoute = createRoute({
  method: "put",
  path: "/discovery/candidates/{discoveryId}/profile",
  tags: ["discovery"],
  summary:
    "Mini-Profil (JSON + Text + Embedding) eines Kandidaten speichern. 6-Monats-Sperre serverseitig.",
  request: {
    params: z.object({ discoveryId: z.string().min(4).max(100) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            profileJson: z.record(z.string(), z.unknown()),
            profileText: z.string().min(20).max(20000),
            embedding: z.array(z.number()).min(8).max(4096).nullable(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { "application/json": { schema: SaveProfileResponseShape } },
      description: "gespeichert ODER wegen frischem Profil uebersprungen",
    },
    404: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Kandidat unbekannt",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(saveProfileRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { discoveryId } = c.req.valid("param");
  const { profileJson, profileText, embedding } = c.req.valid("json");
  const result = await saveProfile(getGatewayPool(), {
    discoveryId,
    profileJson,
    profileText,
    embedding,
  });
  if ("error" in result) {
    throw new HTTPException(404, { message: "candidate_not_found" });
  }
  if ("skipped" in result) {
    return c.json(
      { saved: false, skipped: result.skipped, profiledAt: result.profiledAt },
      200,
    );
  }
  return c.json({ saved: true }, 200);
});

// ---- GET /discovery/candidates ---------------------------------------------

const CandidateRowShape = z
  .object({
    discoveryId: z.string(),
    name: z.string(),
    city: z.string().nullable(),
    plz: z.string().nullable(),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    domain: z.string(),
    category: z.string().nullable(),
    source: z.string(),
    masterCompanyId: z.string().nullable(),
    profiledAt: z.string().nullable(),
    decision: z.string().nullable(),
  })
  .openapi("DiscoveryCandidate");

const listRoute = createRoute({
  method: "get",
  path: "/discovery/candidates",
  tags: ["discovery"],
  summary:
    "Discovery-Kandidaten lesen — optional auf einen Geo-Radius begrenzt, mit Entscheidung des Nutzers.",
  request: {
    query: z.object({
      lat: z.coerce.number().optional(),
      lon: z.coerce.number().optional(),
      radiusKm: z.coerce.number().min(1).max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
      /** Default false: entschiedene Kandidaten (importiert/verworfen)
       *  verschwinden aus der Liste (Zielbild Kandidaten-Tabelle). */
      includeDecided: z.coerce.boolean().default(false),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ candidates: z.array(CandidateRowShape) }),
        },
      },
      description: "Kandidatenliste, neueste zuerst",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(listRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { lat, lon, radiusKm, limit, includeDecided } = c.req.valid("query");
  const candidates = await listCandidates(getGatewayPool(), {
    userId: auth.actorId,
    lat,
    lon,
    radiusKm,
    limit,
    includeDecided,
  });
  return c.json({ candidates }, 200);
});
