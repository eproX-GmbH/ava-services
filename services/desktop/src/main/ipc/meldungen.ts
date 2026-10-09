// IPC-Handler „Meldungen, Benachrichtigungen, Frische, Interesse, Profil“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { InterestStore } from "../agent";
import * as relevanz from "../relevanz";
import type { Alert, AlertPrefs, UserProfile } from "../../shared/types";
import type { AlertPrefsStore, AlertsStore, FreshnessPrefsStore, FreshnessScheduler, Heartbeat, UserProfileStore } from "../agent";
import type { NotificationManager } from "../notifications";

export interface MeldungenIpcDeps {
  alertPrefs: AlertPrefsStore;
  alerts: AlertsStore;
  broadcastAlertsChanged: () => void;
  freshness: FreshnessScheduler;
  freshnessPrefs: FreshnessPrefsStore;
  heartbeat: Heartbeat;
  interest: InterestStore;
  notifications: NotificationManager;
  userProfile: UserProfileStore;
}

export function registerMeldungenIpc(deps: MeldungenIpcDeps): void {
  const { alertPrefs, alerts, broadcastAlertsChanged, freshness, freshnessPrefs, heartbeat, interest, notifications, userProfile } = deps;

  ipcMain.handle("alerts:list", () => alerts.list());

  ipcMain.handle("alerts:unreadCount", () => alerts.unreadCount());

  ipcMain.handle("alerts:markSeen", (_e, id: string) => {
    const ok = alerts.markSeen(id);
    if (ok) broadcastAlertsChanged();
    return ok;
  });

  ipcMain.handle("alerts:dismiss", (_e, id: string) => {
    const ok = alerts.dismiss(id);
    if (ok) broadcastAlertsChanged();
    return ok;
  });

  // v0.1.523 — "Alle als gelesen markieren" (Meldungs-Seite + Chat-Tool).
  ipcMain.handle("alerts:markAllSeen", () => {
    const n = alerts.markAllSeen();
    if (n > 0) broadcastAlertsChanged();
    return n;
  });

  ipcMain.handle("alerts:triggerNow", async () => {
    const info = await heartbeat.triggerNow();
    return info;
  });

  // Phase 8.f3 (transparency add-on) — surfaces the last N ticks with
  // per-candidate decisions so the Settings panel can show the user
  // what was weighed and why nothing was promoted on a given run.
  ipcMain.handle("alerts:recentTicks", () => heartbeat.getRecentTicks());

  // v0.1.160 — scheduling status (next-scheduled / running / cadence).
  // The Settings panel renders "nächster Sweep planmäßig HH:MM" from
  // this so users can see the scheduler is alive even before the
  // first tick has produced a history entry.
  ipcMain.handle("alerts:heartbeatStatus", () => heartbeat.getStatus());

  // Freshness scheduler IPC (Phase 8.r1). Read-only + manual trigger;
  // the chat tools surface (8.r3) layers on top. `triggerNow` returns
  // the same FreshnessTickInfo shape `freshness:recentTicks` lists.
  ipcMain.handle("freshness:recentTicks", () => freshness.getRecentTicks());

  ipcMain.handle("freshness:triggerNow", () => freshness.triggerNow());

  ipcMain.handle("freshness:getPrefs", () => freshnessPrefs.get());

  ipcMain.handle(
    "freshness:setPrefs",
    (_e, patch: Parameters<typeof freshnessPrefs.set>[0]) =>
      freshnessPrefs.set(patch),
  );

  // 8.r4 — interest-signal recorder. Fired by the renderer whenever
  // the user opens CompanyDetail or clicks a `[…](company:id)` link
  // in chat. No-op return; the scheduler picks the signal up on the
  // next tick.
  ipcMain.handle("interest:record", (_e, companyId: string, art?: string) => {
    if (typeof companyId === "string" && companyId.length > 0) {
      interest.record(companyId);
      // Der InterestStore bleibt daneben bestehen: Er ist der Sofort-Schub
      // fuer den Frischeplaner innerhalb einer Sitzung, die Naehe die
      // langfristige Groesse ueber Wochen.
      //
      // Nur der Chat-Klick wird hier erfasst. Die Firmenansicht meldet sich
      // selbst, sobald ihre Daten geladen sind — dann kann sie das Gewicht
      // (Status, Uebernahme) gleich mitschicken, und die Entprellung wuerde
      // ein zweites Signal in derselben Stunde ohnehin schlucken.
      if (art === "chatlink") relevanz.erfasse("firma.chatlink", companyId);
    }
  });

  // User profile IPC (Phase 8.t1). Read-only views + direct writes
  // for Settings panel edits. Agent-inferred updates go through
  // `profile_propose_update` which gates on ask_user_choice; the
  // explicit-write IPC bypasses that gate intentionally because the
  // Settings panel IS the explicit user surface.
  ipcMain.handle("profile:get", () => userProfile.get());

  ipcMain.handle("profile:set", (_e, patch: Partial<UserProfile>) =>
    userProfile.set(patch),
  );

  ipcMain.handle("profile:clear", () => userProfile.clear());

  // Alert preferences (Phase 8.f3). The renderer's Settings page
  // reads via `alert-prefs:get` and patches via `alert-prefs:set`;
  // main rebroadcasts `alert-prefs:changed` so every open window's
  // store re-syncs without polling. Permission status is read-only
  // — the OS owns that gate.
  ipcMain.handle("alert-prefs:get", () => alertPrefs.get());

  ipcMain.handle("alert-prefs:set", (_e, patch: Partial<AlertPrefs>) =>
    alertPrefs.set(patch),
  );

  ipcMain.handle("notifications:getPermissionStatus", () =>
    notifications.permissionStatus(),
  );
}
