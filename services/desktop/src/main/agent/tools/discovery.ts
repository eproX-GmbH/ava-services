// Phase 1 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Agent-Tools.
//
// discovery_scan          — Scan im Umkreis eines Orts starten (OSM +
//                           valueserp), Ergebnis landet im geteilten
//                           zentralen Kandidaten-Bestand.
// discovery_candidates    — Kandidaten aus dem Bestand lesen (Radius).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { LlmProviderManager } from "../providers";
import type { Tool } from "../types";
import { runDiscoveryScan } from "../../discovery/scan";
import { runProfiler } from "../../discovery/profiler";
import { runMatch } from "../../discovery/matcher";
import { decideCandidates } from "../../discovery/decide";
import { listCandidatesWithMatches } from "../../discovery/list";
import type { IcpStore } from "../icp-store";
import type { MatchStore } from "../../discovery/match-store";
import type { CustomerProfileStore } from "../../discovery/customer-profiles";
import type { RadarAlertEmitter } from "../../discovery/radar-alerts";

export interface DiscoveryToolDeps {
  gateway: GatewayClient;
  providers: LlmProviderManager;
  icp: IcpStore;
  matchStore: MatchStore;
  customerStore: CustomerProfileStore;
  /** Lazy — der Emitter entsteht erst im App-Boot nach dem Registry-Build. */
  getRadarAlerts: () => RadarAlertEmitter | null;
  /** Branchen-Fallback aus dem Nutzerprofil (UserProfile.industries). */
  getDefaultIndustries: () => string[];
  /** Audit-Trail — Scans (inkl. der geplanten SERP-Queries) sollen
   *  nachvollziehbar sein. */
  onAudit: (entry: {
    action: string;
    severity: "info" | "warning" | "error";
    summary: string;
    metadata: Record<string, unknown>;
  }) => void;
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
      const result = await runDiscoveryScan(deps.gateway, deps.providers, {
        ort: args.ort,
        radiusKm: args.radiusKm ?? 30,
        branchen,
        ...(deps.icp.isSet() ? { icpText: deps.icp.renderText() } : {}),
      });
      if (!("error" in result)) {
        deps.onAudit({
          action: "discovery.scan",
          severity: "info",
          summary:
            `Radar-Scan ${args.ort} (${args.radiusKm ?? 30} km): ` +
            `${result.kandidatenGesamt} Kandidaten — SERP-Recherche ` +
            `(${result.queryPlanung}): ${result.serpQueries.join(" | ") || "—"}`,
          metadata: {
            scanId: result.scanId,
            queryPlanung: result.queryPlanung,
            serpQueries: result.serpQueries,
            quellen: result.quellen,
            hinweise: result.hinweise,
          },
        });
      }
      return result;
    },
  });

  const list = defineTool({
    name: "discovery_candidates",
    summary:
      "Discovery-Kandidaten aus dem zentralen Bestand lesen (optional Geo-Radius) — inkl. bereits-bekannt-Markierung.",
    category: "discovery neue firmen kandidaten",
    description:
      "Liest die OFFENEN Firmen-Kandidaten aus dem Discovery-Bestand, " +
      "sortiert nach ICP-Match-Score (heisseste zuerst, inkl. Warum-" +
      "Begruendung, falls discovery_match_run gelaufen ist). " +
      "bereitsInAva = Firma ist schon im Bestand; profiliert = " +
      "Mini-Profil vorhanden.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max Ergebnisse (Default 50, max 200)." },
      },
    },
    schema: yup.object({
      limit: yup.number().integer().min(1).max(200).optional(),
    }),
    preview: (r) => {
      const res = r as { candidates?: unknown[] };
      return `${res.candidates?.length ?? 0} Kandidaten`;
    },
    run: async (args) => {
      const rows = await listCandidatesWithMatches(
        deps.gateway,
        deps.matchStore,
        { limit: args.limit ?? 50 },
      );
      return {
        hinweis:
          "Nur offene Kandidaten (importierte/verworfene ausgeblendet), sortiert nach ICP-Match-Score.",
        candidates: rows,
      };
    },
  });

  const profile = defineTool({
    name: "discovery_profile_run",
    summary:
      "Mini-Profile fuer offene Discovery-Kandidaten erstellen (Website-Kurzcrawl + LLM + Embedding, zentral geteilt).",
    category: "discovery profil firmenprofil",
    description:
      "Erstellt fuer bis zu N offene Discovery-Kandidaten ein kompaktes " +
      "Firmen-Kurzprofil: Website kurz crawlen (Startseite + Impressum/" +
      "Leistungen, robots.txt respektiert), Profil per LLM (nutzt das " +
      "guenstige Producer-Modell, falls konfiguriert), Embedding lokal, " +
      "zentrale Ablage — einer verarbeitet, alle profitieren. Firmen mit " +
      "Profil juenger als 6 Monate werden uebersprungen. Dauert grob " +
      "10-20 Sekunden pro Firma; Default 10 Firmen pro Lauf.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Wie viele Kandidaten dieser Lauf verarbeitet (Default 10, max 25).",
        },
      },
    },
    schema: yup.object({
      limit: yup.number().integer().min(1).max(25).optional(),
    }),
    preview: (r) => {
      const res = r as { error?: string; profiliert?: number; betrachtet?: number };
      if (res.error) return res.error;
      return `${res.profiliert ?? 0}/${res.betrachtet ?? 0} Profile erstellt`;
    },
    run: async (args) =>
      runProfiler(deps.gateway, deps.providers, {
        limit: args.limit ?? 10,
        // ICP-Branchen zuerst profilieren — echte Treffer vor Absagen.
        prioritizeTerms: deps.icp.get().branchen,
      }),
  });

  const match = defineTool({
    name: "discovery_match_run",
    summary:
      "Profilierte Discovery-Kandidaten gegen das ICP matchen — Score 0-100 + Warum-Begruendung pro Firma.",
    category: "discovery icp match radar",
    description:
      "Matcht die profilierten offenen Kandidaten gegen das Idealkunden-" +
      "profil des Nutzers: lokales Embedding-Vorranking, dann LLM-Urteil " +
      "(guenstiges Producer-Modell) mit Score 0-100 und einem Satz, WARUM " +
      "die Firma (nicht) passt. Ergebnisse landen lokal und sortieren die " +
      "Kandidaten-Tabelle. Braucht ein gesetztes ICP (icp_set) und " +
      "profilierte Kandidaten (discovery_profile_run).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    preview: (r) => {
      const res = r as { error?: string; bewertet?: number };
      if (res.error) return res.error;
      return `${res.bewertet ?? 0} Kandidaten bewertet`;
    },
    run: async () => {
      const result = await runMatch(
        deps.gateway,
        deps.providers,
        deps.icp,
        deps.matchStore,
        deps.customerStore,
      );
      // Heisse Treffer melden (Glocke/Push/Telegram) — alle Match-Pfade
      // laufen durch denselben Emitter (Dedup inklusive).
      if (!("error" in result)) {
        const emitted = deps.getRadarAlerts()?.emit(result.ergebnisse);
        if (emitted && (emitted.neu > 0 || emitted.bereitsGemeldet > 0)) {
          result.hinweise.push(
            `${emitted.neu} neue heisse Treffer gemeldet` +
              (emitted.bereitsGemeldet > 0
                ? ` (${emitted.bereitsGemeldet} bereits frueher gemeldet)`
                : "") +
              ".",
          );
        }
      }
      return result;
    },
  });

  const decide = defineTool({
    name: "discovery_decide",
    summary:
      "Discovery-Kandidaten importieren (volle Verarbeitung) oder ignorieren — NUR auf explizite Nutzer-Anweisung.",
    category: "discovery import ignorieren",
    description:
      "Speichert Entscheidungen zu Kandidaten: 'imported' startet EINEN " +
      "Bulk-Import (eine Transaktion, volle Pipeline) fuer alle gewaehlten " +
      "Firmen; 'dismissed' blendet sie dauerhaft aus. Entschiedene Firmen " +
      "verschwinden aus der Kandidatenliste. WICHTIG: Nur aufrufen, wenn " +
      "der Nutzer die Entscheidung explizit getroffen hat — nie " +
      "eigenmaechtig importieren. Import braucht einen Ort; Firmen ohne " +
      "Ort werden gemeldet.",
    parameters: {
      type: "object",
      required: ["decisions"],
      properties: {
        decisions: {
          type: "array",
          items: {
            type: "object",
            required: ["discoveryId", "decision"],
            properties: {
              discoveryId: { type: "string" },
              decision: { type: "string", enum: ["imported", "dismissed"] },
              reason: { type: "string", description: "Optional, z. B. Verwerf-Grund." },
            },
          },
        },
      },
    },
    schema: yup.object({
      decisions: yup
        .array()
        .of(
          yup.object({
            discoveryId: yup.string().trim().min(4).max(100).required(),
            decision: yup.string().oneOf(["imported", "dismissed"]).required(),
            reason: yup.string().trim().max(500).optional(),
          }),
        )
        .min(1)
        .max(200)
        .required(),
    }),
    preview: (r) => {
      const res = r as { error?: string; importiert?: number; ignoriert?: number };
      if (res.error) return res.error;
      return `${res.importiert ?? 0} importiert, ${res.ignoriert ?? 0} ignoriert`;
    },
    run: async (args) =>
      decideCandidates(
        deps.gateway,
        args.decisions.map((d) => ({
          discoveryId: d.discoveryId,
          decision: d.decision as "imported" | "dismissed",
          reason: d.reason ?? null,
        })),
      ),
  });

  return [scan, list, profile, match, decide];
}
