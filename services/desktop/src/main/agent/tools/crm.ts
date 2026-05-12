// v0.1.54 — CRM agent tools.
//
// Three tools that mirror the Settings panel surface:
//   - crm_status:       read connection state for one or all providers
//   - connect_crm:      run the OAuth flow for a provider (interactive)
//   - disconnect_crm:   forget tokens for a provider
//
// The agent uses these when the user says things like "verbinde mein
// Salesforce-Konto" or "wer ist gerade als HubSpot-User verbunden".
// The Settings UI offers the same actions via direct button clicks
// (window.api.crm.*) — both paths land in the same CrmManager.
//
// Token plumbing happens entirely inside the main process. The chat
// LLM never sees access tokens; tools return only metadata.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { GatewayClient } from "../gateway-client";
import type { CrmManager } from "../../crm";
import type { CrmProvider } from "../../crm/types";
import {
  runCrmEnrichment,
  searchHubspotCompanies,
} from "../../crm/fetch-enrichment";

const PROVIDERS: readonly CrmProvider[] = ["salesforce", "hubspot", "dynamics"];

const PROVIDER_LABELS: Record<CrmProvider, string> = {
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  dynamics: "Microsoft Dynamics 365",
};

export interface CrmToolDeps {
  crm: CrmManager;
  gateway: GatewayClient;
  /** Used by `crm_enrich_now` to authenticate the gateway cache POST.
   *  Same source as `auth.getAccessToken()` in main/index.ts. */
  getBearer: () => Promise<string | null>;
  /** Used by `crm_enrich_now` to address the gateway cache endpoint.
   *  Same source as `GATEWAY_URL` in main/index.ts. */
  gatewayUrl: string;
}

const CRM_LINK_TYPES = ["HUBSPOT", "SALESFORCE", "DYNAMICS"] as const;
type CrmLinkType = (typeof CRM_LINK_TYPES)[number];

export function buildCrmTools(deps: CrmToolDeps): Tool[] {
  const { crm, gateway, getBearer, gatewayUrl } = deps;

  const statusTool = defineTool({
    name: "crm_status",
    description:
      "Read CRM connection status. Without `provider`, returns the status of all supported CRMs (Salesforce, HubSpot, Microsoft Dynamics 365). Includes connected account label and last refresh timestamp; never returns tokens.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...PROVIDERS],
          description: "Optional provider filter.",
        },
      },
    },
    schema: yup.object({
      provider: yup.string().oneOf([...PROVIDERS]).optional(),
    }),
    run: async (args) => {
      if (args.provider) {
        return { statuses: [crm.getStatus(args.provider as CrmProvider)] };
      }
      return { statuses: crm.getAllStatuses() };
    },
    preview: (r) =>
      r.statuses
        .map(
          (s) =>
            `${PROVIDER_LABELS[s.provider]}: ${
              s.connected ? `connected (${s.account ?? "?"})` : "not connected"
            }`,
        )
        .join(" · "),
  });

  const connectTool = defineTool({
    name: "connect_crm",
    description:
      "Startet den interaktiven OAuth-Flow für ein CRM. Öffnet den System-Browser zur Login-Seite des Anbieters und wartet auf die Weiterleitung. AKTUELL VERFÜGBAR: nur HubSpot. Salesforce und Microsoft Dynamics 365 sind als Optionen sichtbar, aber für Nutzer noch gesperrt (\"Demnächst verfügbar\"); der Tool-Call lehnt sie mit einer klaren Meldung ab. Nach erfolgreicher HubSpot-Verbindung kann der Nutzer mit `import_companies_from_crm` direkt importieren oder einzelne AVA-Firmen via `crm_link_manual` an CRM-Datensätze knüpfen.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...PROVIDERS],
          description: "Welches CRM verbunden werden soll.",
        },
        orgUrl: {
          type: "string",
          description:
            "Microsoft Dynamics Org-URL (Host oder vollständige URL). Pflicht für Dynamics, sonst ignoriert.",
        },
      },
      required: ["provider"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...PROVIDERS]).required(),
      orgUrl: yup.string().trim().optional(),
    }),
    run: async (args) => {
      const provider = args.provider as CrmProvider;
      // v0.1.158 — Salesforce + Dynamics sind in der UI gegen einen
      // "Demnächst verfügbar"-Button getauscht. Wir lehnen den
      // Tool-Call hier symmetrisch ab, damit der Agent nicht über
      // den Chat-Pfad eine OAuth-Session auslöst, die der Renderer
      // aus gutem Grund nicht anbietet (operatorseitige OAuth-App
      // ist noch nicht registriert + getestet).
      if (provider === "salesforce" || provider === "dynamics") {
        throw new Error(
          `${PROVIDER_LABELS[provider]} ist noch nicht freigeschaltet. Heute funktioniert nur HubSpot; ${PROVIDER_LABELS[provider]} folgt in den nächsten Wochen. Bitte den Nutzer kurz informieren und HubSpot als sofort verfügbare Alternative anbieten.`,
        );
      }
      try {
        await crm.connect(provider, { orgUrl: args.orgUrl });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Operatorseitig fehlende OAuth-App registriert in der
        // upstream-Antwort ein 503 / "not configured". Übersetz das
        // für den Nutzer in eine handlungsleitende Empfehlung statt
        // den rohen Gateway-Fehler durchzureichen.
        const notConfigured =
          /not.{0,3}configured|nicht.{0,3}eingerichtet|503/i.test(msg);
        if (notConfigured && provider !== "hubspot") {
          throw new Error(
            `${PROVIDER_LABELS[provider]} ist noch nicht freigeschaltet. Heute funktioniert nur HubSpot. Sobald ${PROVIDER_LABELS[provider]} aktiviert ist, probier es bitte erneut.`,
          );
        }
        throw err;
      }
      return crm.getStatus(provider);
    },
    preview: (r) =>
      r.connected
        ? `${PROVIDER_LABELS[r.provider]} verbunden als ${r.account ?? "?"}`
        : `${PROVIDER_LABELS[r.provider]}: ${r.lastError ?? "Verbindung fehlgeschlagen"}`,
  });

  const disconnectTool = defineTool({
    name: "disconnect_crm",
    description:
      "Verwirft die OAuth-Tokens für einen CRM-Anbieter. Bestehende CompanyCrmLink-Einträge bleiben erhalten (nur das Token wird vergessen); der Nutzer kann sich später via `connect_crm` oder im Settings-Panel wieder anmelden.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...PROVIDERS],
          description: "Which CRM to disconnect.",
        },
      },
      required: ["provider"],
    },
    schema: yup.object({
      provider: yup.string().oneOf([...PROVIDERS]).required(),
    }),
    run: async (args) => {
      const provider = args.provider as CrmProvider;
      await crm.disconnect(provider);
      return crm.getStatus(provider);
    },
    preview: (r) => `${PROVIDER_LABELS[r.provider]} disconnected`,
  });

  // ---- Phase T1 — CRM linkage tools (C4) -------------------------------
  //
  // Six additional tools that mirror the manual-link picker dialog and
  // the enrichment surface so the agent can drive end-to-end CRM
  // management from chat:
  //   - crm_list_links_for_company
  //   - crm_fetch_details_raw
  //   - crm_enrich_now
  //   - crm_search_hubspot_companies
  //   - crm_link_manual

  const listLinksTool = defineTool({
    name: "crm_list_links_for_company",
    description:
      "Listet alle CRM-Verknüpfungen einer AVA-Firma auf (CRM-Typ, externe ID, Anzeigename). " +
      "Nutze das Tool, wenn der Nutzer wissen will, mit welchen CRM-Einträgen eine Firma " +
      "verbunden ist. Liefert eine leere Liste, wenn keine Verknüpfung existiert.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "AVA Master-Data companyId." },
      },
      required: ["companyId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
    }),
    run: async (args, c) =>
      gateway.request<{
        links: Array<{
          crmType: string;
          crmExternalId: string;
          crmDisplayName: string | null;
        }>;
      }>(`/v1/companies/${encodeURIComponent(args.companyId)}/crm`, {
        signal: c.signal,
      }),
    preview: (r) => {
      const links = r.links ?? [];
      if (links.length === 0) return "keine CRM-Verknüpfung";
      return links
        .map((l) => `${l.crmType}: ${l.crmDisplayName ?? l.crmExternalId}`)
        .join(" · ");
    },
  });

  const fetchDetailsRawTool = defineTool({
    name: "crm_fetch_details_raw",
    description:
      "Liefert den vollständigen, ungekürzten CRM-Anreicherungs-Payload für eine Firma " +
      "(alle Felder, alle Kontakte, alle Deals, alle Notizen). Anders als `company_crm_summary` " +
      "ist hier nichts gefiltert. Verwende das Tool, wenn der Nutzer ein konkretes Feld " +
      "abruft, das in der Übersicht fehlt. Mit `refresh: true` wird der Cache ignoriert und " +
      "ein frischer Fetch ausgelöst (Quota-relevant).",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "AVA Master-Data companyId." },
        refresh: {
          type: "boolean",
          description: "true = Cache ignorieren und neu beim CRM anfragen. Default false.",
        },
      },
      required: ["companyId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      refresh: yup.boolean().optional(),
    }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/crm/details`,
        {
          query: { refresh: args.refresh ? "true" : "false" },
          signal: c.signal,
        },
      ),
    preview: (r) => {
      const details = (r as { details?: unknown[] }).details ?? [];
      return `${details.length} CRM-Eintrag/Einträge`;
    },
  });

  const enrichNowTool = defineTool({
    name: "crm_enrich_now",
    description:
      "Stößt eine sofortige Anreicherung der CRM-Daten für eine bereits verknüpfte Firma an " +
      "(aktuell nur HubSpot). Verwende das Tool, wenn der Nutzer 'jetzt aus dem CRM neu laden' " +
      "oder 'Daten aktualisieren' verlangt. Setzt voraus, dass HubSpot verbunden ist und " +
      "eine bestehende Verknüpfung existiert. Liefert einen freundlichen Fehler, wenn HubSpot " +
      "nicht verbunden ist.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "AVA Master-Data companyId." },
        crmExternalId: {
          type: "string",
          description:
            "ID des Datensatzes im CRM (z. B. HubSpot Company ID). Aus `crm_list_links_for_company` ablesbar.",
        },
        crmType: {
          type: "string",
          enum: [...PROVIDERS],
          description: "CRM-Typ. Default: hubspot.",
        },
      },
      required: ["companyId", "crmExternalId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      crmExternalId: yup.string().trim().min(1).required(),
      crmType: yup.string().oneOf([...PROVIDERS]).optional(),
    }),
    run: async (args) => {
      const status = crm.getStatus((args.crmType as CrmProvider) ?? "hubspot");
      if (!status.connected) {
        return {
          ok: false as const,
          error:
            "Du bist nicht verbunden. Soll ich das Verbindungsfenster öffnen? " +
            "Verwende dafür das Tool `connect_crm`.",
        };
      }
      return await runCrmEnrichment(
        crm,
        {
          companyId: args.companyId,
          crmExternalId: args.crmExternalId,
          crmType: args.crmType as CrmProvider | undefined,
        },
        { gatewayUrl, getBearer },
      );
    },
    preview: (r) => {
      if ((r as { ok: boolean }).ok === false)
        return `Anreicherung fehlgeschlagen: ${(r as { error?: string }).error ?? "unbekannter Fehler"}`;
      return "CRM-Anreicherung gestartet";
    },
  });

  const searchHubspotTool = defineTool({
    name: "crm_search_hubspot_companies",
    description:
      "Sucht in HubSpot nach Firmen anhand eines Stichworts (z. B. Name oder Domain). " +
      "Liefert bis zu `limit` Kandidaten mit id, name, domain, city zurück, nützlich, " +
      "um vor `crm_link_manual` den richtigen HubSpot-Datensatz zu finden. Setzt voraus, " +
      "dass HubSpot verbunden ist.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Suchbegriff (Name oder Domain)." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 25,
          description: "Maximale Treffer (1 bis 100).",
        },
      },
      required: ["query"],
    },
    schema: yup.object({
      query: yup.string().trim().min(1).required(),
      limit: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      const status = crm.getStatus("hubspot");
      if (!status.connected) {
        return {
          items: [],
          error:
            "Du bist nicht verbunden. Soll ich das Verbindungsfenster öffnen? " +
            "Verwende dafür das Tool `connect_crm`.",
        };
      }
      try {
        return await searchHubspotCompanies(crm, args);
      } catch (err) {
        return {
          items: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) => {
      const items = r.items ?? [];
      if (items.length === 0 && (r as { error?: string }).error)
        return `Suche fehlgeschlagen: ${(r as { error?: string }).error}`;
      return `${items.length} HubSpot-Treffer`;
    },
  });

  const linkManualTool = defineTool({
    name: "crm_link_manual",
    description:
      "Verknüpft eine AVA-Firma manuell mit einem CRM-Datensatz, z. B. wenn der Nutzer " +
      "sagt 'verknüpfe ACME mit HubSpot 12345'. Anzeigename ist optional, hilft aber " +
      "bei späterer Identifikation. Setzt voraus, dass die Verknüpfung im CRM existiert " +
      "(prüfe ggf. vorher mit `crm_search_hubspot_companies`).",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "AVA Master-Data companyId." },
        crmType: {
          type: "string",
          enum: [...CRM_LINK_TYPES],
          description: "CRM-Typ (HUBSPOT, SALESFORCE, DYNAMICS).",
        },
        crmExternalId: {
          type: "string",
          description: "ID des Datensatzes im CRM.",
        },
        crmDisplayName: {
          type: "string",
          description: "Anzeigename des CRM-Datensatzes (optional).",
        },
      },
      required: ["companyId", "crmType", "crmExternalId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      crmType: yup.string().oneOf([...CRM_LINK_TYPES]).required(),
      crmExternalId: yup.string().trim().min(1).required(),
      crmDisplayName: yup.string().trim().optional(),
    }),
    run: async (args, c) => {
      try {
        await gateway.request(
          `/v1/companies/${encodeURIComponent(args.companyId)}/crm/links`,
          {
            method: "POST",
            body: {
              crmType: args.crmType as CrmLinkType,
              crmExternalId: args.crmExternalId,
              crmDisplayName: args.crmDisplayName ?? null,
            },
            signal: c.signal,
          },
        );
        return { ok: true as const };
      } catch (err) {
        return {
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? "CRM-Verknüpfung angelegt"
        : `Verknüpfung fehlgeschlagen: ${(r as { error?: string }).error ?? "?"}`,
  });

  return [
    statusTool,
    connectTool,
    disconnectTool,
    listLinksTool,
    fetchDetailsRawTool,
    enrichNowTool,
    searchHubspotTool,
    linkManualTool,
  ];
}
