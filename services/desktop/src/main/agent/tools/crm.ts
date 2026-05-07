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
import type { CrmManager } from "../../crm";
import type { CrmProvider } from "../../crm/types";

const PROVIDERS: readonly CrmProvider[] = ["salesforce", "hubspot", "dynamics"];

const PROVIDER_LABELS: Record<CrmProvider, string> = {
  salesforce: "Salesforce",
  hubspot: "HubSpot",
  dynamics: "Microsoft Dynamics 365",
};

export interface CrmToolDeps {
  crm: CrmManager;
}

export function buildCrmTools(deps: CrmToolDeps): Tool[] {
  const { crm } = deps;

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
      "Start the interactive OAuth flow to connect a CRM. Opens the system browser to the provider's login page and waits for the redirect. Microsoft Dynamics requires `orgUrl` (e.g. 'contoso.crm4.dynamics.com'). The user must complete sign-in in the browser; this tool resolves once tokens are persisted.",
    parameters: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: [...PROVIDERS],
          description: "Which CRM to connect.",
        },
        orgUrl: {
          type: "string",
          description:
            "Microsoft Dynamics org URL (host or full URL). Required for Dynamics; ignored otherwise.",
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
      if (provider === "dynamics" && !args.orgUrl) {
        throw new Error(
          "Microsoft Dynamics 365 benötigt eine Org-URL (z. B. contoso.crm4.dynamics.com).",
        );
      }
      await crm.connect(provider, { orgUrl: args.orgUrl });
      return crm.getStatus(provider);
    },
    preview: (r) =>
      r.connected
        ? `connected ${PROVIDER_LABELS[r.provider]} as ${r.account ?? "?"}`
        : `${PROVIDER_LABELS[r.provider]}: ${r.lastError ?? "connection failed"}`,
  });

  const disconnectTool = defineTool({
    name: "disconnect_crm",
    description:
      "Forget OAuth tokens for a CRM provider. The user can re-connect later via `connect_crm` or the Settings panel.",
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

  return [statusTool, connectTool, disconnectTool];
}
