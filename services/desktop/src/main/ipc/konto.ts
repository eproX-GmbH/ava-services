// IPC-Handler „Anmeldung und Organisation“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { getOrgPolicy } from "../org-policy";
import { checkTenantChange, consumePendingJoin, extractJoinToken, listShares as orgListShares, markShare as orgMarkShare, refreshOrgContext as orgRefreshContext, shareRadar as orgShareRadar } from "../organisation";
import type { Auth } from "../auth";

export interface KontoIpcDeps {
  auth: Auth;
}

export function registerKontoIpc(deps: KontoIpcDeps): void {
  const { auth } = deps;

  ipcMain.handle("auth:getStatus", () => auth.getStatus());

  ipcMain.handle("auth:getAccessToken", () => auth.getAccessToken());

  ipcMain.handle("auth:signIn", () => auth.signIn());

  ipcMain.handle("auth:signOut", () => auth.signOut());

  // In-App-Registration. Renderer passes the validated form payload;
  // main proxies to the gateway + adopts the returned tokens. Errors
  // from `auth.registerAccount()` are RegistrationError instances —
  // ipcMain forwards them as plain Errors to the renderer, so the
  // form serialises the .code / .message via try/catch on the
  // invoke() promise. We re-shape into { ok, code, message } so the
  // renderer doesn't have to dig through stringified Error.toString.
  ipcMain.handle(
    "auth:register",
    async (
      _e,
      input: {
        firstName: string;
        lastName: string;
        email: string;
        password: string;
        acceptTerms: true;
      },
    ): Promise<
      | { ok: true }
      | { ok: false; code: string; message: string }
    > => {
      try {
        await auth.registerAccount(input);
        return { ok: true };
      } catch (err) {
        // RegistrationError carries a code; any other thrown shape is
        // a programming bug we still want to surface gracefully.
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code: unknown }).code)
            : "server_error";
        const message =
          err instanceof Error
            ? err.message
            : "Unbekannter Fehler beim Anlegen des Kontos.";
        return { ok: false, code, message };
      }
    },
  );

  // O2 — Organisationen.
  ipcMain.handle("org:consumePendingJoin", () => consumePendingJoin());

  ipcMain.handle("org:checkTenant", () => checkTenantChange("auf Anforderung"));

  ipcMain.handle("org:extractJoinToken", (_e, eingabe: string) => extractJoinToken(String(eingabe ?? "")));

  // O9 — Freigaben (Radar-Firmen) im Renderer.
  ipcMain.handle("org:shares", (_e, kind?: "transaction" | "radar_company") => orgListShares(kind));

  ipcMain.handle("org:shareRadar", (_e, ids: string[], note?: string) =>
    orgShareRadar((Array.isArray(ids) ? ids : []).map(String), typeof note === "string" ? note : undefined),
  );

  ipcMain.handle("org:markShare", (_e, id: string, was: "seen" | "dismiss") => orgMarkShare(String(id), was === "dismiss" ? "dismiss" : "seen"));

  ipcMain.handle("org:getPolicy", () => getOrgPolicy());

  ipcMain.handle("org:refreshPolicy", async () => {
    await checkTenantChange("Vorgaben aktualisiert");
    // v0.1.555 — auch Organisationsschluessel/Anfragen nachladen (Onboarding).
    await orgRefreshContext().catch(() => undefined);
    return getOrgPolicy();
  });
}
