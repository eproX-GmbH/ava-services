// IPC-Handler „Beobachtungen, Link-Beobachter, Publikationen“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { LINK_MONITOR_ACTIVE_CAP } from "../../shared/types";
import { WatchStore } from "../agent";
import type { LinkMonitor, LinkMonitorInput, LinkMonitorSnapshot, Watch } from "../../shared/types";
import type { AuditEventInput } from "../audit/audit-types";
import type { LinkMonitorSupervisor } from "../link-monitor/supervisor";
import type { PublicationStore } from "../publication/store";

export interface BeobachtungIpcDeps {
  audit: (input: AuditEventInput) => void;
  broadcastWatchesChanged: () => void;
  linkMonitorSupervisor: { readonly current: LinkMonitorSupervisor | null };
  publicationStore: PublicationStore;
  watchStore: WatchStore;
}

export function registerBeobachtungIpc(deps: BeobachtungIpcDeps): void {
  const { audit, broadcastWatchesChanged, linkMonitorSupervisor, publicationStore, watchStore } = deps;

  ipcMain.handle("publication:getAnalysisMode", () =>
    publicationStore.getMode(),
  );

  ipcMain.handle(
    "publication:setAnalysisMode",
    (_e, mode: "lazy" | "eager") => {
      const next = publicationStore.setMode(mode);
      audit({
        actorType: "user",
        actorId: null,
        category: "producer",
        action: "publication.analysis-mode",
        severity: "info",
        subjectType: null,
        subjectId: null,
        summary:
          next === "eager"
            ? "Publikations-Analyse auf VOLLSTAENDIG (eager) gestellt — jeder Block wird per LLM analysiert"
            : "Publikations-Analyse auf SPARSAM (lazy) gestellt — nur trend-relevante Bloecke",
        metadata: { mode: next },
      });
      return next;
    },
  );

  // Watches IPC (Phase 8.t2). Read-only views + remove / pause /
  // resume mutations for the Settings panel + topbar chip popover.
  // Watch *creation* stays chat-only (the propose-and-confirm gate
  // lives in the `watch_register` tool, which renders an
  // ask_user_choice card before persistence).
  ipcMain.handle("watches:list", (): Watch[] => watchStore.list());

  ipcMain.handle(
    "watches:remove",
    (_e, id: string): boolean => watchStore.remove(id),
  );

  ipcMain.handle(
    "watches:setEnabled",
    (_e, args: { id: string; enabled: boolean }): boolean =>
      watchStore.setEnabled(args.id, args.enabled),
  );

  // v0.1.275 — Direkter Create-Path aus Settings-UI (Phase 3). UI-
  // Form-Submit ist der Confirm; der Agent-Pfad (watch_register-Tool)
  // bleibt mit ask_user_choice. Cap-Check + Validierung erfolgt im
  // WatchStore.add, das wirft mit deutschsprachiger Message.
  ipcMain.handle(
    "watches:create",
    async (
      _e,
      args: {
        prompt: string;
        rubric: string;
        cadence: "daily" | "weekly" | "monthly";
        companyIds?: string[];
        topics?: string[];
      },
    ): Promise<{ ok: true; watch: Watch } | { ok: false; error: string }> => {
      try {
        const trigger: import("../../shared/types").WatchTrigger = {
          rubric: args.rubric.trim(),
          ...(args.companyIds && args.companyIds.length > 0
            ? { companyIds: args.companyIds }
            : {}),
          ...(args.topics && args.topics.length > 0
            ? { topics: args.topics as import("../../shared/types").AlertKind[] }
            : {}),
        };
        const watch = watchStore.add({
          prompt: args.prompt.trim(),
          trigger,
          cadence: args.cadence,
        });
        broadcastWatchesChanged();
        return { ok: true, watch };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // LM — Link-Monitor IPC. Verwaltung der überwachten Links aus der
  // Settings-UI (und gespiegelt über die Agent-Tools).
  ipcMain.handle(
    "linkMonitor:list",
    async (): Promise<LinkMonitorSnapshot> => {
      if (!linkMonitorSupervisor.current) {
        return {
          monitors: [],
          activeCount: 0,
          cap: LINK_MONITOR_ACTIVE_CAP,
          runningIds: [],
        };
      }
      const monitors = await linkMonitorSupervisor.current.store.list();
      return {
        monitors,
        activeCount: monitors.filter((m) => m.status === "active").length,
        cap: LINK_MONITOR_ACTIVE_CAP,
        runningIds: linkMonitorSupervisor.current.runningIds(),
      };
    },
  );

  ipcMain.handle(
    "linkMonitor:create",
    async (
      _e,
      input: LinkMonitorInput,
    ): Promise<
      { ok: true; monitor: LinkMonitor } | { ok: false; error: string }
    > => {
      if (!linkMonitorSupervisor.current) {
        return { ok: false, error: "Link-Monitor noch nicht bereit." };
      }
      try {
        const monitor = await linkMonitorSupervisor.current.createMonitor(input, "user");
        return { ok: true, monitor };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "linkMonitor:update",
    async (
      _e,
      id: string,
      patch: Partial<LinkMonitorInput>,
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!linkMonitorSupervisor.current) {
        return { ok: false, error: "Link-Monitor noch nicht bereit." };
      }
      try {
        await linkMonitorSupervisor.current.update(id, patch);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "linkMonitor:remove",
    async (_e, id: string): Promise<{ ok: true }> => {
      if (linkMonitorSupervisor.current) await linkMonitorSupervisor.current.remove(id);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "linkMonitor:pause",
    async (_e, id: string): Promise<{ ok: true }> => {
      if (linkMonitorSupervisor.current) await linkMonitorSupervisor.current.pause(id);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "linkMonitor:resume",
    async (_e, id: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!linkMonitorSupervisor.current) {
        return { ok: false, error: "Link-Monitor noch nicht bereit." };
      }
      try {
        await linkMonitorSupervisor.current.resume(id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "linkMonitor:runNow",
    async (
      _e,
      id: string,
    ): Promise<{ ok: boolean; outcome?: string; error?: string }> => {
      // v0.1.411 — vorher: `void runNow(id); return {ok:true}` — der Aufruf
      // war fire-and-forget und meldete IMMER Erfolg, selbst wenn der
      // Supervisor gar nicht lief. Der Knopf wirkte dadurch tot. Jetzt
      // warten wir den Durchlauf ab und geben das echte Ergebnis zurück.
      if (!linkMonitorSupervisor.current) {
        return {
          ok: false,
          error:
            "Die Link-Überwachung ist noch nicht bereit. Versuch es in ein paar Sekunden erneut.",
        };
      }
      try {
        return await linkMonitorSupervisor.current.runNow(id);
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
