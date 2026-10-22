// IPC „LinkedIn-Leads“ (docs/PLAN_LINKEDIN_LEADS.md L3/L4): duenne Huelle um die
// Gateway-Logik in linkedin/leads-uebernahme.ts (gleiche Logik wie die Chat-Werkzeuge).

import { ipcMain } from "electron";
import type { AuditEventInput } from "../audit/audit-types";
import type { GatewayClient } from "../agent/gateway-client";
import { gwVon, kontaktNachholen, leadIgnorieren, leadUebernehmen, leadZuruecknehmen, leadsListe } from "../linkedin/leads-uebernahme";

export interface LeadsIpcDeps {
  audit: (input: AuditEventInput) => void;
  gatewayClient: GatewayClient;
}

export function registerLeadsIpc(deps: LeadsIpcDeps): void {
  const { audit } = deps;
  const gw = gwVon(deps.gatewayClient);

  ipcMain.handle("leads:list", (_e, q: { status?: string; postUrl?: string; nurKommentare?: boolean; seite?: number; groesse?: number }) => leadsListe(gw, q ?? {}));

  ipcMain.handle("leads:posts", () => gw<{ posts: unknown[] }>("/v1/linkedin-leads/posts"));

  ipcMain.handle("leads:ignorieren", async (_e, args: { id: string; grund?: string | null }) => {
    const r = await leadIgnorieren(gw, args.id, args.grund ?? null);
    audit({ actorType: "user", actorId: null, category: "linkedin", action: "linkedin.lead.ignoriert", severity: "info", subjectType: "person", subjectId: null, summary: `LinkedIn-Lead ignoriert: ${r.personName ?? args.id}${args.grund ? ` (${args.grund})` : ""}`, metadata: { grund: args.grund ?? null } });
    return r;
  });

  ipcMain.handle("leads:zuruecknehmen", (_e, args: { id: string }) => leadZuruecknehmen(gw, args.id));

  ipcMain.handle("leads:kontaktNachholen", (_e, args: { id: string }) => kontaktNachholen(gw, args.id));

  ipcMain.handle("leads:uebernehmen", async (_e, args: { id: string }) => {
    const r = await leadUebernehmen(gw, args.id);
    if (r.ok) {
      audit({ actorType: "user", actorId: null, category: "linkedin", action: "linkedin.lead.uebernommen", severity: "info", subjectType: "company", subjectId: r.companyId ?? null, summary: `LinkedIn-Lead übernommen → ${r.companyId}`, metadata: { leadId: args.id, personId: r.personId, transactionId: r.transactionId } });
    }
    return r;
  });
}
