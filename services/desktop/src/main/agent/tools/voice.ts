// Phase T2 — Voice (whisper.cpp) agent tools.
//
// Thin wrappers around the WhisperSidecar instance owned by
// main/index.ts (same object the `voice:*` IPC handlers call). The
// agent can drive first-time voice setup from chat: report status,
// install the bundled binary, download or delete the model.
//
// Deliberately NOT exposed as agent tools:
//
//   - `voice:transcribe` — takes raw audio bytes (Uint8Array). Tool
//     calls are JSON-only and the chat surface never carries audio
//     buffers, so wiring this up would not help any real user request.
//
//   - `voice:micPermission` / `voice:requestMicPermission` /
//     `voice:openMicSettings` — these need a user-visible OS prompt or
//     a direct click in System Settings. The renderer wires those into
//     the Settings panel; surfacing them to the chat agent would just
//     produce confusing "permission granted" tool results without any
//     actual user interaction.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { WhisperSidecar } from "../../voice/whisper-sidecar";

export interface VoiceToolDeps {
  whisper: WhisperSidecar;
}

export function buildVoiceTools(deps: VoiceToolDeps): Tool[] {
  const { whisper } = deps;

  const statusTool = defineTool({
    name: "voice_status",
    description:
      "Liefert den Status der Spracherkennung: ist das whisper.cpp-Binary installiert, " +
      "ist das Sprachmodell heruntergeladen, läuft ein Download. Nutze das Tool, wenn der " +
      "Nutzer fragt, ob Diktat / Spracheingabe einsatzbereit ist.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const s = whisper.getStatus();
      const binaryInstalled = s.state !== "binary-missing" && s.binaryPath !== null;
      const modelDownloaded = s.model?.installed === true;
      const dl = s.download;
      const downloadProgress =
        dl && dl.total && dl.total > 0 ? (dl.completed / dl.total) * 100 : null;
      return {
        state: s.state,
        binaryInstalled,
        modelDownloaded,
        modelName: s.model?.label ?? null,
        modelId: s.model?.id ?? null,
        downloadProgress,
        errorMessage: s.errorMessage,
      };
    },
    preview: (r) => {
      if (!r.binaryInstalled) return "Spracherkennung: Binary fehlt";
      if (!r.modelDownloaded) {
        if (r.downloadProgress !== null) {
          return `Sprachmodell wird geladen (${Math.round(r.downloadProgress)} %)`;
        }
        return "Spracherkennung: Modell fehlt";
      }
      return `Spracherkennung bereit (${r.modelName ?? "Modell"})`;
    },
  });

  const installBinaryTool = defineTool({
    name: "voice_install_binary",
    description:
      "Installiert das whisper.cpp-Binary (über Homebrew auf macOS, via offiziellem Download " +
      "auf Windows, Paketmanager-Hinweis auf Linux). Nutze das Tool, wenn der Nutzer die " +
      "Spracherkennung erstmals einrichten möchte und `voice_status` 'binary-missing' meldet. " +
      "Kann mehrere Minuten dauern.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      try {
        await whisper.installBinary();
        const s = whisper.getStatus();
        return {
          ok: true as const,
          state: s.state,
          binaryInstalled: s.state !== "binary-missing",
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
        ? `whisper.cpp installiert (Status: ${r.state})`
        : `Installation fehlgeschlagen: ${r.error}`,
  });

  const downloadModelTool = defineTool({
    name: "voice_download_model",
    description:
      "Lädt das Standard-Sprachmodell für die Diktatfunktion herunter (mehrere hundert MB). " +
      "Der `model`-Parameter ist optional und wird derzeit ignoriert; die App nutzt das per " +
      "Umgebungsvariable konfigurierte Standardmodell. Nutze das Tool, wenn `voice_status` " +
      "'model-missing' meldet. Der Download läuft im Hintergrund weiter; Fortschritt über " +
      "`voice_status` abfragen.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Optionaler Modellname. Derzeit ignoriert; die App wählt das Modell anhand " +
            "der Umgebungsvariablen WHISPER_MODEL_ID / WHISPER_MODEL_URL.",
        },
      },
    },
    schema: yup.object({
      model: yup.string().trim().optional(),
    }),
    run: async () => {
      const status = whisper.getStatus();
      if (status.state === "binary-missing") {
        return {
          ok: false as const,
          error:
            "Das whisper.cpp-Binary ist nicht installiert. Soll ich es mit " +
            "`voice_install_binary` einrichten?",
        };
      }
      // Kick off without awaiting — the sidecar streams progress events
      // via IPC, and the agent can poll `voice_status` for completion.
      void whisper.downloadModel().catch((err) => {
        console.warn("[voice_download_model] download failed:", err);
      });
      return { ok: true as const, transferStarted: true };
    },
    preview: (r) =>
      r.ok
        ? "Sprachmodell-Download gestartet"
        : `Download abgelehnt: ${r.error}`,
  });

  const deleteModelTool = defineTool({
    name: "voice_delete_model",
    description:
      "Löscht das heruntergeladene Sprachmodell, um Speicherplatz freizugeben. Der " +
      "`model`-Parameter ist optional und wird derzeit ignoriert; die App löscht das aktive " +
      "Modell. Nach dem Löschen muss `voice_download_model` aufgerufen werden, bevor Diktat " +
      "wieder funktioniert.",
    parameters: {
      type: "object",
      properties: {
        model: {
          type: "string",
          description:
            "Optionaler Modellname. Derzeit ignoriert; die App löscht das aktive Modell.",
        },
      },
    },
    schema: yup.object({
      model: yup.string().trim().optional(),
    }),
    run: async () => {
      try {
        await whisper.deleteModel();
        const s = whisper.getStatus();
        return { ok: true as const, state: s.state };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Sprachmodell gelöscht (Status: ${r.state})`
        : `Löschen fehlgeschlagen: ${r.error}`,
  });

  return [statusTool, installBinaryTool, downloadModelTool, deleteModelTool];
}
