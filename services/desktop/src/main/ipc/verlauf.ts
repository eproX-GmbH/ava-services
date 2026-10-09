// IPC-Handler „Audit, Verbrauch, Selbstkorrekturen“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import type { LlmProviderManager } from "../agent";
import type { SelfCorrectionsStore } from "../agent/self-corrections-store";
import type { AuditStore } from "../audit/audit-store";
import type { AuditEventInput } from "../audit/audit-types";
import type { Auth } from "../auth";
import type { DailyTokenLimitStatus } from "../../shared/types";
import type { UsageStore } from "../usage/usage-store";

export interface VerlaufIpcDeps {
  audit: (input: AuditEventInput) => void;
  auditStore: AuditStore;
  auth: Auth;
  broadcastDailyLimitStatus: () => Promise<void>;
  computeDailyLimitStatus: () => Promise<DailyTokenLimitStatus>;
  providers: LlmProviderManager;
  selfCorrectionsStore: SelfCorrectionsStore;
  usageStore: UsageStore;
}

export function registerVerlaufIpc(deps: VerlaufIpcDeps): void {
  const { audit, auditStore, auth, broadcastDailyLimitStatus, computeDailyLimitStatus, providers, selfCorrectionsStore, usageStore } = deps;

  // v0.1.200 — Audit-Trail IPC.
  //
  // Renderer calls (audit:list) → query the local PGlite-backed
  // store. Audit-store auto-starts on first append; the list
  // handler also triggers start() so a fresh install with zero
  // events still answers with an empty page rather than a
  // not-started error.
  //
  // Live-tail is the `audit:inserted` event broadcast we wire on
  // the store's "inserted" emit (see above near auditStore
  // construction); the renderer subscribes via ipcRenderer.on.
  ipcMain.handle("audit:list", async (_e, query) => {
    return auditStore.list(query ?? {});
  });

  ipcMain.handle("audit:purgeAll", async () => {
    const removed = await auditStore.purgeAll();
    audit({
      actorType: "user",
      actorId: null,
      category: "auth", // closest match — destructive op
      action: "audit.purge.all",
      severity: "warning",
      subjectType: null,
      subjectId: null,
      summary: `Audit-Trail manuell geleert (${removed} Einträge entfernt)`,
      metadata: { removed },
    });
    return { removed };
  });

  // v0.1.210 — Token-Verbrauchs-IPC.
  //
  // - usage:daily(days)    → Aggregat für Stacked-Bar + Source-Donut
  // - usage:list(query)    → Drill-down-Liste (Pagination)
  // - usage:purgeAll()     → Settings-Knopf "Verbrauchsdaten löschen"
  //
  // Daily-Purge auf App-Start + alle 24h analog Audit-Store.
  ipcMain.handle("usage:daily", async (_e, days: number) => {
    const d = Number.isFinite(days) && days > 0 ? Math.min(days, 365) : 7;
    return usageStore.daily(d);
  });

  ipcMain.handle("usage:list", async (_e, query) => {
    return usageStore.list(query ?? {});
  });

  // v0.1.405 — Tages-Token-Limit: lesen, setzen/entfernen, Live-Status.
  ipcMain.handle("usage:getDailyLimit", async () => {
    return providers.getDailyTokenLimit();
  });

  ipcMain.handle(
    "usage:setDailyLimit",
    async (_e, limit: number | null) => {
      const next = providers.setDailyTokenLimit(
        typeof limit === "number" ? limit : null,
      );
      // configChanged feuert broadcastDailyLimitStatus() bereits (siehe
      // Subscription unten); hier zusätzlich direkt, damit der Aufrufer
      // den frischen Status sofort zurückbekommt.
      void broadcastDailyLimitStatus();
      return next;
    },
  );

  ipcMain.handle("usage:limitStatus", async () => {
    return computeDailyLimitStatus();
  });

  ipcMain.handle("usage:purgeAll", async () => {
    const removed = await usageStore.purgeAll();
    audit({
      actorType: "user",
      actorId: null,
      category: "auth",
      action: "usage.purge.all",
      severity: "warning",
      subjectType: null,
      subjectId: null,
      summary: `Verbrauchsdaten manuell geleert (${removed} Einträge entfernt)`,
      metadata: { removed },
    });
    return { removed };
  });

  // ---- Self-Corrections IPC (v0.1.284) ----------------------------------
  ipcMain.handle(
    "self-corrections:list",
    async (
      _e,
      query?: import("../../shared/types").SelfCorrectionListQuery,
    ): Promise<import("../../shared/types").SelfCorrectionListResponse> => {
      return selfCorrectionsStore.list(query ?? {});
    },
  );

  ipcMain.handle(
    "self-corrections:delete",
    async (_e, id: string): Promise<{ ok: true }> => {
      await selfCorrectionsStore.deleteOne(id);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "self-corrections:deleteAll",
    async (): Promise<{ ok: true }> => {
      await selfCorrectionsStore.deleteAll();
      return { ok: true };
    },
  );
}
