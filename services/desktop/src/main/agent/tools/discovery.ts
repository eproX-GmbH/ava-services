// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Agent-Tools.
//
// discovery_scan          — Scan im Umkreis eines Orts starten (OSM +
//                           valueserp), Ergebnis landet im geteilten
//                           zentralen Kandidaten-Bestand.
// discovery_candidates    — Kandidaten aus dem Bestand lesen (Radius).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";
import { runDiscoveryScan } from "../../discovery/scan";

export interface DiscoveryToolDeps {
  gateway: GatewayClient;
  /** Branchen-Fallback aus dem Nutzerprofil (UserProfile.industries). */
  getDefaultIndustries: () => string[];
}

export function buildDiscoveryTools(deps: DiscoveryToolDeps): Tool[] {
  const scan = defineTool({
    name: "discovery_scan",
    summary:
      "NEUE Firmen im Umkreis eines Orts entdecken (noch nicht in AVA/CRM) — OSM + Google-Places-Scan, Ergebnis im zentralen Kandidaten-Bestand.",
    category: "discovery neue firmen umkreis radar akquise",
    description:
      "Startet einen Discovery-Scan: findet Firmen im Umkreis eines Orts, " +
      "die noch NICHT in AVA importiert sind (Quellen: OpenStreetMap-" +
      "Gewerbeeintraege + Google-Places-Suche pro Branchenbegriff). " +
      "Kandidaten landen im geteilten zentralen Bestand; bereits bekannte " +
      "Firmen werden automatisch markiert. Dauert 30-90 Sekunden. " +
      "Branchenbegriffe verbessern das Ergebnis deutlich — ohne Angabe " +
      "werden die Branchen aus dem Nutzerprofil verwendet. Tageslimit " +
      "pro Konto beachten (Fehlermeldung nennt es).",
    parameters: {
      type: "object",
      required: ["ort"],
      properties: {
        ort: {
          type: "string",
          description: "Ortsname als Zentrum, z. B. 'Hannover'.",
        },
        radiusKm: {
          type: "integer",
          description: "Umkreis in km (Default 30, max 100).",
        },
        branchen: {
          type: "array",
          items: { type: "string" },
          description:
            "Branchenbegriffe fuer die Places-Suche, z. B. ['IT-Dienstleister', 'Maschinenbau']. Max 8.",
        },
      },
    },
    schema: yup.object({
      ort: yup.string().trim().min(2).max(80).required(),
      radiusKm: yup.number().integer().min(1).max(100).optional(),
      branchen: yup
        .array()
        .of(yup.string().trim().min(2).max(60).required())
        .max(8)
        .optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; kandidatenGesamt?: number; added?: number };
      if (res.error) return res.error;
      return `${res.kandidatenGesamt ?? 0} Kandidaten (${res.added ?? 0} neu)`;
    },
    run: async (args) => {
      const branchen =
        args.branchen && args.branchen.length > 0
          ? args.branchen
          : deps.getDefaultIndustries();
      return runDiscoveryScan(deps.gateway, {
        ort: args.ort,
        radiusKm: args.radiusKm ?? 30,
        branchen,
      });
    },
  });

  const list = defineTool({
    name: "discovery_candidates",
    summary:
      "Discovery-Kandidaten aus dem zentralen Bestand lesen (optional Geo-Radius) — inkl. bereits-bekannt-Markierung.",
    category: "discovery neue firmen kandidaten",
    description:
      "Liest Firmen-Kandidaten aus dem zentralen Discovery-Bestand — " +
      "optional begrenzt auf einen Umkreis (lat/lon/radiusKm, z. B. aus " +
      "geo_places_nearby-Origin). masterCompanyId gesetzt = Firma ist in " +
      "AVA schon bekannt; decision zeigt eine fruehere Nutzer-Entscheidung " +
      "(imported/dismissed).",
    parameters: {
      type: "object",
      properties: {
        lat: { type: "number" },
        lon: { type: "number" },
        radiusKm: { type: "integer", description: "Nur mit lat+lon sinnvoll." },
        limit: { type: "integer", description: "Max Ergebnisse (Default 50, max 200)." },
      },
    },
    schema: yup.object({
      lat: yup.number().min(-90).max(90).optional(),
      lon: yup.number().min(-180).max(180).optional(),
      radiusKm: yup.number().integer().min(1).max(200).optional(),
      limit: yup.number().integer().min(1).max(200).optional(),
    }),
    preview: (r) => {
      const res = r as { candidates?: unknown[] };
      return `${res.candidates?.length ?? 0} Kandidaten`;
    },
    run: async (args) => {
      const qs = new URLSearchParams({ limit: String(args.limit ?? 50) });
      if (args.lat !== undefined && args.lon !== undefined && args.radiusKm) {
        qs.set("lat", String(args.lat));
        qs.set("lon", String(args.lon));
        qs.set("radiusKm", String(args.radiusKm));
      }
      const r = await deps.gateway.request<{
        candidates: Array<{
          discoveryId: string;
          name: string;
          city: string | null;
          plz: string | null;
          domain: string;
          category: string | null;
          source: string;
          masterCompanyId: string | null;
          decision: string | null;
        }>;
      }>(`/v1/discovery/candidates?${qs.toString()}`);
      return {
        hinweis:
          "Nur offene Kandidaten (bereits importierte/verworfene sind ausgeblendet).",
        candidates: r.candidates.map((c) => ({
          discoveryId: c.discoveryId,
          name: c.name,
          ort: c.city,
          plz: c.plz,
          website: c.domain,
          kategorie: c.category,
          quelle: c.source,
          bereitsInAva: c.masterCompanyId !== null,
        })),
      };
    },
  });

  return [scan, list];
}
