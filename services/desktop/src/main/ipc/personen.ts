// IPC-Handler „LinkedIn-Watchlist und Personen-Radar“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { buildApifyProvider } from "../linkedin/watchlist/providers/apify";
import { watchlistLimitsForTier } from "../linkedin/watchlist/store";
import type { AuditEventInput } from "../audit/audit-types";
import type { PersonenRadarStore } from "../linkedin/personen-radar/store";
import type { PersonenRadarSupervisor } from "../linkedin/personen-radar/supervisor";
import type { WatchlistKeyStore } from "../linkedin/watchlist/key-store";
import type { WatchlistStore } from "../linkedin/watchlist/store";
import type { WatchlistSupervisor } from "../linkedin/watchlist/supervisor";

export interface PersonenIpcDeps {
  apifyZugangInfo: () => { apifyQuelle: "eigen" | "organisation" | null; apifyVerfuegbar: boolean; eigenerTokenErlaubt: boolean };
  audit: (input: AuditEventInput) => void;
  cycleCompanyContact: () => void;
  getTenantTierCached: () => "free" | "starter" | "pro" | "enterprise" | null;
  personenRadarStore: { readonly current: PersonenRadarStore | null };
  personenRadarSupervisor: { readonly current: PersonenRadarSupervisor | null };
  resolveApifyAccess: () => Promise<import("../linkedin/apify-access").ApifyAccess | null>;
  watchlistKeyStore: { readonly current: WatchlistKeyStore | null };
  watchlistStore: { readonly current: WatchlistStore | null };
  watchlistSupervisor: { readonly current: WatchlistSupervisor | null };
}

export function registerPersonenIpc(deps: PersonenIpcDeps): void {
  const { apifyZugangInfo, audit, cycleCompanyContact, getTenantTierCached, personenRadarStore, personenRadarSupervisor, resolveApifyAccess, watchlistKeyStore, watchlistStore, watchlistSupervisor } = deps;

  // ---- WL4 — Personen-Watchlist (PLAN_LINKEDIN_WATCHLIST.md §4.5) ----------
  // Der Anbieter-Key wird NIE zurueckgespiegelt (nur hasKey).
  ipcMain.handle("watchlist:getState", async () => {
    if (!watchlistKeyStore.current || !watchlistStore.current || !watchlistSupervisor.current) {
      return { error: "Watchlist nicht initialisiert." };
    }
    const cfg = watchlistKeyStore.current.getConfig();
    const monthKey = new Date().toISOString().slice(0, 7);
    return {
      config: {
        enabled: cfg.enabled,
        providerId: cfg.providerId,
        reactionsActorId: cfg.reactionsActorId,
        commentsActorId: cfg.commentsActorId,
        intervalHours: cfg.intervalHours,
        maxItemsPerProfile: cfg.maxItemsPerProfile,
        bestandRotationEnabled: cfg.bestandRotationEnabled,
        maxBestandPerRun: cfg.maxBestandPerRun,
        lastRunAt: cfg.lastRunAt,
        lastOutcome: cfg.lastOutcome,
      },
      hasKey: watchlistKeyStore.current.hasKey(),
      ...apifyZugangInfo(),
      running: watchlistSupervisor.current.isRunning(),
      monthItems: cfg.monthKey === monthKey ? cfg.monthItems : 0,
      limits: watchlistLimitsForTier(getTenantTierCached()),
      entries: await watchlistStore.current.list(),
    };
  });

  ipcMain.handle(
    "watchlist:setConfig",
    (_e, patch: Record<string, unknown>) => {
      if (!watchlistKeyStore.current) return { error: "nicht initialisiert" };
      const allowed: Record<string, unknown> = {};
      for (const k of [
        "enabled",
        "reactionsActorId",
        "commentsActorId",
        "intervalHours",
        "maxItemsPerProfile",
        "bestandRotationEnabled",
        "maxBestandPerRun",
        "companyWindow",
        "profilModus",
      ]) {
        if (patch && k in patch) allowed[k] = patch[k];
      }
      // §8b — Fenster- und Modus-Aenderung muessen den company-contact-
      // Producer recyceln, damit extraEnvAsync die frischen Werte injiziert.
      const vorherFenster = watchlistKeyStore.current.getConfig().companyWindow;
      const vorherModus = watchlistKeyStore.current.getConfig().profilModus;
      const result = watchlistKeyStore.current.setConfig(allowed);
      if (result.companyWindow !== vorherFenster || result.profilModus !== vorherModus) {
        cycleCompanyContact();
      }
      return result;
    },
  );

  ipcMain.handle("watchlist:setKey", async (_e, key: string) => {
    if (!watchlistKeyStore.current) return { ok: false, error: "nicht initialisiert" };
    const r = watchlistKeyStore.current.setKey(String(key ?? ""));
    if (r.ok) {
      cycleCompanyContact();
      audit({
        actorType: "user", actorId: null, category: "linkedin",
        action: "watchlist.key.set", severity: "info",
        subjectType: "credential", subjectId: null,
        summary: "Watchlist: Anbieter-Token hinterlegt", metadata: {},
      });
    }
    return r;
  });

  ipcMain.handle("watchlist:clearKey", () => {
    watchlistKeyStore.current?.clearKey();
    cycleCompanyContact();
    audit({
      actorType: "user", actorId: null, category: "linkedin",
      action: "watchlist.key.clear", severity: "warning",
      subjectType: "credential", subjectId: null,
      summary: "Watchlist: Anbieter-Token geloescht (Automatik aus)", metadata: {},
    });
    return { ok: true };
  });

  ipcMain.handle("watchlist:verifyKey", async () => {
    const key = await resolveApifyAccess();
    if (!key) return { ok: false, detail: "Kein Apify-Zugang (weder eigener Token noch Organisationsschluessel)." };
    const cfg = watchlistKeyStore.current!.getConfig();
    return buildApifyProvider({
      reactionsActorId: cfg.reactionsActorId,
      commentsActorId: cfg.commentsActorId,
    }).verify(key);
  });

  ipcMain.handle(
    "watchlist:add",
    (
      _e,
      input: {
        profileUrl: string;
        label?: string;
        companyId?: string | null;
        fokus?: boolean;
        quelle?: "manuell" | "kontakt";
      },
    ) =>
      watchlistStore.current ? watchlistStore.current.add(input) : { error: "nicht initialisiert" },
  );

  ipcMain.handle("watchlist:remove", (_e, profileUrl: string) =>
    watchlistStore.current ? watchlistStore.current.remove(profileUrl) : false,
  );

  ipcMain.handle("watchlist:setFokus", (_e, profileUrl: string, fokus: boolean) =>
    watchlistStore.current ? watchlistStore.current.setFokus(profileUrl, fokus) : false,
  );

  ipcMain.handle("watchlist:setAktiv", (_e, profileUrl: string, aktiv: boolean) =>
    watchlistStore.current ? watchlistStore.current.setAktiv(profileUrl, aktiv) : false,
  );

  ipcMain.handle("watchlist:runNow", () =>
    watchlistSupervisor.current
      ? watchlistSupervisor.current.runNow("manuell")
      : "nicht initialisiert",
  );

  // ---- §8 Personen-Radar ----------------------------------------------------
  ipcMain.handle("pradar:getState", async () => {
    if (!personenRadarStore.current || !personenRadarSupervisor.current) {
      return { error: "nicht initialisiert" };
    }
    return {
      config: personenRadarStore.current.getConfig(),
      hasKey: watchlistKeyStore.current?.hasKey() ?? false,
      ...apifyZugangInfo(),
      running: personenRadarSupervisor.current.isRunning(),
      unklar: await personenRadarStore.current.listUnklar(),
    };
  });

  ipcMain.handle("pradar:setConfig", (_e, patch: Record<string, unknown>) => {
    if (!personenRadarStore.current) return { error: "nicht initialisiert" };
    const allowed: Record<string, unknown> = {};
    for (const k of ["enabled", "postUrls", "intervalHours", "maxItemsPerPost", "maxResolvesPerRun"]) {
      if (patch && k in patch) allowed[k] = patch[k];
    }
    return personenRadarStore.current.setConfig(allowed);
  });

  ipcMain.handle("pradar:runNow", () =>
    personenRadarSupervisor.current
      ? personenRadarSupervisor.current.runNow("manuell")
      : "nicht initialisiert",
  );
}
