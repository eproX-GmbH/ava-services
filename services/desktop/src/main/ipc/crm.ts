// IPC-Handler „CRM“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { CrmManager } from "../crm";
import { runCrmEnrichment, searchHubspotCompanies } from "../crm/fetch-enrichment";
import type { Auth } from "../auth";
import type { CrmProvider, CrmStatus } from "../crm/types";

export interface CrmIpcDeps {
  auth: Auth;
  crmManager: CrmManager;
  GATEWAY_URL: string;
}

export function registerCrmIpc(deps: CrmIpcDeps): void {
  const { auth, crmManager, GATEWAY_URL } = deps;

  // v0.1.54 — CRM connection manager. Drive OAuth connect/disconnect
  // for the supported CRMs (Salesforce / HubSpot / Dynamics). Status
  // pushes via `crm-status:changed`.
  ipcMain.handle("crm:list", (): CrmStatus[] => crmManager.getAllStatuses());

  ipcMain.handle(
    "crm:getStatus",
    (_e, provider: CrmProvider): CrmStatus => crmManager.getStatus(provider),
  );

  ipcMain.handle(
    "crm:connect",
    async (_e, args: { provider: CrmProvider; orgUrl?: string }) => {
      await crmManager.connect(args.provider, { orgUrl: args.orgUrl });
      return crmManager.getStatus(args.provider);
    },
  );

  ipcMain.handle(
    "crm:disconnect",
    async (_e, provider: CrmProvider): Promise<CrmStatus> => {
      await crmManager.disconnect(provider);
      return crmManager.getStatus(provider);
    },
  );

  // v0.1.153 — see CrmManager.getExternalUrl rationale.
  ipcMain.handle(
    "crm:getExternalUrl",
    (
      _e,
      args: { provider: CrmProvider; externalId: string },
    ): Promise<string | null> =>
      crmManager.getExternalUrl(args.provider, args.externalId),
  );

  // Workstream C4 — CRM linkage UI surface.
  //
  // `crm:list:links`    → thin pass-through over GET /v1/companies/:id/crm
  // `crm:details:fetch` → thin pass-through over GET /v1/companies/:id/crm/details
  // `crm:enrich:run`    → on-device HubSpot fetch + POST to /crm/cache
  // `crm:hubspot:searchCompanies` / `crm:linkManually` → manual-link picker.
  ipcMain.handle(
    "crm:list:links",
    async (
      _e,
      args: { companyId: string },
    ): Promise<unknown> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) throw new Error("nicht angemeldet");
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`gateway ${res.status} ${body.slice(0, 200)}`);
      }
      return res.json();
    },
  );

  ipcMain.handle(
    "crm:details:fetch",
    async (
      _e,
      args: { companyId: string; refresh?: boolean },
    ): Promise<unknown> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) throw new Error("nicht angemeldet");
      const qs = args.refresh ? "?refresh=true" : "?refresh=false";
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm/details${qs}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`gateway ${res.status} ${body.slice(0, 200)}`);
      }
      return res.json();
    },
  );

  ipcMain.handle(
    "crm:enrich:run",
    async (
      _e,
      args: {
        companyId: string;
        crmExternalId: string;
        crmType?: CrmProvider;
      },
    ) => {
      return runCrmEnrichment(crmManager, args, {
        gatewayUrl: GATEWAY_URL,
        getBearer: () => auth.getAccessToken(),
      });
    },
  );

  ipcMain.handle(
    "crm:hubspot:searchCompanies",
    async (_e, args: { query: string; limit?: number }) => {
      try {
        return await searchHubspotCompanies(crmManager, args);
      } catch (err) {
        return {
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "crm:linkManually",
    async (
      _e,
      args: {
        companyId: string;
        crmType: "HUBSPOT" | "SALESFORCE" | "DYNAMICS";
        crmExternalId: string;
        crmDisplayName?: string | null;
      },
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const bearer = await auth.getAccessToken();
      if (!bearer) return { ok: false, error: "nicht angemeldet" };
      const url = `${GATEWAY_URL.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm/links`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          crmType: args.crmType,
          crmExternalId: args.crmExternalId,
          crmDisplayName: args.crmDisplayName ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ok: false,
          error: `gateway ${res.status} ${body.slice(0, 200)}`,
        };
      }
      return { ok: true };
    },
  );
}
