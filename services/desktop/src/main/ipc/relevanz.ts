// IPC-Handler „Relevanz und Buying Center“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { ladeInteraktionen } from "../buying-center/interaktionen";
import * as relevanz from "../relevanz";
import type { GatewayClient } from "../agent";
import type { CrmManager } from "../crm";

export interface RelevanzIpcDeps {
  crmManager: CrmManager;
  gatewayClient: GatewayClient;
}

export function registerRelevanzIpc(deps: RelevanzIpcDeps): void {
  const { crmManager, gatewayClient } = deps;

  // ---- Relevanz (docs/PLAN_RELEVANZ.md) ------------------------------------
  ipcMain.handle(
    "relevanz:erfasse",
    (_e, art: string, zielId: string, opt?: relevanz.ErfassenOptionen) => {
      relevanz.erfasse(art, zielId, opt ?? {});
    },
  );

  ipcMain.handle("relevanz:werte", (_e, zielArt: "firma" | "person", ids: string[]) =>
    relevanz.werte(zielArt, Array.isArray(ids) ? ids : []).then((m) => Object.fromEntries(m)),
  );

  ipcMain.handle("relevanz:thema", (_e, limit?: number) => relevanz.thema(limit ?? 50));

  ipcMain.handle("relevanz:rohsignale", (_e, zielArt?: "firma" | "person", zielId?: string) =>
    relevanz.rohsignale(zielArt, zielId),
  );

  ipcMain.handle(
    "relevanz:vergessen",
    (_e, zielArt?: "firma" | "person", zielId?: string, sperreTage?: number) =>
      relevanz.vergessen(zielArt, zielId, sperreTage),
  );

  // Buying Center (docs/PLAN_BUYING_CENTER.md, BC3)
  ipcMain.handle("buyingCenter:interaktionen", (_e, buyingCenterId: string) =>
    ladeInteraktionen({ crm: crmManager, gateway: gatewayClient }, String(buyingCenterId)),
  );

  ipcMain.handle("relevanz:status", () => ({
    an: relevanz.aktiv(),
    selbstbestimmt: relevanz.selbstbestimmt(),
  }));

  ipcMain.handle("relevanz:setzeAn", (_e, an: boolean) => {
    relevanz.setzeAn(an === true);
    return { an: relevanz.aktiv(), selbstbestimmt: relevanz.selbstbestimmt() };
  });
}
