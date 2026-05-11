// Phase T3 — external-service reachability agent tools.
//
// Thin wrappers around the ExternalServiceMonitor instance owned by
// main/index.ts (same object the `external-service:*` IPC handlers
// call). The agent can answer "ist unternehmensregister gerade
// erreichbar?" / "prüf das mal jetzt" from chat without the user
// having to open the Diagnostics panel.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type {
  ExternalServiceMonitor,
  ExternalServiceId,
  ExternalServicesStatus,
} from "../../external-service-monitor";

export interface ReachabilityToolDeps {
  monitor: ExternalServiceMonitor;
}

const SERVICE_LABEL: Record<ExternalServiceId, string> = {
  unternehmensregister: "Unternehmensregister",
  handelsregister: "Handelsregister",
};

function summarise(status: ExternalServicesStatus): string {
  const parts: string[] = [];
  for (const id of Object.keys(status.services) as ExternalServiceId[]) {
    const s = status.services[id];
    const label = SERVICE_LABEL[id] ?? id;
    if (s.state === "reachable") parts.push(`${label} erreichbar`);
    else if (s.state === "unreachable") parts.push(`${label} nicht erreichbar`);
    else parts.push(`${label} unbekannt`);
  }
  return parts.join(", ");
}

export function buildReachabilityTools(deps: ReachabilityToolDeps): Tool[] {
  const { monitor } = deps;

  const statusTool = defineTool({
    name: "reachability_status",
    description:
      "Liefert den aktuellen Erreichbarkeits-Status der externen Quellen " +
      "(unternehmensregister.de, handelsregister.de). Pro Quelle Status " +
      "(reachable / unreachable / unknown), Zeitpunkt der letzten Prüfung, " +
      "Latenz und Fehlerursache. Nutze das Tool, wenn der Nutzer fragt, ob " +
      "eine der Quellen gerade erreichbar ist oder warum Producer hängen.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}).noUnknown(true),
    run: async () => {
      const status = monitor.getStatus();
      return {
        anyReachable: status.anyReachable,
        allReachable: status.allReachable,
        services: Object.fromEntries(
          (Object.keys(status.services) as ExternalServiceId[]).map((id) => {
            const s = status.services[id];
            return [
              id,
              {
                state: s.state,
                url: s.url,
                lastCheckedAt: s.lastCheckedAt
                  ? new Date(s.lastCheckedAt).toISOString()
                  : null,
                lastReachableAt: s.lastReachableAt
                  ? new Date(s.lastReachableAt).toISOString()
                  : null,
                latencyMs: s.latencyMs,
                consecutiveFailures: s.consecutiveFailures,
                errorMessage: s.errorMessage,
              },
            ];
          }),
        ),
      };
    },
    preview: (r) => {
      // Reconstruct a compact summary from the serialised shape.
      const labels: string[] = [];
      for (const [id, s] of Object.entries(r.services) as Array<
        [string, { state: string }]
      >) {
        const label = SERVICE_LABEL[id as ExternalServiceId] ?? id;
        if (s.state === "reachable") labels.push(`${label} OK`);
        else if (s.state === "unreachable") labels.push(`${label} down`);
        else labels.push(`${label} unbekannt`);
      }
      return labels.join(", ") || "keine Daten";
    },
  });

  const probeNowTool = defineTool({
    name: "reachability_probe_now",
    description:
      "Erzwingt sofort eine neue HEAD-Probe gegen alle externen Quellen " +
      "(unternehmensregister.de, handelsregister.de) und liefert den " +
      "aktualisierten Status zurück. Nutze das Tool, wenn der Nutzer „prüf " +
      "jetzt mal nach“ verlangt oder wissen will, ob ein zuvor gemeldeter " +
      "Ausfall vorbei ist. Eine Probe kann bis zu 120 s dauern.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}).noUnknown(true),
    run: async () => {
      const status = await monitor.probeNow();
      return {
        anyReachable: status.anyReachable,
        allReachable: status.allReachable,
        summary: summarise(status),
        services: Object.fromEntries(
          (Object.keys(status.services) as ExternalServiceId[]).map((id) => {
            const s = status.services[id];
            return [
              id,
              {
                state: s.state,
                latencyMs: s.latencyMs,
                errorMessage: s.errorMessage,
                lastCheckedAt: s.lastCheckedAt
                  ? new Date(s.lastCheckedAt).toISOString()
                  : null,
              },
            ];
          }),
        ),
      };
    },
    preview: (r) => `Probe abgeschlossen: ${r.summary}`,
  });

  return [statusTool, probeNowTool];
}
