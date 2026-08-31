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
  addDirectCandidates,
  startScan,
  saveProfile,
  saveDecisions,
  clearDecisions,
  findRegisterCandidates,
  listDismissedWithReasons,
  discoveryIdFor,
  type CandidateInput,
} from "../../lib/discovery";
import { findPlacesNearby } from "../../lib/geo-places";
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
    /** v0.1.466 — SERP-Calls, die der Desktop fuer diesen Scan
     *  ausgeben darf (Plan-Staffelung; Erst-Scan = Pro-Level). */
    serpBudget: z.number(),
    tier: z.string(),
    isInitial: z.boolean(),
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
            radiusKm: z.number().int().min(1).max(250),
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
      description: "Scan-Quota des Plans erschoepft",
    },
    400: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Radius oder Gebiete-Limit des Plans ueberschritten",
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
    const l = result.limits;
    if (result.reason === "radius") {
      throw new HTTPException(400, {
        message: `RADIUS_LIMIT: Der ${l.tier}-Plan erlaubt maximal ${l.maxRadiusKm} km Radius.`,
      });
    }
    if (result.reason === "gebiete") {
      throw new HTTPException(400, {
        message: `GEBIETE_LIMIT: Der ${l.tier}-Plan erlaubt ${l.maxGebiete} verschiedene(s) Suchgebiet(e) pro Woche.`,
      });
    }
    const fenster = l.windowDays === 1 ? "heute" : `in ${l.windowDays} Tagen`;
    throw new HTTPException(429, {
      message: `SCAN_QUOTA: Scan-Limit des ${l.tier}-Plans erreicht (${result.scansUsedInWindow}/${l.maxScansPerWindow} ${fenster}).`,
    });
  }
  return c.json(
    {
      scanId: result.scanId,
      maxCandidatesPerScan: result.maxCandidatesPerScan,
      serpBudget: result.serpBudget,
      tier: result.limits.tier,
      isInitial: result.isInitial,
      maxScansPerDay: result.limits.maxScansPerWindow,
      scansUsedToday: result.scansUsedInWindow,
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
  masterCompanyId: z.string().max(100).nullish(),
  source: z.enum(["osm", "serp", "register", "personen-radar"]),
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

// ---- POST /v1/discovery/candidates/direct ----------------------------------
//
// v0.1.480 — Personen-Radar (§8): Kandidaten aus dem Engagement-
// Trichter OHNE Orts-Scan einspeisen. Eigener Tages-Deckel
// (DISCOVERY_DIRECT_DAILY_CAP, Default 50), unabhaengig von der
// Scan-Quota; danach normaler Trichter (Profiler/Match/Import).

const directCandidatesRoute = createRoute({
  method: "post",
  path: "/discovery/candidates/direct",
  tags: ["discovery"],
  summary: "Kandidaten direkt einspeisen (Personen-Radar, eigener Tages-Deckel)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            source: z.string().min(2).max(120),
            candidates: z.array(CandidateInputShape).min(1).max(25),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            added: z.number(),
            updated: z.number(),
            capped: z.number(),
            known: z.record(z.string(), z.string()),
          }),
        },
      },
      description: "eingespeist",
    },
    429: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Direkt-Tages-Deckel erschoepft",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(directCandidatesRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { source, candidates } = c.req.valid("json");
  const masterIds = await resolveMasterIds(c, candidates);
  const result = await addDirectCandidates(getGatewayPool(), {
    tenantId: auth.tenantId,
    actorId: auth.actorId,
    source,
    candidates,
    masterIds,
  });
  if ("error" in result) {
    throw new HTTPException(429, {
      message: "DIRECT_CAP: Tages-Deckel fuer Direkt-Kandidaten erreicht.",
    });
  }
  return c.json(
    {
      added: result.added,
      updated: result.updated,
      capped: result.capped,
      known: result.known,
    },
    200,
  );
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
    profileJson: z.record(z.string(), z.unknown()).nullable().optional(),
    profileText: z.string().nullable().optional(),
    embedding: z.array(z.number()).nullable().optional(),
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
      /** Profil-Text + Embedding mitliefern (nur profilierte Kandidaten;
       *  fuer den lokalen ICP-Match — Muster publication-blocks). */
      withProfiles: z.coerce.boolean().default(false),
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
  const { lat, lon, radiusKm, limit, includeDecided, withProfiles } =
    c.req.valid("query");
  const candidates = await listCandidates(getGatewayPool(), {
    userId: auth.actorId,
    lat,
    lon,
    radiusKm,
    limit,
    includeDecided,
    withProfiles,
  });
  return c.json({ candidates }, 200);
});

// ---- GET /discovery/register-candidates ------------------------------------
//
// Phase 4, Kanal 3 (O5/A6-Nachfolger): Firmen aus dem globalen
// master-data-Register-Bestand, deren Sitzort im Radius liegt und die
// weder als Radar-Kandidat existieren noch je in AVA verarbeitet
// wurden. Der Desktop ermittelt anschliessend die Website (A8) und
// meldet sie als normale Kandidaten (source=register) zurueck.

const registerCandidatesRoute = createRoute({
  method: "get",
  path: "/discovery/register-candidates",
  tags: ["discovery"],
  summary:
    "Unverarbeitete Register-Firmen (GermanCompany) mit Sitzort im Radius um einen Ort.",
  request: {
    query: z.object({
      near: z.string().min(2).max(80),
      radiusKm: z.coerce.number().min(1).max(200).default(30),
      limit: z.coerce.number().int().min(1).max(50).default(15),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              candidates: z.array(
                z.object({
                  companyId: z.string(),
                  name: z.string(),
                  location: z.string(),
                }),
              ),
            })
            .openapi("DiscoveryRegisterCandidatesResponse"),
        },
      },
      description: "Register-Firmen ohne Radar-/AVA-Historie",
    },
    404: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Ort nicht aufloesbar",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(registerCandidatesRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { near, radiusKm, limit } = c.req.valid("query");
  const pool = getGatewayPool();
  const geo = await findPlacesNearby(pool, near, radiusKm);
  if (!geo) {
    throw new HTTPException(404, { message: `Ort "${near}" nicht gefunden` });
  }
  const candidates = await findRegisterCandidates(
    pool,
    geo.places.map((p) => p.name),
    limit,
  );
  return c.json({ candidates }, 200);
});

// ---- GET /discovery/dismissals ---------------------------------------------
//
// Phase 4 Feedback-Loop: juengste Verwerf-Gruende des Nutzers — der
// lokale Matcher webt sie als Praeferenzen in den Urteils-Prompt.

const dismissalsRoute = createRoute({
  method: "get",
  path: "/discovery/dismissals",
  tags: ["discovery"],
  summary: "Juengste Verwerf-Entscheidungen MIT Grund (Feedback fuer den Match).",
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(50).default(10),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({
              dismissals: z.array(
                z.object({
                  discoveryId: z.string(),
                  name: z.string(),
                  reason: z.string(),
                  decidedAt: z.string(),
                }),
              ),
            })
            .openapi("DiscoveryDismissalsResponse"),
        },
      },
      description: "Verwerf-Gruende, neueste zuerst",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(dismissalsRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { limit } = c.req.valid("query");
  const dismissals = await listDismissedWithReasons(
    getGatewayPool(),
    auth.actorId,
    limit,
  );
  return c.json({ dismissals }, 200);
});

// ---- POST /discovery/decisions ---------------------------------------------
//
// Phase 3: Nutzer-Entscheidungen (Bulk aus der Kandidaten-Tabelle):
// imported | dismissed. Nutzerbezogen (actorId) — die Firma bleibt im
// geteilten Bestand, verschwindet aber aus der Liste dieses Nutzers.
// Der eigentliche Import laeuft separat ueber POST /v1/imports/from-list.

const decisionsRoute = createRoute({
  method: "post",
  path: "/discovery/decisions",
  tags: ["discovery"],
  summary:
    "Bulk-Entscheidungen zu Kandidaten speichern (imported/dismissed, pro Nutzer).",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            decisions: z
              .array(
                z.object({
                  discoveryId: z.string().min(4).max(100),
                  decision: z.enum(["imported", "dismissed"]),
                  reason: z.string().max(500).nullish(),
                }),
              )
              .min(1)
              .max(200),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ saved: z.number() }).openapi("DiscoveryDecisionsResponse"),
        },
      },
      description: "Anzahl gespeicherter Entscheidungen",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

// ---- DELETE /discovery/decisions -------------------------------------------
//
// Werksreset-Begleiter: loescht ALLE Entscheidungen des Nutzers, damit
// ignorierte/importierte Firmen nach einem Reset wieder als offene
// Kandidaten erscheinen. Nur die eigenen Zeilen (actorId).

const clearDecisionsRoute = createRoute({
  method: "delete",
  path: "/discovery/decisions",
  tags: ["discovery"],
  summary: "Alle eigenen Kandidaten-Entscheidungen loeschen (Werksreset).",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z
            .object({ deleted: z.number() })
            .openapi("DiscoveryClearDecisionsResponse"),
        },
      },
      description: "Anzahl geloeschter Entscheidungen",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

discoveryRouter.openapi(clearDecisionsRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const result = await clearDecisions(getGatewayPool(), auth.actorId);
  return c.json(result, 200);
});

discoveryRouter.openapi(decisionsRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { decisions } = c.req.valid("json");
  const result = await saveDecisions(getGatewayPool(), {
    userId: auth.actorId,
    decisions: decisions.map((d) => ({
      discoveryId: d.discoveryId,
      decision: d.decision,
      reason: d.reason ?? null,
    })),
  });
  return c.json(result, 200);
});
