// Phase T2 — Ollama agent tools.
//
// Thin wrappers around the OllamaSupervisor instance owned by
// main/index.ts (same object the `ollama:*` IPC handlers call). The
// agent can drive local LLM management from chat: report status, pull
// a model, restart the daemon, delete a model.
//
// `pullModel` on the supervisor returns once the pull is done (it
// streams progress events to the renderer in the meantime). For the
// agent surface we kick it off without awaiting completion so the chat
// turn does not block on a multi-gigabyte download. The caller can poll
// `ollama_status` to watch progress.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { OllamaSupervisor } from "../../ollama-supervisor";

export interface OllamaToolDeps {
  ollama: OllamaSupervisor;
}

export function buildOllamaTools(deps: OllamaToolDeps): Tool[] {
  const { ollama } = deps;

  const statusTool = defineTool({
    name: "ollama_status",
    description:
      "Liefert den Status des lokalen Ollama-Daemons: Zustand (idle / starting / ready / error), " +
      "installierte Modelle und fehlende Pflichtmodelle. Nutze das Tool, wenn der Nutzer fragt, " +
      "ob Ollama läuft, welche Modelle vorhanden sind oder warum die KI-Antworten ausbleiben.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const s = ollama.getStatus();
      return {
        running: s.state === "ready",
        state: s.state,
        host: s.host,
        installedModels: s.installed.map((m) => m.name),
        requiredModels: [...s.required],
        missingModels: [...s.missing],
        errorMessage: s.errorMessage,
      };
    },
    preview: (r) => {
      if (!r.running) {
        return `Ollama ${r.state}${r.errorMessage ? `: ${r.errorMessage}` : ""}`;
      }
      return `Ollama bereit, ${r.installedModels.length} Modell(e) installiert`;
    },
  });

  const pullTool = defineTool({
    name: "ollama_pull_model",
    description:
      "Lädt ein Ollama-Modell anhand seines Namens herunter (z. B. `qwen2.5:7b`, `llama3.2:3b`). " +
      "Der Download läuft asynchron im Hintergrund weiter, das Tool kehrt sofort zurück, sobald " +
      "der Transfer gestartet ist. Nutze danach `ollama_status`, um den Fortschritt zu prüfen. " +
      "Setzt voraus, dass der Ollama-Daemon bereit ist.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Modellname inklusive Tag, z. B. `qwen2.5:7b`.",
        },
      },
      required: ["model"],
    },
    schema: yup.object({
      model: yup.string().trim().min(1).required(),
    }),
    run: async (args) => {
      const status = ollama.getStatus();
      if (status.state !== "ready") {
        return {
          ok: false as const,
          error:
            `Ollama ist nicht bereit (Status: ${status.state}). Soll ich versuchen, ` +
            `den Daemon mit \`ollama_restart\` neu zu starten?`,
        };
      }
      // Kick off the pull without awaiting completion. Progress streams
      // via the supervisor's "progress" event into IPC; the agent can
      // poll `ollama_status` for the resulting installed-models list.
      void ollama.pullModel(args.model).catch((err) => {
        console.warn(`[ollama_pull_model] pull '${args.model}' failed:`, err);
      });
      return { ok: true as const, model: args.model, transferStarted: true };
    },
    preview: (r) =>
      r.ok
        ? `Ollama-Pull gestartet: ${r.model}`
        : `Ollama-Pull abgelehnt: ${r.error}`,
  });

  const restartTool = defineTool({
    name: "ollama_restart",
    description:
      "Startet den lokalen Ollama-Daemon neu (Stop + Start). Nützlich, wenn der Daemon hängt, " +
      "ein Modell-Pull fehlgeschlagen ist oder der Nutzer 'Ollama neu starten' verlangt.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      try {
        await ollama.restart();
        const s = ollama.getStatus();
        return {
          ok: true as const,
          state: s.state,
          errorMessage: s.errorMessage,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Ollama neu gestartet (Status: ${r.state})`
        : `Ollama-Neustart fehlgeschlagen: ${r.error}`,
  });

  const deleteTool = defineTool({
    name: "ollama_delete_model",
    description:
      "Löscht ein installiertes Ollama-Modell, um Speicherplatz freizugeben. " +
      "Verwende das Tool nur, wenn der Nutzer ein konkretes Modell zum Löschen benennt. " +
      "Setzt voraus, dass der Daemon bereit ist.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description: "Modellname inklusive Tag, z. B. `qwen2.5:7b`.",
        },
      },
      required: ["model"],
    },
    schema: yup.object({
      model: yup.string().trim().min(1).required(),
    }),
    run: async (args) => {
      const status = ollama.getStatus();
      if (status.state !== "ready") {
        return {
          ok: false as const,
          error:
            `Ollama ist nicht bereit (Status: ${status.state}). Soll ich den Daemon ` +
            `mit \`ollama_restart\` neu starten?`,
        };
      }
      try {
        await ollama.deleteModel(args.model);
        return { ok: true as const, model: args.model };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Modell gelöscht: ${r.model}`
        : `Löschen fehlgeschlagen: ${r.error}`,
  });

  return [statusTool, pullTool, restartTool, deleteTool];
}
