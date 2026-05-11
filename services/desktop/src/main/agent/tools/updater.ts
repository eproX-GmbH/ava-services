// Phase T2 — OTA updater agent tools.
//
// Thin wrappers around the Updater instance owned by main/index.ts
// (same object the `updater:*` IPC handlers call). The agent can drive
// the full update cycle from chat: check for a new release, download
// the .dmg / .exe, and trigger install + relaunch.
//
// `updater_install` calls Updater.installAndRelaunch(), which quits the
// app a few ticks later. The tool returns `{ ok: true }` synchronously
// before quit so the chat surface sees a normal completion; the
// renderer just disappears once Squirrel swaps the bundle.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { Updater } from "../../updater";

export interface UpdaterToolDeps {
  updater: Updater;
}

export function buildUpdaterTools(deps: UpdaterToolDeps): Tool[] {
  const { updater } = deps;

  const statusTool = defineTool({
    name: "updater_status",
    description:
      "Liefert den Status des Auto-Updaters: aktuelle Version, neueste bekannte Version, " +
      "ob ein Update verfügbar ist und ob es bereits heruntergeladen wurde. Nutze das Tool, " +
      "wenn der Nutzer fragt, ob ein Update verfügbar ist oder welche Version aktuell läuft.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const s = updater.getStatus();
      const updateAvailable =
        s.state === "available" ||
        s.state === "downloading" ||
        s.state === "ready" ||
        s.state === "installing";
      return {
        state: s.state,
        currentVersion: s.currentVersion,
        latestVersion: s.latestVersion,
        updateAvailable,
        downloaded: s.state === "ready" || s.state === "installing",
        downloadProgress: s.progress?.percent ?? null,
        errorMessage: s.errorMessage,
      };
    },
    preview: (r) => {
      if (r.state === "error") {
        return `Updater-Fehler: ${r.errorMessage ?? "unbekannt"}`;
      }
      if (r.downloaded) {
        return `Update ${r.latestVersion ?? ""} bereit zur Installation`;
      }
      if (r.state === "downloading") {
        return `Update wird geladen (${
          r.downloadProgress !== null ? Math.round(r.downloadProgress) + " %" : "läuft"
        })`;
      }
      if (r.updateAvailable) {
        return `Update verfügbar: ${r.latestVersion ?? "neue Version"}`;
      }
      return `Version ${r.currentVersion} (kein Update verfügbar)`;
    },
  });

  const checkTool = defineTool({
    name: "updater_check",
    description:
      "Prüft bei GitHub Releases, ob eine neuere Version verfügbar ist. Nutze das Tool, " +
      "wenn der Nutzer 'Update prüfen' oder 'gibt es eine neue Version' verlangt. Liefert " +
      "anschließend den aktualisierten Status zurück. Funktioniert nur in der gepackten App; " +
      "im Entwicklungsmodus passiert nichts.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      try {
        await updater.check();
        const s = updater.getStatus();
        const updateAvailable =
          s.state === "available" ||
          s.state === "downloading" ||
          s.state === "ready";
        return {
          ok: true as const,
          updateAvailable,
          latestVersion: s.latestVersion,
          state: s.state,
        };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) => {
      if (!r.ok) return `Update-Prüfung fehlgeschlagen: ${r.error}`;
      return r.updateAvailable
        ? `Update verfügbar: ${r.latestVersion ?? "neue Version"}`
        : "App ist auf dem neuesten Stand";
    },
  });

  const downloadTool = defineTool({
    name: "updater_download",
    description:
      "Lädt das verfügbare Update im Hintergrund herunter (.dmg auf macOS, .exe auf Windows). " +
      "Setzt voraus, dass `updater_check` zuvor ein Update gemeldet hat. Der Download läuft " +
      "asynchron; Fortschritt über `updater_status` abfragen. Installation passiert separat " +
      "über `updater_install`.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const status = updater.getStatus();
      if (status.state !== "available") {
        return {
          ok: false as const,
          error:
            `Kein Update zum Download bereit (Status: ${status.state}). ` +
            `Soll ich vorher mit \`updater_check\` prüfen?`,
        };
      }
      // Kick off the download in the background. electron-updater
      // streams progress to the renderer via the "download-progress"
      // event; the agent can poll `updater_status` for completion.
      void updater.download().catch((err) => {
        console.warn("[updater_download] download failed:", err);
      });
      return { ok: true as const, started: true };
    },
    preview: (r) => (r.ok ? "Update-Download gestartet" : `Download abgelehnt: ${r.error}`),
  });

  const installTool = defineTool({
    name: "updater_install",
    description:
      "Installiert das heruntergeladene Update und startet die App neu. Setzt voraus, dass " +
      "`updater_download` abgeschlossen ist (`updater_status` meldet `downloaded: true`). " +
      "Achtung: der Aufruf beendet die App innerhalb weniger Sekunden, die Antwort kommt " +
      "möglicherweise nicht mehr beim Nutzer an.",
    parameters: {
      type: "object",
      properties: {},
    },
    schema: yup.object({}),
    run: async () => {
      const status = updater.getStatus();
      if (status.state !== "ready") {
        return {
          ok: false as const,
          error:
            `Update ist nicht installationsbereit (Status: ${status.state}). ` +
            `Erst mit \`updater_download\` herunterladen.`,
        };
      }
      try {
        updater.installAndRelaunch();
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok ? "Update-Installation gestartet, App startet neu" : `Installation abgelehnt: ${r.error}`,
  });

  return [statusTool, checkTool, downloadTool, installTool];
}
