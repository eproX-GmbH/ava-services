// IPC „Weitere Dienste“ (docs/PLAN_CLOSE_MCP.md, C2): Liste, Anlegen, Pruefen,
// Entfernen. Zugangsdaten gehen nur hinein, nie wieder hinaus.

import { ipcMain } from "electron";
import type { McpDienste } from "../mcp-client";
import type { McpHinzufuegen } from "../mcp-client";
import { DIENST_ZUGANG_ARTEN, type DienstZugangArt } from "../../shared/dienst-vorlagen";

const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function registerMcpDiensteIpc(deps: { mcpDienste: McpDienste }): void {
  const { mcpDienste } = deps;
  ipcMain.handle("mcp-dienste:liste", () => mcpDienste.liste());
  ipcMain.handle(
    "mcp-dienste:hinzufuegen",
    (_e, args: Partial<McpHinzufuegen> | undefined) =>
      mcpDienste.hinzufuegen({
        name: String(args?.name ?? ""),
        url: String(args?.url ?? ""),
        art: args?.art === "a2a" ? "a2a" : "mcp",
        zugang: DIENST_ZUGANG_ARTEN.includes(args?.zugang as DienstZugangArt) ? (args!.zugang as DienstZugangArt) : "keine",
        zugangscode: text(args?.zugangscode),
        ...(args?.kopfzeilen && typeof args.kopfzeilen === "object" ? { kopfzeilen: args.kopfzeilen } : {}),
        benutzer: text(args?.benutzer),
        passwort: text(args?.passwort),
        clientId: text(args?.clientId),
        clientSecret: text(args?.clientSecret),
        tokenAdresse: text(args?.tokenAdresse),
        scope: text(args?.scope),
      }),
  );
  ipcMain.handle("mcp-dienste:pruefen", (_e, id: string) => mcpDienste.pruefen(String(id)));
  ipcMain.handle("mcp-dienste:entfernen", (_e, id: string) => mcpDienste.entfernen(String(id)));
}
