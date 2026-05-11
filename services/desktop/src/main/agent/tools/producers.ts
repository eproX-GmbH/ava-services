// Phase T3 — producer-supervisor agent tools.
//
// Thin wrappers around the producer supervisors + log buffer owned by
// main/index.ts (same objects the `producers:*` IPC handlers call).
// The agent answers diagnostic questions like "warum hängt
// structured-content?" or "läuft company-profile gerade?" without the
// user having to open the Settings panel.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { ProducerSupervisor } from "../../producer-supervisor";
import type { ProducerLogLine } from "../../../shared/types";

export interface ProducerToolDeps {
  producers: ProducerSupervisor[];
  /** Same buffer the `producers:logs:tail` IPC handler reads from. */
  logBuffer: { tail: (producer: string, limit?: number) => ProducerLogLine[] };
}

export function buildProducerTools(deps: ProducerToolDeps): Tool[] {
  const { producers, logBuffer } = deps;

  const statusTool = defineTool({
    name: "producers_status",
    description:
      "Liefert den Status aller lokal laufenden Producer (z. B. company-profile, " +
      "structured-content, company-publication, master-data). Pro Producer: " +
      "Name, Zustand (idle / migrating / starting / ready / error / stopping / " +
      "not_installed), TCP-Port, PID, letzte Fehlermeldung. Nutze das Tool, " +
      "wenn der Nutzer fragt, ob ein Producer läuft oder warum eine " +
      "Verarbeitungs-Stage hängt.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}).noUnknown(true),
    run: async () => {
      const list = producers.map((p) => p.getStatus());
      const ready = list.filter((p) => p.state === "ready").length;
      const errored = list.filter((p) => p.state === "error").length;
      const notInstalled = list.filter((p) => p.state === "not_installed").length;
      return {
        count: list.length,
        ready,
        errored,
        notInstalled,
        producers: list,
      };
    },
    preview: (r) => {
      const parts = [`${r.ready}/${r.count} bereit`];
      if (r.errored > 0) parts.push(`${r.errored} Fehler`);
      if (r.notInstalled > 0) parts.push(`${r.notInstalled} nicht installiert`);
      return parts.join(", ");
    },
  });

  const logsTool = defineTool({
    name: "producers_logs_tail",
    description:
      "Liest die jüngsten Logzeilen eines Producers aus dem Ring-Puffer. " +
      "Nutze das Tool, wenn der Nutzer den Grund für einen Fehlerzustand " +
      "sehen will (z. B. „was sagt structured-content?“). Liefert eine " +
      "begrenzte Anzahl Zeilen mit Zeitstempel und stdout/stderr-Kanal.",
    parameters: {
      type: "object",
      required: ["producer"],
      properties: {
        producer: {
          type: "string",
          description:
            "Producer-Name, z. B. `structured-content`, `company-profile`, " +
            "`company-publication`, `master-data`.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximale Anzahl Zeilen. Default 100.",
        },
      },
    },
    schema: yup
      .object({
        producer: yup.string().required(),
        limit: yup.number().integer().min(1).max(500).optional(),
      })
      .noUnknown(true),
    run: async (args) => {
      const limit = args.limit ?? 100;
      const known = producers.map((p) => p.getStatus().name);
      if (!known.includes(args.producer)) {
        return {
          ok: false as const,
          error:
            `Unbekannter Producer „${args.producer}“. Bekannte Producer: ` +
            (known.join(", ") || "keine"),
          producer: args.producer,
          lines: [] as Array<{
            ts: string;
            stream: "stdout" | "stderr";
            text: string;
          }>,
        };
      }
      const lines = logBuffer.tail(args.producer, limit);
      return {
        ok: true as const,
        producer: args.producer,
        count: lines.length,
        lines: lines.map((l) => ({
          ts: new Date(l.ts).toISOString(),
          stream: l.stream,
          text: l.text,
        })),
      };
    },
    preview: (r) =>
      r.ok
        ? `${r.count} Zeile(n) aus ${r.producer}`
        : `Logs nicht verfügbar: ${r.error}`,
  });

  return [statusTool, logsTool];
}
