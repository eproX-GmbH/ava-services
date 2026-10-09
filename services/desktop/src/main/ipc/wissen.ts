// IPC-Handler „Wissensquellen“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import type { KnowledgeManager } from "../knowledge/manager";
import type { KnowledgeProviderStore } from "../knowledge/store";

export interface WissenIpcDeps {
  knowledge: KnowledgeManager;
  knowledgeStore: KnowledgeProviderStore;
}

export function registerWissenIpc(deps: WissenIpcDeps): void {
  const { knowledge, knowledgeStore } = deps;

  ipcMain.handle("knowledge:getSnapshot", () => knowledgeStore.snapshot());

  // v0.1.225 — P2 Notion: Connect/Disconnect/List-Databases via IPC.
  ipcMain.handle(
    "knowledge:connect",
    async (
      _e,
      args: { kind: import("../../shared/types").KnowledgeProviderKind; token: string },
    ) => {
      await knowledge.connect(args.kind, args.token);
      return knowledgeStore.snapshot();
    },
  );

  ipcMain.handle(
    "knowledge:disconnect",
    async (
      _e,
      args: { kind: import("../../shared/types").KnowledgeProviderKind },
    ) => {
      await knowledge.disconnect(args.kind);
      return knowledgeStore.snapshot();
    },
  );

  ipcMain.handle("knowledge:listNotionDatabases", () =>
    knowledge.listNotionDatabases(),
  );
}
