// Ereignisse fremder Dienste (docs/PLAN_CLOSE_MCP.md, C4): was ueber den
// Rueckkanal (Webhook) hereinkam, z. B. "Lead hat geantwortet" aus CompLeadly.
// Lesend; auf Wunsch als gelesen markieren. Ohne Rueckkanal holt AVA den Stand
// ueber die Werkzeuge des Dienstes (mcp_<dienst>_…).

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

export interface Ereignis {
  id: string;
  dienst: string;
  typ: string | null;
  nutzlast: unknown;
  personId?: string | null;
  companyId?: string | null;
  empfangenAt: string;
  gelesenAt: string | null;
}

/** Kurzfassung je Ereignis fuer das Modell: Typ, Name, Firma, Position, LinkedIn-Adresse, Workflow. */
export function ereignisKurz(e: Ereignis): Record<string, unknown> {
  const n = (e.nutzlast && typeof e.nutzlast === "object" ? e.nutzlast : {}) as Record<string, unknown>;
  const lead = (n.leadData && typeof n.leadData === "object" ? n.leadData : n.lead && typeof n.lead === "object" ? n.lead : {}) as Record<string, unknown>;
  const feld = (k: string): string | undefined => {
    const v = lead[k] ?? n[k];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
  };
  return {
    id: e.id,
    dienst: e.dienst,
    typ: e.typ,
    empfangen: e.empfangenAt,
    gelesen: Boolean(e.gelesenAt),
    ...(e.companyId ? { companyId: e.companyId } : {}),
    ...(e.personId ? { personId: e.personId } : {}),
    ...(feld("name") ? { name: feld("name") } : {}),
    ...(feld("company") ? { firma: feld("company") } : {}),
    ...(feld("position") ? { position: feld("position") } : {}),
    ...(feld("linkedinUrl") ?? feld("linkedin_url") ?? feld("profileUrl") ? { linkedin: feld("linkedinUrl") ?? feld("linkedin_url") ?? feld("profileUrl") } : {}),
    ...(feld("email") ? { email: feld("email") } : {}),
    ...(feld("workflowName") ? { workflow: feld("workflowName") } : {}),
    ...(feld("message") ?? feld("text") ? { text: (feld("message") ?? feld("text") ?? "").slice(0, 600) } : {}),
  };
}

export function buildDiensteTools(ctx: { gateway: GatewayClient }): Tool[] {
  const ereignisse = defineTool({
    name: "dienst_ereignisse",
    summary: "Ereignisse verbundener Dienste (Rückkanal), z. B. 'Lead hat geantwortet' aus CompLeadly; neueste zuerst",
    category: "dienste",
    description:
      "Liest Ereignisse, die verbundene Dienste über ihren Rückkanal an AVA gemeldet haben (z. B. CompLeadly: Kontaktanfrage angenommen, Lead hat geantwortet, Nachricht gesendet). " +
      "Neueste zuerst, je Ereignis Typ, Name, Firma, Position, LinkedIn-Adresse und Zeit; companyId/personId, wenn die LinkedIn-Adresse einer Person im Bestand zugeordnet werden konnte (dann als [Name](company:<id>) verlinken); die Rohdaten stehen in `nutzlast`. " +
      "Ist für einen Dienst kein Rückkanal eingerichtet (kommt nichts an), den Stand über die Werkzeuge des Dienstes holen (mcp_<dienst>_…). " +
      "Mit gelesenMarkieren=true gelten die gelieferten Ereignisse danach als erledigt.",
    parameters: {
      type: "object",
      properties: {
        dienst: { type: "string", description: "Nur dieser Dienst (Kurzname, z. B. compleadly)" },
        seit: { type: "string", description: "Nur Ereignisse nach diesem Zeitpunkt (ISO-8601)" },
        nurUngelesen: { type: "boolean", description: "Nur noch nicht als gelesen markierte Ereignisse" },
        limit: { type: "integer", description: "Anzahl, Standard 20, höchstens 200" },
        gelesenMarkieren: { type: "boolean", description: "Gelieferte Ereignisse als gelesen markieren" },
        mitRohdaten: { type: "boolean", description: "Rohdaten (nutzlast) mitliefern; Standard nein" },
      },
    },
    schema: yup.object({
      dienst: yup.string().trim().max(60).optional(),
      seit: yup.string().trim().optional(),
      nurUngelesen: yup.boolean().optional(),
      limit: yup.number().integer().min(1).max(200).optional(),
      gelesenMarkieren: yup.boolean().optional(),
      mitRohdaten: yup.boolean().optional(),
    }),
    run: async (args, c) => {
      const r = await ctx.gateway.request<{ ereignisse: Ereignis[] }>("/v1/dienste/ereignisse", {
        query: {
          ...(args.dienst ? { dienst: args.dienst } : {}),
          ...(args.seit ? { seit: new Date(args.seit).toISOString() } : {}),
          ...(args.nurUngelesen ? { ungelesen: "1" } : {}),
          limit: String(args.limit ?? 20),
        },
        signal: c.signal,
      });
      const liste = r.ereignisse ?? [];
      if (args.gelesenMarkieren && liste.length > 0) {
        await ctx.gateway.request("/v1/dienste/ereignisse/gelesen", { method: "POST", body: { ids: liste.map((e) => e.id) }, signal: c.signal }).catch(() => undefined);
      }
      return {
        anzahl: liste.length,
        ereignisse: liste.map((e) => ({ ...ereignisKurz(e), ...(args.mitRohdaten ? { nutzlast: e.nutzlast } : {}) })),
        ...(liste.length === 0 ? { hinweis: "Keine Ereignisse. Entweder ist kein Rückkanal eingerichtet (Einstellungen → Verbindungen → Weitere Dienste) oder es ist nichts passiert; der Stand lässt sich über die Werkzeuge des Dienstes abfragen." } : {}),
      };
    },
    preview: (r) => `${r.anzahl} Ereignisse`,
  });
  return [ereignisse];
}
