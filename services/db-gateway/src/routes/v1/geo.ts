// Phase 0 Firmen-Discovery (PLAN_FIRMEN_DISCOVERY.md) — Geo-Routen.
//
// GET /v1/geo/places?near=<ort>&radiusKm=<n>
//
// Loest einen Ortsnamen gegen die GeoPlace-Tabelle auf (Seed aus dem
// GeoNames-Datensatz, siehe lib/geo-places.ts) und liefert alle
// (Ort, Kreis)-Gruppen im Haversine-Radius um den Zentroid — inklusive
// Distanz, PLZ-Liste und Bounding-Box (letztere als bbox-Input fuer
// Overpass-Abfragen in Phase 1).
//
// Pfad ist zweisegmentig-literal ("/geo/places") — kollidiert mit
// keinem {param}-Glob anderer Router (Routen-Kollisions-Lektion aus
// dem Verarbeitungs-Feed).

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { findPlacesNearby } from "../../lib/geo-places";
import { ErrorShape } from "./schemas";

export const geoRouter = new OpenAPIHono();

const PlaceShape = z
  .object({
    name: z.string(),
    kreis: z.string(),
    bundesland: z.string(),
    lat: z.number(),
    lon: z.number(),
    plz: z.array(z.string()),
    distanceKm: z.number(),
  })
  .openapi("GeoPlace");

const NearbyResponseShape = z
  .object({
    origin: PlaceShape.omit({ distanceKm: true }),
    /** Gleichnamige (Ort, Kreis)-Gruppen, die NICHT als Origin gewaehlt
     *  wurden (es gibt z. B. zwei "Minden"). */
    alternatives: z.array(
      z.object({ name: z.string(), kreis: z.string(), bundesland: z.string() }),
    ),
    radiusKm: z.number(),
    places: z.array(PlaceShape),
    bbox: z.object({
      minLat: z.number(),
      maxLat: z.number(),
      minLon: z.number(),
      maxLon: z.number(),
    }),
  })
  .openapi("GeoNearbyResponse");

const nearbyRoute = createRoute({
  method: "get",
  path: "/geo/places",
  tags: ["geo"],
  summary:
    "Orte im Umkreis eines Ortsnamens (Zentroid + Haversine-Radius). Fundament des Discovery-Ortsgraphen.",
  request: {
    query: z.object({
      near: z.string().min(2).max(80),
      radiusKm: z.coerce.number().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      content: { "application/json": { schema: NearbyResponseShape } },
      description: "Origin + Orte im Radius, nach Distanz sortiert",
    },
    404: {
      content: { "application/json": { schema: ErrorShape } },
      description: "Ortsname nicht aufloesbar",
    },
    401: {
      content: { "application/json": { schema: ErrorShape } },
      description: "unauthenticated",
    },
  },
});

geoRouter.openapi(nearbyRoute, async (c) => {
  const auth = c.get("auth");
  if (!auth?.tenantId) {
    throw new HTTPException(401, { message: "auth_context_missing" });
  }
  const { near, radiusKm } = c.req.valid("query");
  const result = await findPlacesNearby(getGatewayPool(), near, radiusKm);
  if (!result) {
    throw new HTTPException(404, {
      message: `Ort "${near}" nicht gefunden`,
    });
  }
  return c.json(result, 200);
});
