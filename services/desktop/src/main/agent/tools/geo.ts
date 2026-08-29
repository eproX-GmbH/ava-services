// Phase 0 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Geo-Tool.
//
// Duenner Wrapper um GET /v1/geo/places im Gateway: loest einen
// Ortsnamen auf und liefert Nachbarorte im Radius (Zentroid +
// Haversine, GeoNames-Seed). Smoke-Test des Ortsgraphen und spaeter
// Baustein des Discovery-Scans ("Welche Orte deckt mein Radius ab?").

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

interface GeoPlaceEntry {
  name: string;
  kreis: string;
  bundesland: string;
  lat: number;
  lon: number;
  plz: string[];
  distanceKm: number;
}

interface NearbyResponse {
  origin: Omit<GeoPlaceEntry, "distanceKm">;
  alternatives: Array<{ name: string; kreis: string; bundesland: string }>;
  radiusKm: number;
  places: GeoPlaceEntry[];
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

export interface GeoToolDeps {
  gateway: GatewayClient;
}

export function buildGeoTools(deps: GeoToolDeps): Tool[] {
  const nearby = defineTool({
    name: "geo_places_nearby",
    description:
      "Deutsche Orte im Umkreis eines Ortsnamens finden (Luftlinie ab " +
      "Orts-Zentroid). Liefert Nachbarorte mit Distanz, Kreis, Bundesland " +
      "und PLZ-Liste — z. B. fuer die Frage, welche Region eine " +
      "Firmen-Discovery um einen Standort abdecken wuerde. Bei " +
      "mehrdeutigen Ortsnamen gewinnt die groesste Stadt; Alternativen " +
      "werden mitgeliefert.",
    parameters: {
      type: "object",
      required: ["ort"],
      properties: {
        ort: {
          type: "string",
          description: "Ortsname, z. B. 'Hannover' oder 'Bad Oeynhausen'.",
        },
        radiusKm: {
          type: "integer",
          description: "Umkreis in km (Default 50, max 200).",
        },
      },
    },
    schema: yup.object({
      ort: yup.string().trim().min(2).max(80).required(),
      radiusKm: yup.number().integer().min(1).max(200).optional(),
    }),
    preview: (r) => {
      const res = r as { origin?: { name: string }; orteImRadius?: number; error?: string };
      if (res.error) return res.error;
      return `${res.orteImRadius ?? 0} Orte im Umkreis von ${res.origin?.name ?? "?"}`;
    },
    run: async (args) => {
      const radiusKm = args.radiusKm ?? 50;
      const qs = new URLSearchParams({
        near: args.ort,
        radiusKm: String(radiusKm),
      });
      let r: NearbyResponse;
      try {
        r = await deps.gateway.request<NearbyResponse>(
          `/v1/geo/places?${qs.toString()}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404")) {
          return {
            error: `Ort "${args.ort}" wurde nicht gefunden. Schreibweise pruefen oder groesseren bekannten Nachbarort verwenden.`,
          };
        }
        throw err;
      }
      // Kompakte Antwort: das LLM braucht keine Koordinaten pro Ort und
      // keine vollen PLZ-Listen — Distanz + Verwaltungszuordnung reichen.
      return {
        origin: {
          name: r.origin.name,
          kreis: r.origin.kreis,
          bundesland: r.origin.bundesland,
          plzAnzahl: r.origin.plz.length,
        },
        mehrdeutig: r.alternatives.length > 0 ? r.alternatives : undefined,
        radiusKm: r.radiusKm,
        orteImRadius: r.places.length,
        orte: r.places.slice(0, 80).map((p) => ({
          name: p.name,
          kreis: p.kreis,
          distanceKm: p.distanceKm,
        })),
        hinweis:
          r.places.length > 80
            ? `Nur die 80 naechsten von ${r.places.length} Orten gelistet.`
            : undefined,
      };
    },
  });

  return [nearby];
}
