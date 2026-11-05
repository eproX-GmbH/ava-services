// IPC „Weitere Dienste“ (docs/PLAN_CLOSE_MCP.md, C2): Liste, Anlegen, Pruefen,
// Entfernen. Zugangsdaten gehen nur hinein, nie wieder hinaus.

import { ipcMain } from "electron";
import type { McpDienste } from "../mcp-client";
import type { DienstArt, McpZugangArt } from "../mcp-client/store";

export function registerMcpDiensteIpc(deps: { mcpDienste: McpDienste }): void {
  const { mcpDienste } = deps;
  ipcMain.handle("mcp-dienste:liste", () => mcpDienste.liste());
  ipcMain.handle(
    "mcp-dienste:hinzufuegen",
    (_e, args: { name: string; url: string; art?: DienstArt; zugang: McpZugangArt; zugangscode?: string; kopfzeilen?: Record<string, string> }) =>
      mcpDienste.hinzufuegen({
        name: String(args?.name ?? ""),
        url: String(args?.url ?? ""),
        art: args?.art === "a2a" ? "a2a" : "mcp",
        zugang: args?.zugang === "zugangscode" || args?.zugang === "kopfzeilen" ? args.zugang : "keine",
        ...(typeof args?.zugangscode === "string" ? { zugangscode: args.zugangscode } : {}),
        ...(args?.kopfzeilen && typeof args.kopfzeilen === "object" ? { kopfzeilen: args.kopfzeilen } : {}),
      }),
  );
  ipcMain.handle("mcp-dienste:pruefen", (_e, id: string) => mcpDienste.pruefen(String(id)));
  ipcMain.handle("mcp-dienste:entfernen", (_e, id: string) => mcpDienste.entfernen(String(id)));
}
