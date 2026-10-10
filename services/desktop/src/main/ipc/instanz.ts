// IPC-Handler „Instanz“ (docs/PLAN_AVA_CLOUD.md §13.1): Instanz dieser AVA lesen
// und einstellen (Name, MCP an/aus). Die Liste aller Instanzen holt der Renderer
// direkt vom Gateway (/v1/instanzen).

import { ipcMain } from "electron";
import type { InstanzStore } from "../../core/relais/instanz";
import type { Umzug } from "../../core/umzug/umzug";

export interface InstanzIpcDeps {
  instanz: InstanzStore;
  zustandMelden: () => void;
  umzug: Umzug;
}

export function registerInstanzIpc(deps: InstanzIpcDeps): void {
  ipcMain.handle("instanz:get", () => deps.instanz.get());
  ipcMain.handle("instanz:set", (_e, patch: { name?: string; mcp?: boolean }) => {
    const neu = deps.instanz.set({
      ...(typeof patch?.name === "string" ? { name: patch.name } : {}),
      ...(typeof patch?.mcp === "boolean" ? { mcp: patch.mcp } : {}),
    });
    deps.zustandMelden();
    return neu;
  });
  // Umzug (§13.3): die Oberflaeche fragt vorher selbst nach (destruktiv).
  ipcMain.handle("umzug:stand", () => deps.umzug.getStand());
  ipcMain.handle("umzug:holen", (_e, quelle: string) => deps.umzug.holen(String(quelle)));
  ipcMain.handle("umzug:senden", (_e, ziel: string) => deps.umzug.senden(String(ziel)));
}
