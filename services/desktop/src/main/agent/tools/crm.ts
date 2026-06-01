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
import {
  introspectHubspotObject,
  updateHubspotObject,
  searchHubspotContacts,
  searchHubspotDeals,
  listHubspotOwners,
  listHubspotAssociations,
  associateHubspotObjects,
  disassociateHubspotObjects,
  createHubspotObject,
  deleteHubspotObject,
  previewHubspotObject,
  listHubspotTasks,
  listHubspotNotesForObject,
  type HubspotObjectType,
} from "../../crm/write-objects";

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

// v0.1.285 — Modul-Scope, weil buildIntrospectUpdate die Map im
// Template-String referenziert und mehrfach VOR der Deklaration der
// inneren Const (so wie sie in v0.1.283 platziert war) aufgerufen
// wurde. TDZ-Crash beim App-Start in v0.1.284 ("Cannot access
// 'SINGULAR' before initialization"). Jetzt sicher zugänglich für
// alle Aufrufer.
const SINGULAR: Record<HubspotObjectType, string> = {
  companies: "company",
  contacts: "contact",
  deals: "deal",
  notes: "note",
  tasks: "task",
};

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
      // v0.1.278 — Confirm-Gate dazu (User-Wunsch: alle Writes bestätigen).
      const value = await c.ui.askChoice(
        `Soll ich folgende CRM-Verknüpfung anlegen?\n\nAVA-Firma: ${args.companyId}\n↔ ${args.crmType} ${args.crmExternalId}${args.crmDisplayName ? ` (${args.crmDisplayName})` : ""}`,
        [
          { value: "link", label: "Verknüpfen", description: "POST wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        c.signal,
      );
      if (value !== "link") return { applied: false as const };
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
        return { applied: true as const, ok: true as const };
      } catch (err) {
        return {
          applied: true as const,
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      !r.applied
        ? "Verknüpfung verworfen"
        : r.ok
          ? "CRM-Verknüpfung angelegt"
          : `Verknüpfung fehlgeschlagen: ${(r as { error?: string }).error ?? "?"}`,
  });

  // v0.1.263 — HubSpot Company-Write-Tools (Phase H). Analog zu den
  // Notion-CRM-Update-Tools v0.1.244+ — introspect zuerst, dann update
  // mit propose-and-confirm + Fresh-GET-Verify gegen No-Ops.
  const introspectHubspotTool = defineTool({
    name: "crm_introspect_hubspot_company",
    description:
      "Liest das Property-Schema einer HubSpot-Company UND die aktuellen Werte. Nutze das als STEP 2 vor `crm_update_hubspot_company`, sobald du via `crm_list_links_for_company` oder `crm_search_hubspot_companies` die HubSpot-companyId hast. Returned: für jedes editierbare Feld den Property-Namen, Label, Type (string/number/date/enumeration/bool), enum-Optionen (wenn enumeration), die Beschreibung und den aktuell gespeicherten Wert. Read-only-Felder (hs_object_id, calculated etc.) sind rausgefiltert. Wähle aus der Liste das Feld(er), das der Nutzer ändern will, mappe ggf. Label→value bei Enum-Feldern und übergib das Map an `crm_update_hubspot_company`.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: {
          type: "string",
          description:
            "HubSpot-companyId (NICHT die AVA-Master-Data-companyId). Aus `crm_list_links_for_company` oder `crm_search_hubspot_companies`.",
        },
      },
    },
    schema: yup
      .object({ companyId: yup.string().trim().min(1).required() })
      .noUnknown(true),
    preview: (r: { schema: unknown[]; companyId: string }) =>
      `HubSpot ${r.companyId}: ${r.schema.length} editierbare Felder`,
    run: async (args) => {
      const result = await introspectHubspotObject(crm, "companies", args.companyId);
      return { ...result, companyId: args.companyId };
    },
  });

  const updateHubspotTool = defineTool({
    name: "crm_update_hubspot_company",
    description:
      "Aktualisiert eine oder mehrere Properties einer HubSpot-Company. PFLICHT: vorher `crm_introspect_hubspot_company` aufrufen, um Property-Namen + Typen + Enum-Optionen zu kennen. PROPOSE-AND-CONFIRM: das Tool zeigt dem Nutzer den geplanten Diff (Vorher → Nachher) via ask_user_choice; nur bei Confirm geht der PATCH ans HubSpot-API.\n\nNach dem PATCH macht das Tool einen Fresh-GET zur Verifikation: HubSpot kann (wie Notion) HTTP 200 zurückgeben, ohne den Wert wirklich zu speichern (z. B. wenn das Pipeline-Stage zur Lifecycle-Stage nicht passt oder ein Validation-Workflow zugreift). In dem Fall wird das Tool mit `ok: false` und der Liste betroffener Properties returned — verwerfen NICHT.\n\nProperty-Namen sind die HubSpot-internen Namen (`industry`, `lifecyclestage`, NICHT 'Industry'/'Lifecycle Stage'). Bei enum-Feldern den `value` aus den Schema-Optionen verwenden, nicht das `label`. Empty-String löscht das Feld.",
    parameters: {
      type: "object",
      required: ["companyId", "properties"],
      properties: {
        companyId: {
          type: "string",
          description: "HubSpot-companyId.",
        },
        properties: {
          type: "object",
          description:
            "Property-Name → neuer Wert (alles Strings; HubSpot konvertiert intern). Beispiel: {\"lifecyclestage\": \"customer\", \"industry\": \"MANUFACTURING\"}.",
          additionalProperties: { type: "string" },
        },
        rationale: {
          type: "string",
          description:
            "Kurze Begründung (1 Satz), warum diese Änderung — wird dem Nutzer im Confirm-Dialog gezeigt.",
        },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        // v0.1.320 — `yup.object()` ohne `.shape({...})` wird vom globalen
        // `stripUnknown: true` (siehe define-tool.ts) leergeräumt — yup
        // sieht keine bekannten Keys, also strippt es alle. Ergebnis: {}.
        // Der Folge-`.test("at-least-one")` schlug dann immer fehl, auch
        // wenn der Agent korrekt Properties mitschickte. Mit `yup.mixed`
        // ist die Open-Map-Semantik korrekt. Validation prüft manuell.
        // v0.1.323 — `.transform()` ergänzt: wenn der LLM `properties`
        // als JSON-String schickt (passiert mit Claude/Anthropic
        // gelegentlich), wird es vor den Tests geparst. Der zentrale
        // tool-arg-normalizer kann das nicht, weil er bei `mixed`-Schemas
        // bewusst nicht eingreift.
        properties: yup
          .mixed<Record<string, string>>()
          .transform((v) => {
            if (typeof v === "string") {
              const trimmed = v.trim();
              if (trimmed.startsWith("{")) {
                try {
                  return JSON.parse(trimmed);
                } catch {
                  /* keep as-is so test produces the right error */
                }
              }
            }
            return v;
          })
          .test("is-object", "properties muss ein Objekt sein", (v) =>
            v != null && typeof v === "object" && !Array.isArray(v),
          )
          .test("at-least-one", "Mindestens eine Property setzen.", (v) =>
            v != null && Object.keys(v as Record<string, unknown>).length > 0,
          )
          .required(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; ok?: boolean; notApplied?: string[] }) =>
      !r.applied
        ? "Update verworfen"
        : r.ok
          ? "HubSpot aktualisiert"
          : `Teilweise nicht übernommen: ${(r.notApplied ?? []).join(", ")}`,
    run: async (args, ctx) => {
      // Erst Introspect+Aktuelle-Werte holen, damit der Diff im
      // Confirm-Dialog sinnvoll ist.
      const intro = await introspectHubspotObject(crm, "companies", args.companyId);
      const schemaByName = new Map(intro.schema.map((p) => [p.name, p]));
      const draftLines: string[] = [];
      for (const [name, newVal] of Object.entries(args.properties)) {
        const schema = schemaByName.get(name);
        const current = intro.currentValues[name] ?? null;
        const label = schema?.label ?? name;
        const newDisplay =
          schema?.type === "enumeration"
            ? (schema.options.find((o) => o.value === newVal)?.label ?? newVal)
            : newVal;
        const oldDisplay =
          schema?.type === "enumeration"
            ? (schema.options.find((o) => o.value === current)?.label ??
              current ??
              "(leer)")
            : (current ?? "(leer)");
        draftLines.push(`  ${label} (${name}): ${oldDisplay} → ${newDisplay}`);
      }
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Ich möchte folgende Änderungen in HubSpot vornehmen (Company ${args.companyId}):\n\n${draftLines.join("\n")}${rationaleBlock}`,
        [
          {
            value: "apply",
            label: "Übernehmen",
            description: "PATCH wird an HubSpot gesendet",
          },
          {
            value: "cancel",
            label: "Verwerfen",
            description: "Nichts ändert sich",
          },
        ],
        ctx.signal,
      );
      if (value !== "apply") return { applied: false };

      const result = await updateHubspotObject(crm, {
        objectType: "companies",
        objectId: args.companyId,
        properties: args.properties as Record<string, string>,
      });
      return {
        applied: true,
        ok: result.ok,
        diff: result.diff,
        notApplied: result.notApplied,
      };
    },
  });

  // v0.1.264 — Contact + Deal Updates analog Company (Phase H, Iteration 2).
  // Eine Helper-Funktion baut introspect+update-Paare pro object-type, weil
  // die Tool-Bodies identisch bis auf den objectType-Parameter sind.
  const buildIntrospectUpdate = (
    objectType: HubspotObjectType,
    objectLabel: string,
    idParamHint: string,
  ): { introspect: Tool; update: Tool } => {
    const introspect = defineTool({
      name: `crm_introspect_hubspot_${SINGULAR[objectType]}`,
      description: `Liest das Property-Schema einer HubSpot-${objectLabel} UND die aktuellen Werte. Nutze das vor crm_update_hubspot_${SINGULAR[objectType]}, sobald du die HubSpot-${objectLabel}-ID hast (${idParamHint}). Returned: für jedes editierbare Feld den Property-Namen, Label, Type, enum-Optionen (mit label + value), Beschreibung und aktueller Wert. Read-only/system-Felder sind rausgefiltert.`,
      parameters: {
        type: "object",
        required: ["objectId"],
        properties: {
          objectId: {
            type: "string",
            description: `HubSpot-${objectLabel}-ID. ${idParamHint}`,
          },
        },
      },
      schema: yup
        .object({ objectId: yup.string().trim().min(1).required() })
        .noUnknown(true),
      preview: (r: { schema: unknown[]; objectId: string }) =>
        `HubSpot ${objectLabel} ${r.objectId}: ${r.schema.length} editierbare Felder`,
      run: async (args) => {
        const result = await introspectHubspotObject(crm, objectType, args.objectId);
        return result;
      },
    });

    const update = defineTool({
      name: `crm_update_hubspot_${SINGULAR[objectType]}`,
      description: `Aktualisiert eine oder mehrere Properties einer HubSpot-${objectLabel}. PFLICHT: vorher crm_introspect_hubspot_${SINGULAR[objectType]} aufrufen. PROPOSE-AND-CONFIRM: Tool zeigt Diff via ask_user_choice. Fresh-GET-Verify nach PATCH (HubSpot kann HTTP 200 liefern ohne zu speichern, z. B. bei Workflow-Validation). Property-Namen = HubSpot-interne Namen; bei enums den value statt label.`,
      parameters: {
        type: "object",
        required: ["objectId", "properties"],
        properties: {
          objectId: { type: "string", description: `HubSpot-${objectLabel}-ID.` },
          properties: {
            type: "object",
            description: "Property-Name → neuer Wert (Strings). Empty-String löscht.",
            additionalProperties: { type: "string" },
          },
          rationale: {
            type: "string",
            description: "Begründung (1 Satz) — wird im Confirm-Dialog gezeigt.",
          },
        },
      },
      schema: yup
        .object({
          objectId: yup.string().trim().min(1).required(),
          // v0.1.320 + v0.1.323 — siehe crm_update_hubspot_company.
          properties: yup
            .mixed<Record<string, string>>()
            .transform((v) => {
              if (typeof v === "string") {
                const trimmed = v.trim();
                if (trimmed.startsWith("{")) {
                  try {
                    return JSON.parse(trimmed);
                  } catch {
                    /* keep as-is */
                  }
                }
              }
              return v;
            })
            .test("is-object", "properties muss ein Objekt sein", (v) =>
              v != null && typeof v === "object" && !Array.isArray(v),
            )
            .test("at-least-one", "Mindestens eine Property setzen.", (v) =>
              v != null && Object.keys(v as Record<string, unknown>).length > 0,
            )
            .required(),
          rationale: yup.string().trim().max(500).optional(),
        })
        .noUnknown(true),
      preview: (r: { applied: boolean; ok?: boolean; notApplied?: string[] }) =>
        !r.applied
          ? "Update verworfen"
          : r.ok
            ? `HubSpot ${objectLabel} aktualisiert`
            : `Teilweise nicht übernommen: ${(r.notApplied ?? []).join(", ")}`,
      run: async (args, ctx) => {
        const intro = await introspectHubspotObject(crm, objectType, args.objectId);
        const schemaByName = new Map(intro.schema.map((p) => [p.name, p]));
        const draftLines: string[] = [];
        for (const [name, newVal] of Object.entries(args.properties)) {
          const schema = schemaByName.get(name);
          const current = intro.currentValues[name] ?? null;
          const label = schema?.label ?? name;
          const newDisplay =
            schema?.type === "enumeration"
              ? (schema.options.find((o) => o.value === newVal)?.label ?? newVal)
              : newVal;
          const oldDisplay =
            schema?.type === "enumeration"
              ? (schema.options.find((o) => o.value === current)?.label ??
                current ??
                "(leer)")
              : (current ?? "(leer)");
          draftLines.push(`  ${label} (${name}): ${oldDisplay} → ${newDisplay}`);
        }
        const rationaleBlock = args.rationale
          ? `\n\nBegründung: ${args.rationale}`
          : "";
        const value = await ctx.ui.askChoice(
          `Ich möchte folgende Änderungen in HubSpot vornehmen (${objectLabel} ${args.objectId}):\n\n${draftLines.join("\n")}${rationaleBlock}`,
          [
            { value: "apply", label: "Übernehmen", description: "PATCH wird gesendet" },
            { value: "cancel", label: "Verwerfen" },
          ],
          ctx.signal,
        );
        if (value !== "apply") return { applied: false };

        const result = await updateHubspotObject(crm, {
          objectType,
          objectId: args.objectId,
          properties: args.properties as Record<string, string>,
        });
        return {
          applied: true,
          ok: result.ok,
          diff: result.diff,
          notApplied: result.notApplied,
        };
      },
    });
    return { introspect, update };
  };

  const contactPair = buildIntrospectUpdate(
    "contacts",
    "Contact",
    "ID aus crm_search_hubspot_contacts oder direkt aus HubSpot-URL.",
  );
  const dealPair = buildIntrospectUpdate(
    "deals",
    "Deal",
    "ID aus crm_search_hubspot_deals oder direkt aus HubSpot-URL.",
  );
  // v0.1.266 — Notes + Tasks bekommen denselben introspect+update-Pfad,
  // damit "ändere die Task-Priorität auf HIGH" / "korrigiere den Note-Body"
  // funktioniert. Die Tool-Namen folgen demselben Schema: _note / _task.
  const notePair = buildIntrospectUpdate(
    "notes",
    "Note",
    "noteId aus crm_list_hubspot_notes_for_object oder dem create-Result.",
  );
  const taskPair = buildIntrospectUpdate(
    "tasks",
    "Task",
    "taskId aus crm_list_hubspot_tasks oder dem create-Result.",
  );

  // Search-Tools für Contacts + Deals
  const searchContactsTool = defineTool({
    name: "crm_search_hubspot_contacts",
    description:
      "Sucht HubSpot-Contacts nach Name oder E-Mail-Adresse. Returns bis zu 25 Treffer mit id, firstName, lastName, email, jobTitle, company. Nutze das, um die contactId für crm_update_hubspot_contact aufzulösen.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Name, Vorname, oder E-Mail." },
        limit: { type: "integer", description: "Max Treffer (1-100). Default 25." },
      },
    },
    schema: yup
      .object({
        query: yup.string().trim().min(1).required(),
        limit: yup.number().integer().min(1).max(100).optional(),
      })
      .noUnknown(true),
    preview: (r: { items: { id: string }[] }) => `${r.items.length} Contacts`,
    run: async (args) => searchHubspotContacts(crm, args),
  });

  const searchDealsTool = defineTool({
    name: "crm_search_hubspot_deals",
    description:
      "Sucht HubSpot-Deals nach Name (dealname). Returns bis zu 25 Treffer mit id, name, amount, stage, pipeline, closeDate. Nutze das, um die dealId für crm_update_hubspot_deal aufzulösen.",
    parameters: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Deal-Name (teilweise)." },
        limit: { type: "integer", description: "Max Treffer (1-100). Default 25." },
      },
    },
    schema: yup
      .object({
        query: yup.string().trim().min(1).required(),
        limit: yup.number().integer().min(1).max(100).optional(),
      })
      .noUnknown(true),
    preview: (r: { items: { id: string }[] }) => `${r.items.length} Deals`,
    run: async (args) => searchHubspotDeals(crm, args),
  });

  // Owner-Lookup — Voraussetzung für "Owner ändern auf <Name>"-Workflows
  const listOwnersTool = defineTool({
    name: "crm_list_hubspot_owners",
    description:
      "Listet alle aktiven HubSpot-Owner des Portals (id + email + firstName + lastName). Nutze das, BEVOR du ein hubspot_owner_id-Feld setzen willst — der Nutzer sagt meistens den Namen, HubSpot erwartet die numerische Owner-ID. Mappe Name/E-Mail aus der Liste auf die id.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { length: number }) => `${r.length} HubSpot-Owner`,
    run: async () => {
      const owners = await listHubspotOwners(crm);
      return { length: owners.length, owners };
    },
  });

  // v0.1.265 — Association-Tools (Phase H3). HubSpot v4 Associations:
  // Contact↔Company, Deal↔Company, Contact↔Deal mit default-Typ.
  // Custom-Association-Types sind out-of-scope für V1.
  // v0.1.266: notes + tasks dazu (für Engagement-Listings + Updates).
  const OBJECT_TYPE_VALUES = [
    "companies",
    "contacts",
    "deals",
    "notes",
    "tasks",
  ] as const;
  const ASSOC_TARGET_VALUES = ["companies", "contacts", "deals"] as const;

  // SINGULAR ist auf Modul-Scope hochgezogen (siehe oben in dieser
  // Datei). Vorher lebte es hier im buildCrmTools-Scope, wurde aber
  // von buildIntrospectUpdate vor der Deklaration referenziert →
  // ReferenceError "Cannot access 'SINGULAR' before initialization"
  // beim App-Start (v0.1.283 Crash-Loop).

  const listAssociationsTool = defineTool({
    name: "crm_list_hubspot_associations",
    description:
      "Listet die Verknüpfungen eines HubSpot-Records zu einem anderen Object-Type. Beispiele: alle Contacts einer Company, alle Deals einer Company, alle Deals eines Contacts. Returned: Liste mit toObjectId + association-type-Labels. Read-only — keine Schreibänderung.",
    parameters: {
      type: "object",
      required: ["fromObjectType", "fromObjectId", "toObjectType"],
      properties: {
        fromObjectType: {
          type: "string",
          enum: [...ASSOC_TARGET_VALUES],
          description: "Object-Type des Ausgangs-Records.",
        },
        fromObjectId: { type: "string", description: "HubSpot-ID des Ausgangs-Records." },
        toObjectType: {
          type: "string",
          enum: [...ASSOC_TARGET_VALUES],
          description: "Object-Type der Zielobjekte.",
        },
      },
    },
    schema: yup
      .object({
        fromObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        fromObjectId: yup.string().trim().min(1).required(),
        toObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
      })
      .noUnknown(true),
    preview: (r: { associations: unknown[] }) => `${r.associations.length} Verknüpfungen`,
    run: async (args) =>
      listHubspotAssociations(crm, {
        fromObjectType: args.fromObjectType as HubspotObjectType,
        fromObjectId: args.fromObjectId,
        toObjectType: args.toObjectType as HubspotObjectType,
      }),
  });

  const associateTool = defineTool({
    name: "crm_associate_hubspot_objects",
    description:
      "Verknüpft zwei HubSpot-Records (Contact↔Company, Deal↔Company, Contact↔Deal) mit dem Default-Association-Type. PROPOSE-AND-CONFIRM: zeigt den Nutzer via ask_user_choice was verknüpft werden soll. Idempotent: bestehende Verknüpfung wird nicht doppelt erstellt. Custom-Association-Types werden NICHT unterstützt — V1 setzt immer den default.",
    parameters: {
      type: "object",
      required: ["fromObjectType", "fromObjectId", "toObjectType", "toObjectId"],
      properties: {
        fromObjectType: { type: "string", enum: [...OBJECT_TYPE_VALUES] },
        fromObjectId: { type: "string" },
        toObjectType: { type: "string", enum: [...OBJECT_TYPE_VALUES] },
        toObjectId: { type: "string" },
        rationale: {
          type: "string",
          description: "Begründung (1 Satz) für den Confirm-Dialog.",
        },
      },
    },
    schema: yup
      .object({
        fromObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        fromObjectId: yup.string().trim().min(1).required(),
        toObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        toObjectId: yup.string().trim().min(1).required(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean }) =>
      r.applied ? "Verknüpfung erstellt" : "Verknüpfung verworfen",
    run: async (args, ctx) => {
      const fromLabel = OBJECT_LABEL[args.fromObjectType as HubspotObjectType];
      const toLabel = OBJECT_LABEL[args.toObjectType as HubspotObjectType];
      const rationaleBlock = args.rationale ? `\n\nBegründung: ${args.rationale}` : "";
      const value = await ctx.ui.askChoice(
        `Soll ich folgende Verknüpfung in HubSpot erstellen?\n\n${fromLabel} ${args.fromObjectId}\n↔ ${toLabel} ${args.toObjectId}${rationaleBlock}`,
        [
          { value: "apply", label: "Verknüpfen", description: "PUT wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "apply") return { applied: false };
      await associateHubspotObjects(crm, {
        fromObjectType: args.fromObjectType as HubspotObjectType,
        fromObjectId: args.fromObjectId,
        toObjectType: args.toObjectType as HubspotObjectType,
        toObjectId: args.toObjectId,
      });
      return { applied: true };
    },
  });

  const disassociateTool = defineTool({
    name: "crm_disassociate_hubspot_objects",
    description:
      "Entfernt eine bestehende Verknüpfung zwischen zwei HubSpot-Records. PROPOSE-AND-CONFIRM via ask_user_choice. DESTRUCTIVE: die Records selbst bleiben erhalten, nur die Beziehung wird gelöscht. Wenn die Verknüpfung gar nicht existiert hat, returnt HubSpot 204 OK — Tool meldet trotzdem applied:true.",
    parameters: {
      type: "object",
      required: ["fromObjectType", "fromObjectId", "toObjectType", "toObjectId"],
      properties: {
        fromObjectType: { type: "string", enum: [...OBJECT_TYPE_VALUES] },
        fromObjectId: { type: "string" },
        toObjectType: { type: "string", enum: [...OBJECT_TYPE_VALUES] },
        toObjectId: { type: "string" },
        rationale: { type: "string" },
      },
    },
    schema: yup
      .object({
        fromObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        fromObjectId: yup.string().trim().min(1).required(),
        toObjectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        toObjectId: yup.string().trim().min(1).required(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean }) =>
      r.applied ? "Verknüpfung entfernt" : "Aktion verworfen",
    run: async (args, ctx) => {
      const fromLabel = OBJECT_LABEL[args.fromObjectType as HubspotObjectType];
      const toLabel = OBJECT_LABEL[args.toObjectType as HubspotObjectType];
      const rationaleBlock = args.rationale ? `\n\nBegründung: ${args.rationale}` : "";
      const value = await ctx.ui.askChoice(
        `Soll ich folgende Verknüpfung in HubSpot ENTFERNEN?\n\n${fromLabel} ${args.fromObjectId}\n↔ ${toLabel} ${args.toObjectId}${rationaleBlock}\n\nDie Records selbst bleiben erhalten — nur die Beziehung wird gelöst.`,
        [
          { value: "apply", label: "Entfernen", description: "DELETE wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "apply") return { applied: false };
      await disassociateHubspotObjects(crm, {
        fromObjectType: args.fromObjectType as HubspotObjectType,
        fromObjectId: args.fromObjectId,
        toObjectType: args.toObjectType as HubspotObjectType,
        toObjectId: args.toObjectId,
      });
      return { applied: true };
    },
  });

  // v0.1.266 — Notes (Phase H4). Create ist der primäre Use-Case.
  const TASK_STATUS_VALUES = [
    "NOT_STARTED",
    "IN_PROGRESS",
    "COMPLETED",
    "WAITING",
    "DEFERRED",
  ] as const;
  const TASK_PRIORITY_VALUES = ["LOW", "MEDIUM", "HIGH"] as const;
  const TASK_TYPE_VALUES = ["EMAIL", "CALL", "TODO"] as const;

  const createNoteTool = defineTool({
    name: "crm_create_hubspot_note",
    description:
      "Legt eine neue Notiz in HubSpot an und verknüpft sie SOFORT mit mindestens einem Company/Contact/Deal — sonst ist die Notiz in der UI quasi unauffindbar. PROPOSE-AND-CONFIRM via ask_user_choice. Body kann Plain-Text oder einfaches HTML enthalten. Zeitstempel wird auf 'jetzt' gesetzt, wenn nicht überschrieben.",
    parameters: {
      type: "object",
      required: ["body", "associations"],
      properties: {
        body: {
          type: "string",
          description: "Notiz-Text. Plain oder einfaches HTML (HubSpot rendert).",
        },
        associations: {
          type: "array",
          minItems: 1,
          description:
            "Mindestens 1 Verknüpfung. Reihenfolge irrelevant. Format: {objectType: 'companies'|'contacts'|'deals', objectId: '...'}",
          items: {
            type: "object",
            required: ["objectType", "objectId"],
            properties: {
              objectType: { type: "string", enum: [...ASSOC_TARGET_VALUES] },
              objectId: { type: "string" },
            },
          },
        },
        timestamp: {
          type: "string",
          description:
            "Optional. ISO-Timestamp. Wenn weggelassen: jetzt.",
        },
      },
    },
    schema: yup
      .object({
        body: yup.string().trim().min(1).max(50_000).required(),
        associations: yup
          .array()
          .of(
            yup
              .object({
                objectType: yup
                  .string()
                  .oneOf([...ASSOC_TARGET_VALUES])
                  .required(),
                objectId: yup.string().trim().min(1).required(),
              })
              .required(),
          )
          .min(1)
          .required(),
        timestamp: yup.string().trim().optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; id?: string }) =>
      r.applied ? `Notiz erstellt (${r.id})` : "Notiz verworfen",
    run: async (args, ctx) => {
      const summary = args.associations
        .map((a) => `${a.objectType.replace(/s$/, "")} ${a.objectId}`)
        .join(", ");
      const value = await ctx.ui.askChoice(
        `Ich möchte folgende Notiz in HubSpot anlegen:\n\n${args.body.slice(0, 1500)}${args.body.length > 1500 ? "\n\n[…gekürzt]" : ""}\n\nVerknüpft mit: ${summary}`,
        [
          { value: "create", label: "Anlegen", description: "POST wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };
      const result = await createHubspotObject(crm, {
        objectType: "notes",
        properties: {
          hs_note_body: args.body,
          hs_timestamp: args.timestamp ?? new Date().toISOString(),
        },
        associations: args.associations.map((a) => ({
          toObjectType: a.objectType as HubspotObjectType,
          toObjectId: a.objectId,
        })),
      });
      return { applied: true, id: result.id };
    },
  });

  const createTaskTool = defineTool({
    name: "crm_create_hubspot_task",
    description:
      "Legt eine neue Aufgabe in HubSpot an und verknüpft sie SOFORT mit Company/Contact/Deal. PROPOSE-AND-CONFIRM. Optional sind Fälligkeit, Priorität, Owner, Typ (EMAIL/CALL/TODO). Status startet immer auf NOT_STARTED.",
    parameters: {
      type: "object",
      required: ["subject", "associations"],
      properties: {
        subject: { type: "string", description: "Aufgaben-Titel (z. B. 'Max anrufen')." },
        body: { type: "string", description: "Optionaler längerer Beschreibungs-Text." },
        dueAt: {
          type: "string",
          description: "Optional ISO-Timestamp der Fälligkeit. Wenn weggelassen: keine.",
        },
        priority: {
          type: "string",
          enum: [...TASK_PRIORITY_VALUES],
          description: "Default MEDIUM.",
        },
        type: {
          type: "string",
          enum: [...TASK_TYPE_VALUES],
          description: "Aufgabe-Typ. Default TODO.",
        },
        ownerId: {
          type: "string",
          description:
            "HubSpot-Owner-ID (numerisch). Aus crm_list_hubspot_owners.",
        },
        associations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["objectType", "objectId"],
            properties: {
              objectType: { type: "string", enum: [...ASSOC_TARGET_VALUES] },
              objectId: { type: "string" },
            },
          },
        },
      },
    },
    schema: yup
      .object({
        subject: yup.string().trim().min(1).max(500).required(),
        body: yup.string().trim().max(10_000).optional(),
        dueAt: yup.string().trim().optional(),
        priority: yup.string().oneOf([...TASK_PRIORITY_VALUES]).optional(),
        type: yup.string().oneOf([...TASK_TYPE_VALUES]).optional(),
        ownerId: yup.string().trim().optional(),
        associations: yup
          .array()
          .of(
            yup
              .object({
                objectType: yup
                  .string()
                  .oneOf([...ASSOC_TARGET_VALUES])
                  .required(),
                objectId: yup.string().trim().min(1).required(),
              })
              .required(),
          )
          .min(1)
          .required(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; id?: string }) =>
      r.applied ? `Aufgabe erstellt (${r.id})` : "Aufgabe verworfen",
    run: async (args, ctx) => {
      const summary = args.associations
        .map((a) => `${a.objectType.replace(/s$/, "")} ${a.objectId}`)
        .join(", ");
      const meta = [
        args.dueAt ? `Fällig: ${args.dueAt}` : null,
        args.priority ? `Priorität: ${args.priority}` : null,
        args.type ? `Typ: ${args.type}` : null,
        args.ownerId ? `Owner: ${args.ownerId}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      const value = await ctx.ui.askChoice(
        `Ich möchte folgende Aufgabe in HubSpot anlegen:\n\n${args.subject}${args.body ? `\n\n${args.body.slice(0, 800)}` : ""}\n${meta ? `\n${meta}` : ""}\n\nVerknüpft mit: ${summary}`,
        [
          { value: "create", label: "Anlegen", description: "POST wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };
      const properties: Record<string, string> = {
        hs_task_subject: args.subject,
        hs_task_status: "NOT_STARTED",
        hs_task_priority: args.priority ?? "MEDIUM",
        hs_task_type: args.type ?? "TODO",
      };
      if (args.body) properties.hs_task_body = args.body;
      if (args.dueAt) properties.hs_timestamp = args.dueAt;
      if (args.ownerId) properties.hubspot_owner_id = args.ownerId;
      const result = await createHubspotObject(crm, {
        objectType: "tasks",
        properties,
        associations: args.associations.map((a) => ({
          toObjectType: a.objectType as HubspotObjectType,
          toObjectId: a.objectId,
        })),
      });
      return { applied: true, id: result.id };
    },
  });

  const listTasksTool = defineTool({
    name: "crm_list_hubspot_tasks",
    description:
      "Listet HubSpot-Tasks mit Filtern: ownerId (z. B. der angemeldete User), statuses (Liste aus NOT_STARTED/IN_PROGRESS/COMPLETED/WAITING/DEFERRED), dueBy (ISO-Timestamp). Sortiert aufsteigend nach Fälligkeit. Returns id, subject, status, priority, type, ownerId, dueAt, completedAt. Nutze ownerId+statuses=[NOT_STARTED,IN_PROGRESS] für 'meine offenen Aufgaben'.",
    parameters: {
      type: "object",
      properties: {
        ownerId: { type: "string" },
        statuses: {
          type: "array",
          items: { type: "string", enum: [...TASK_STATUS_VALUES] },
        },
        dueBy: { type: "string", description: "ISO-Timestamp." },
        limit: { type: "integer", description: "Max Treffer (1-200). Default 50." },
      },
    },
    schema: yup
      .object({
        ownerId: yup.string().trim().optional(),
        statuses: yup
          .array()
          .of(yup.string().oneOf([...TASK_STATUS_VALUES]).required())
          .optional(),
        dueBy: yup.string().trim().optional(),
        limit: yup.number().integer().min(1).max(200).optional(),
      })
      .noUnknown(true),
    preview: (r: { items: unknown[] }) => `${r.items.length} Tasks`,
    run: async (args) =>
      listHubspotTasks(crm, {
        ownerId: args.ownerId,
        statuses: args.statuses,
        dueBy: args.dueBy,
        limit: args.limit,
      }),
  });

  const listNotesForObjectTool = defineTool({
    name: "crm_list_hubspot_notes_for_object",
    description:
      "Listet die Notizen, die mit einem bestimmten HubSpot-Record (Company/Contact/Deal) verknüpft sind. Neueste zuerst. Returns id, body (Plain-Text), createdAt, ownerId.",
    parameters: {
      type: "object",
      required: ["objectType", "objectId"],
      properties: {
        objectType: { type: "string", enum: [...ASSOC_TARGET_VALUES] },
        objectId: { type: "string" },
        limit: { type: "integer", description: "Max Treffer (1-100). Default 25." },
      },
    },
    schema: yup
      .object({
        objectType: yup.string().oneOf([...ASSOC_TARGET_VALUES]).required(),
        objectId: yup.string().trim().min(1).required(),
        limit: yup.number().integer().min(1).max(100).optional(),
      })
      .noUnknown(true),
    preview: (r: { items: unknown[] }) => `${r.items.length} Notizen`,
    run: async (args) =>
      listHubspotNotesForObject(crm, {
        objectType: args.objectType as HubspotObjectType,
        objectId: args.objectId,
        limit: args.limit,
      }),
  });

  // v0.1.266 — Convenience: Task als erledigt markieren ohne den langen
  // introspect+update-Pfad. Wenn der Nutzer "hak Aufgabe X ab" sagt, soll
  // AVA das in einem Tool-Call lösen, nicht in dreien.
  const completeTaskTool = defineTool({
    name: "crm_complete_hubspot_task",
    description:
      "Markiert eine HubSpot-Task als erledigt: setzt hs_task_status=COMPLETED und hs_task_completion_date=jetzt (oder den vom Nutzer genannten Zeitpunkt). PROPOSE-AND-CONFIRM via ask_user_choice — wie alle Schreib-Operationen.",
    parameters: {
      type: "object",
      required: ["taskId"],
      properties: {
        taskId: { type: "string" },
        completedAt: {
          type: "string",
          description: "Optional ISO-Timestamp. Default: jetzt.",
        },
      },
    },
    schema: yup
      .object({
        taskId: yup.string().trim().min(1).required(),
        completedAt: yup.string().trim().optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; ok?: boolean; error?: string }) =>
      !r.applied
        ? "Nicht abgehakt"
        : r.ok
          ? "Aufgabe erledigt"
          : `Fehler: ${r.error ?? "?"}`,
    run: async (args, ctx) => {
      // v0.1.278 — Confirm-Gate dazu (User-Wunsch: alle CRUD-Ops bestätigen).
      const preview = await previewHubspotObject(crm, {
        objectType: "tasks",
        objectId: args.taskId,
      });
      const subject =
        (preview && preview.hs_task_subject) ?? `Task ${args.taskId}`;
      const completedAt = args.completedAt ?? new Date().toISOString();
      const value = await ctx.ui.askChoice(
        `Soll ich folgende Aufgabe in HubSpot als erledigt markieren?\n\n${subject}\nID: ${args.taskId}\nAbschluss-Zeitpunkt: ${completedAt}`,
        [
          { value: "complete", label: "Erledigt", description: "PATCH wird gesendet" },
          { value: "cancel", label: "Abbrechen" },
        ],
        ctx.signal,
      );
      if (value !== "complete") return { applied: false };
      const result = await updateHubspotObject(crm, {
        objectType: "tasks",
        objectId: args.taskId,
        properties: {
          hs_task_status: "COMPLETED",
          hs_task_completion_date: completedAt,
        },
      });
      return {
        applied: true,
        ok: result.ok,
        diff: result.diff,
        notApplied: result.notApplied,
      };
    },
  });

  // v0.1.311 — Helper: AVA-Companydaten → HubSpot-Property-Map.
  //
  // Real-Run-Problem: Agent ruft crm_create_hubspot_company mit nur
  // `name` auf → HubSpot legt eine quasi-leere Firma an und reichert
  // selbst mit oft falschen Daten an. Wir machen deshalb die
  // Anreicherung INTRA-TOOL: bei gegebener linkToAvaCompanyId
  // fetcht das Tool die AVA-Daten + baut die Property-Map.
  //
  // Returnt:
  //   { props: Record<string, string>, hasData: boolean, sources: string[] }
  // - props: HubSpot-ready Properties (name + domain + …)
  // - hasData: true wenn substantielle AVA-Daten gefunden, false wenn
  //   die Firma vermutlich noch nicht durch die Pipeline lief
  // - sources: Liste der AVA-Endpoints aus denen Daten kamen
  //   (für Confirm-Dialog-Transparenz)
  async function gatherAvaCompanyDataForHubspot(
    avaCompanyId: string,
    signal: AbortSignal,
  ): Promise<{
    props: Record<string, string>;
    /** v0.1.354 — Roh-Branchenkandidat (SERP-Kategorie / Keyword). Geht
     *  NICHT direkt in `props`, weil HubSpots `industry` ein festes Enum
     *  ist — der Sync-Tool matcht ihn erst gegen die erlaubten Optionen. */
    industryCandidate?: string;
    /** v0.1.354 — Kontakt-Kandidaten aus structured-content
     *  (Geschäftsführer) + contacts (Ansprechpartner), dedup-roh. */
    contactCandidates: Array<{
      firstName?: string;
      lastName?: string;
      fullName: string;
      jobTitle?: string;
      email?: string;
      phone?: string;
      source: string;
    }>;
    hasData: boolean;
    sources: string[];
    diagnostics: Array<{ endpoint: string; ok: boolean; reason?: string }>;
  }> {
    const props: Record<string, string> = {};
    const sources: string[] = [];
    const diagnostics: Array<{ endpoint: string; ok: boolean; reason?: string }> = [];
    const contactCandidates: Array<{
      firstName?: string;
      lastName?: string;
      fullName: string;
      jobTitle?: string;
      email?: string;
      phone?: string;
      source: string;
    }> = [];
    let industryCandidate: string | undefined;
    const get = async <T = unknown>(
      label: string,
      path: string,
    ): Promise<T | null> => {
      try {
        const res = await gateway.request<T>(path, { signal });
        if (res == null || (typeof res === "object" && Object.keys(res as object).length === 0)) {
          diagnostics.push({ endpoint: label, ok: false, reason: "leer" });
          return null;
        }
        diagnostics.push({ endpoint: label, ok: true });
        return res;
      } catch (err) {
        const reason = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
        diagnostics.push({ endpoint: label, ok: false, reason });
        return null;
      }
    };
    const str = (v: unknown): string | undefined =>
      typeof v === "string" && v.trim().length > 0
        ? v.trim()
        : typeof v === "number" && Number.isFinite(v)
          ? String(v)
          : undefined;

    // v0.1.354 — ALLE relevanten Endpunkte laden (vorher wurden Felder aus
    // nicht-existenten Keys gelesen → "befüllt nie"). Parallel für Tempo.
    const [base, structured, profile, website, pubs, kw, contacts] =
      await Promise.all([
        // Base-Stammdaten: name, location, register…
        get<{ name?: string; location?: string }>(
          "base",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}`,
        ),
        // Structured-Content: Adresse, Gründungsjahr, Gegenstand, GF…
        get<{
          name?: string;
          corporatePurpose?: string | null;
          legalForm?: string | null;
          street?: string | null;
          houseNumber?: string | null;
          zipCode?: string | null;
          city?: string | null;
          foundingYear?: number | string | null;
          managingDirectors?: Array<{
            firstName?: string;
            lastName?: string;
            city?: string;
          }>;
        }>(
          "structured-content",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/structured-content`,
        ),
        // Profile: businessPurpose, profile-Summary, keywords
        get<{
          profile?: string;
          businessPurpose?: string | null;
          keywords?: string[];
        }>(
          "profile",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/profile`,
        ),
        // Website: { website:{siteName,description}, companySerp:{url,address,category,phone} }
        get<{
          website?: {
            siteName?: string | null;
            description?: string | null;
            socialLinks?: Array<{ platform: string; url: string }>;
          };
          companySerp?: {
            url?: string | null;
            category?: string | null;
            address?: string | null;
            phone?: string | null;
          };
        }>(
          "website",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/website`,
        ),
        // Publications: items[].{ employeeCount, salesVolume{value}, revenueVolume{value}, year }
        get<{
          items?: Array<{
            year?: number | null;
            employeeCount?: number | null;
            salesVolume?: { value?: number } | null;
            revenueVolume?: { value?: number } | null;
          }>;
        }>(
          "publications",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/publications`,
        ),
        get<{ items?: Array<{ keyword?: string }> }>(
          "keywords",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/keywords`,
        ),
        // Contacts-Aggregat: employments[] (Ansprechpartner)
        get<{ employments?: Array<Record<string, unknown>> }>(
          "contacts",
          `/v1/companies/${encodeURIComponent(avaCompanyId)}/contacts`,
        ),
      ]);

    // ---- Name ----
    if (base?.name) {
      sources.push("base");
      props.name = base.name;
    } else if (structured?.name) {
      props.name = structured.name;
    }

    // ---- Adresse / Gründungsjahr / Gegenstand (structured-content) ----
    if (structured) {
      sources.push("structured-content");
      const street = str(structured.street);
      const houseNo = str(structured.houseNumber);
      if (street) props.address = houseNo ? `${street} ${houseNo}` : street;
      const zip = str(structured.zipCode);
      if (zip) props.zip = zip;
      const city = str(structured.city);
      if (city) props.city = city;
      const fy = str(structured.foundingYear);
      if (fy) props.founded_year = fy;
      const purpose = str(structured.corporatePurpose);
      if (purpose) props.description = purpose.slice(0, 1000);
      // Deutsche Handelsregister-Daten ⇒ Land = Deutschland (Default).
      props.country = "Deutschland";
      // Geschäftsführer → Kontakt-Kandidaten.
      for (const md of structured.managingDirectors ?? []) {
        const first = str(md.firstName);
        const last = str(md.lastName);
        const full = [first, last].filter(Boolean).join(" ").trim();
        if (full.length > 0) {
          contactCandidates.push({
            ...(first ? { firstName: first } : {}),
            ...(last ? { lastName: last } : {}),
            fullName: full,
            jobTitle: "Geschäftsführer",
            source: "structured-content",
          });
        }
      }
    }

    // ---- Beschreibung-Fallbacks (Profile) ----
    if (profile) {
      sources.push("profile");
      if (!props.description) {
        const bp = str(profile.businessPurpose) ?? str(profile.profile);
        if (bp) props.description = bp.slice(0, 1000);
      }
    }

    // ---- Website / Domain / Adresse-Fallback / Branche / Telefon ----
    if (website && (website.website || website.companySerp)) {
      sources.push("website");
      const serp = website.companySerp;
      const url = str(serp?.url);
      if (url) {
        props.website = url;
        try {
          props.domain = new URL(
            url.startsWith("http") ? url : `https://${url}`,
          ).hostname.replace(/^www\./, "");
        } catch {
          /* unsaubere URL — Domain weglassen */
        }
      }
      if (!props.address) {
        const serpAddr = str(serp?.address);
        if (serpAddr) props.address = serpAddr;
      }
      if (!props.description) {
        const wd = str(website.website?.description);
        if (wd) props.description = wd.slice(0, 1000);
      }
      industryCandidate = industryCandidate ?? str(serp?.category);
      const phone = str(serp?.phone);
      if (phone) props.phone = phone;
      // v0.1.358 — Social-Media-Unternehmensseiten → HubSpot-Standardfelder.
      // HubSpot kennt linkedin_company_page, facebook_company_page,
      // twitterhandle als Default-Properties. Instagram/YouTube/Xing/TikTok
      // haben kein Standardfeld → bewusst ausgelassen (kämen in Custom-
      // Properties oder die Beschreibung, ist hier out of scope).
      for (const sl of website.website?.socialLinks ?? []) {
        const url = str(sl?.url);
        if (!url) continue;
        if (sl.platform === "linkedin" && !props.linkedin_company_page) {
          props.linkedin_company_page = url;
        } else if (sl.platform === "facebook" && !props.facebook_company_page) {
          props.facebook_company_page = url;
        } else if (sl.platform === "twitter" && !props.twitterhandle) {
          // HubSpots twitterhandle erwartet den Handle, nicht die URL.
          const handle = url.replace(/\/+$/, "").split("/").pop();
          if (handle) props.twitterhandle = handle;
        }
      }
    }

    // ---- Mitarbeiterzahl + Umsatz (neueste Publikation) ----
    const items = pubs?.items ?? [];
    if (items.length > 0) {
      sources.push("publications");
      // Items sind year DESC sortiert; nimm jeweils den ersten mit Wert.
      const emp = items.find((p) => typeof p.employeeCount === "number");
      if (emp?.employeeCount != null) {
        props.numberofemployees = String(emp.employeeCount);
      }
      const rev = items.find(
        (p) =>
          typeof p.salesVolume?.value === "number" ||
          typeof p.revenueVolume?.value === "number",
      );
      const revVal = rev?.salesVolume?.value ?? rev?.revenueVolume?.value;
      if (typeof revVal === "number") {
        props.annualrevenue = String(Math.round(revVal));
      }
    }

    // ---- Keywords: Branchenkandidat + Description-Fallback ----
    const keywordList = (kw?.items ?? [])
      .map((k) => str(k?.keyword))
      .filter((s): s is string => Boolean(s));
    if (keywordList.length > 0) {
      sources.push("keywords");
      industryCandidate = industryCandidate ?? keywordList[0];
      if (!props.description) {
        props.description = `Schwerpunkte: ${keywordList.slice(0, 20).join(", ")}`.slice(
          0,
          1000,
        );
      }
    }

    // ---- Ansprechpartner aus contacts/employments (best effort) ----
    for (const emp of contacts?.employments ?? []) {
      const first = str(emp.firstName) ?? str((emp.person as { firstName?: string })?.firstName);
      const last = str(emp.lastName) ?? str((emp.person as { lastName?: string })?.lastName);
      const nameField = str(emp.name) ?? str((emp.person as { name?: string })?.name);
      const full =
        nameField ?? [first, last].filter(Boolean).join(" ").trim();
      if (!full || full.length === 0) continue;
      // Dedup gegen schon erfasste GF (gleicher Name).
      if (
        contactCandidates.some(
          (c) => c.fullName.toLowerCase() === full.toLowerCase(),
        )
      ) {
        continue;
      }
      contactCandidates.push({
        ...(first ? { firstName: first } : {}),
        ...(last ? { lastName: last } : {}),
        fullName: full,
        ...(str(emp.title) ? { jobTitle: str(emp.title) } : {}),
        ...(str(emp.email) ? { email: str(emp.email) } : {}),
        ...(str(emp.phone) ? { phone: str(emp.phone) } : {}),
        source: "contacts",
      });
    }
    if ((contacts?.employments ?? []).length > 0 && !sources.includes("contacts")) {
      sources.push("contacts");
    }

    // hasData: substanziell wenn IRGENDEINE inhaltliche Quelle griff.
    const hasData =
      sources.includes("structured-content") ||
      sources.includes("website") ||
      sources.includes("profile") ||
      sources.includes("publications") ||
      sources.includes("keywords") ||
      sources.includes("contacts");
    return {
      props,
      ...(industryCandidate ? { industryCandidate } : {}),
      contactCandidates,
      hasData,
      sources,
      diagnostics,
    };
  }

  // v0.1.354 — Best-Match einer freien AVA-Branche/Kategorie gegen HubSpots
  // festes `industry`-Enum. HubSpot ignoriert Werte, die nicht exakt einer
  // Option entsprechen, daher MÜSSEN wir auf einen erlaubten `value` mappen.
  // Heuristik: exакte/teilstring-Übereinstimmung gegen label+value (case-
  // insensitive). Kein Treffer → undefined (Feld wird ausgelassen, kein
  // Müll). LLM-Fallback bewusst (noch) nicht — die Heuristik deckt die
  // häufigen Fälle und vermeidet einen Tool-internen Modell-Call.
  function bestMatchIndustry(
    candidate: string | undefined,
    options: Array<{ label: string; value: string }>,
  ): string | undefined {
    if (!candidate || options.length === 0) return undefined;
    const cand = candidate.toLowerCase().trim();
    // 1) exakter Label/Value-Match
    for (const o of options) {
      if (o.label.toLowerCase() === cand || o.value.toLowerCase() === cand) {
        return o.value;
      }
    }
    // 2) Teilstring in beide Richtungen (längster Treffer gewinnt)
    let best: { value: string; score: number } | null = null;
    for (const o of options) {
      const label = o.label.toLowerCase();
      if (label.includes(cand) || cand.includes(label)) {
        const score = Math.min(label.length, cand.length);
        if (!best || score > best.score) best = { value: o.value, score };
      }
    }
    return best?.value;
  }

  // v0.1.354 — Standard-HubSpot-Company-Properties, die wir ohne Schema-
  // Introspektion gefahrlos schreiben dürfen (existieren in jedem Portal).
  const STANDARD_COMPANY_PROPS = new Set<string>([
    "name",
    "domain",
    "website",
    "address",
    "city",
    "zip",
    "state",
    "country",
    "numberofemployees",
    "annualrevenue",
    "founded_year",
    "description",
    "phone",
    "industry",
    "linkedin_company_page",
    "facebook_company_page",
    "twitterhandle",
  ]);

  // v0.1.354 — Ein-Klick-Voll-Sync: AVA-Firma → HubSpot. Holt ALLE
  // AVA-Daten (Stammdaten, Structured-Content, Profil, Website/SERP,
  // Publikationen, Keywords, Kontakte), legt die HubSpot-Company an ODER
  // aktualisiert sie, mappt die Branche gegen HubSpots Enum, legt
  // Geschäftsführer + Ansprechpartner als Contacts an (dedupliziert,
  // verknüpft) — alles hinter EINER Bestätigung. Das ist der Standard-
  // Pfad, wenn der Nutzer eine AVA-Firma „in HubSpot anlegen/aktualisieren/
  // anreichern" will.
  const syncCompanyTool = defineTool({
    name: "crm_sync_hubspot_company_from_ava",
    description:
      "VOLL-SYNC einer AVA-Firma nach HubSpot in EINEM Schritt — der bevorzugte Weg, sobald der Nutzer eine in AVA bekannte Firma in HubSpot anlegen, aktualisieren oder anreichern will. Holt automatisch ALLE AVA-Daten (Stammdaten, Structured-Content, Profil, Website/SERP, Publikationen, Keywords, Kontakte) und befüllt die HubSpot-Felder: name, address, zip, city, country, numberofemployees (aus letztem Jahresabschluss), annualrevenue, founded_year, description (Unternehmensgegenstand), website/domain, phone, industry (gegen HubSpots Branchen-Enum gematcht). Legt zusätzlich Geschäftsführer + Ansprechpartner als verknüpfte Contacts an (dedupliziert). Alles hinter EINER Sammel-Bestätigung — KEIN Feld-für-Feld-Nachfragen. Wenn keine `hubspotCompanyId` gegeben ist, sucht das Tool selbst nach Dubletten und fragt ggf. welche Firma gemeint ist bzw. legt neu an. Vorher die AVA-companyId via `company_search` auflösen. Wenn die Firma in AVA noch nicht recherchiert wurde, bricht das Tool mit klarem Hinweis ab.",
    parameters: {
      type: "object",
      required: ["avaCompanyId"],
      properties: {
        avaCompanyId: {
          type: "string",
          description:
            "AVA-Master-Data-companyId (via company_search auflösen).",
        },
        hubspotCompanyId: {
          type: "string",
          description:
            "Optional: bekannte HubSpot-companyId. Wenn weggelassen, sucht das Tool nach Dubletten (Name/Domain) und legt sonst neu an.",
        },
        includeContacts: {
          type: "boolean",
          description:
            "Geschäftsführer + Ansprechpartner als Contacts anlegen + verknüpfen. Default true.",
        },
        rationale: {
          type: "string",
          description: "Optionale 1-Satz-Begründung für den Confirm-Dialog.",
        },
      },
    },
    schema: yup
      .object({
        avaCompanyId: yup.string().trim().min(1).required(),
        hubspotCompanyId: yup.string().trim().optional(),
        includeContacts: yup.boolean().optional(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: {
      applied: boolean;
      companyId?: string;
      created?: boolean;
      fieldsWritten?: number;
      contactsCreated?: number;
      error?: string;
    }) =>
      r.applied
        ? `HubSpot ${r.created ? "angelegt" : "aktualisiert"} (${r.companyId}) · ${r.fieldsWritten ?? 0} Felder · ${r.contactsCreated ?? 0} Kontakte`
        : r.error
          ? `Fehler: ${r.error}`
          : "Sync verworfen",
    run: async (args, ctx) => {
      const includeContacts = args.includeContacts ?? true;
      const status = crm.getStatus("hubspot");
      if (!status.connected) {
        return {
          applied: false,
          error:
            "HubSpot ist nicht verbunden. Bitte zuerst in den Einstellungen verbinden.",
        };
      }

      // 1) ALLE AVA-Daten holen.
      const enrich = await gatherAvaCompanyDataForHubspot(
        args.avaCompanyId,
        ctx.signal,
      );
      if (!enrich.hasData) {
        const diag = enrich.diagnostics
          .map((d) => `${d.endpoint}: ${d.ok ? "ok" : (d.reason ?? "leer")}`)
          .join(" · ");
        return {
          applied: false,
          error:
            `Firma ${args.avaCompanyId} ist in AVA noch nicht recherchiert (keine inhaltlichen Daten). ` +
            `Bitte zuerst die Recherche anstoßen (Tab „Firmen" → Firma → neu recherchieren) und erneut versuchen.\n` +
            `Quellen-Status: ${diag}`,
        };
      }

      // 2) Ziel-Company auflösen (gegeben / Dublettensuche / neu).
      let hubspotId = args.hubspotCompanyId;
      let creating = false;
      let schemaCompanyId: string | null = hubspotId ?? null;
      if (!hubspotId) {
        const query = enrich.props.domain || enrich.props.name || "";
        const search = query
          ? await searchHubspotCompanies(crm, { query, limit: 10 }).catch(
              () => ({ items: [] as Array<{ id: string; name: string | null; domain: string | null; city: string | null }> }),
            )
          : { items: [] };
        if (search.items.length === 0) {
          creating = true;
        } else {
          const pick = await ctx.ui.askChoice(
            `Für „${enrich.props.name ?? args.avaCompanyId}" gibt es in HubSpot bereits Treffer. Welche Firma soll ich aktualisieren — oder eine neue anlegen?`,
            [
              ...search.items.slice(0, 10).map((m) => ({
                value: m.id,
                label: m.name ?? `(ohne Name) ${m.id}`,
                description: [m.domain, m.city].filter(Boolean).join(" · ") || undefined,
              })),
              {
                value: "__new__",
                label: "Neue Firma anlegen",
                description: "Keiner der Treffer passt",
              },
            ],
            ctx.signal,
          );
          if (pick === "__new__" || pick.startsWith("__user_other__")) {
            creating = true;
            // Falls es Treffer gibt, nehmen wir den ersten nur fürs Schema.
            schemaCompanyId = search.items[0]?.id ?? null;
          } else {
            hubspotId = pick;
            schemaCompanyId = pick;
          }
        }
        if (creating && !schemaCompanyId && search.items.length > 0) {
          schemaCompanyId = search.items[0]?.id ?? null;
        }
      }

      // 3) Schema + aktuelle Werte (für Branche-Match + Property-Filter +
      //    Diff). Nur möglich, wenn es eine company gibt, deren Schema wir
      //    lesen können (Schema ist portalweit identisch).
      let schemaNames: Set<string> | null = null;
      let industryOptions: Array<{ label: string; value: string }> = [];
      let currentValues: Record<string, string | null> = {};
      if (schemaCompanyId) {
        try {
          const intro = await introspectHubspotObject(
            crm,
            "companies",
            schemaCompanyId,
          );
          schemaNames = new Set(intro.schema.map((p) => p.name));
          industryOptions =
            intro.schema.find((p) => p.name === "industry")?.options ?? [];
          // currentValues nur relevant, wenn wir DIESE company updaten.
          if (!creating && hubspotId === schemaCompanyId) {
            currentValues = intro.currentValues;
          }
        } catch {
          /* Schema nicht lesbar — Fallback auf Standard-Whitelist */
        }
      }

      // 4) Finale Property-Map bauen.
      const finalProps: Record<string, string> = { ...enrich.props };
      // Branche gegen Enum matchen.
      if (enrich.industryCandidate && industryOptions.length > 0) {
        const matched = bestMatchIndustry(
          enrich.industryCandidate,
          industryOptions,
        );
        if (matched) finalProps.industry = matched;
      }
      // Filter: nur Properties schreiben, die HubSpot kennt (sonst 400).
      for (const k of Object.keys(finalProps)) {
        const known = schemaNames ? schemaNames.has(k) : STANDARD_COMPANY_PROPS.has(k);
        if (!known) delete finalProps[k];
      }
      // Beim Update: nur leere oder abweichende Felder vorschlagen.
      const changed: Record<string, string> = {};
      for (const [k, v] of Object.entries(finalProps)) {
        if (creating) {
          changed[k] = v;
          continue;
        }
        const cur = currentValues[k];
        if (cur == null || cur === "" || cur.trim() !== v.trim()) {
          changed[k] = v;
        }
      }
      if (creating && !changed.name && enrich.props.name) {
        changed.name = enrich.props.name;
      }

      // 5) Kontakt-Plan (dedupliziert via HubSpot-Suche).
      const contactPlan: Array<{
        firstName?: string;
        lastName?: string;
        fullName: string;
        jobTitle?: string;
        email?: string;
        phone?: string;
      }> = [];
      if (includeContacts) {
        for (const c of enrich.contactCandidates.slice(0, 12)) {
          let exists = false;
          try {
            const q = c.email || c.fullName;
            const res = await searchHubspotContacts(crm, { query: q, limit: 5 });
            exists = res.items.some((it) => {
              const itName = [it.firstName, it.lastName]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return (
                (c.email && it.email && it.email.toLowerCase() === c.email.toLowerCase()) ||
                itName === c.fullName.toLowerCase()
              );
            });
          } catch {
            /* Suche fehlgeschlagen — sicherheitshalber NICHT anlegen, um
               kein Duplikat zu riskieren */
            exists = true;
          }
          if (!exists) contactPlan.push(c);
        }
      }

      // 6) EINE Sammel-Bestätigung.
      const fieldLines = Object.entries(changed)
        .map(([k, v]) => `  • ${k}: ${v.length > 70 ? v.slice(0, 70) + "…" : v}`)
        .join("\n");
      const contactLines = contactPlan
        .map(
          (c) =>
            `  • ${c.fullName}${c.jobTitle ? ` (${c.jobTitle})` : ""}${c.email ? ` · ${c.email}` : ""}`,
        )
        .join("\n");
      if (Object.keys(changed).length === 0 && contactPlan.length === 0) {
        return {
          applied: false,
          error:
            "Nichts zu tun — HubSpot ist bereits auf dem Stand der AVA-Daten (oder AVA hat zu diesen Feldern keine Werte).",
        };
      }
      const header = creating
        ? `Ich lege folgende NEUE Firma in HubSpot an und reichere sie aus AVA an:`
        : `Ich aktualisiere die HubSpot-Firma ${hubspotId} aus AVA:`;
      const rationaleBlock = args.rationale ? `\n\nBegründung: ${args.rationale}` : "";
      const sourcesBlock = `\n\nQuellen: ${enrich.sources.join(", ")}`;
      const fieldsBlock =
        Object.keys(changed).length > 0
          ? `\n\nFelder (${Object.keys(changed).length}):\n${fieldLines}`
          : "\n\n(keine Feldänderungen)";
      const contactsBlock =
        contactPlan.length > 0
          ? `\n\nKontakte anlegen + verknüpfen (${contactPlan.length}):\n${contactLines}`
          : includeContacts
            ? "\n\n(keine neuen Kontakte — bereits vorhanden oder keine gefunden)"
            : "";
      const decision = await ctx.ui.askChoice(
        `${header}${fieldsBlock}${contactsBlock}${sourcesBlock}${rationaleBlock}`,
        [
          {
            value: "apply",
            label: "Übernehmen",
            description: "Alles in einem Rutsch nach HubSpot schreiben",
          },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (decision !== "apply") return { applied: false };

      // 7) Schreiben.
      let companyId = hubspotId;
      let created = false;
      const errors: string[] = [];
      try {
        if (creating) {
          const res = await createHubspotObject(crm, {
            objectType: "companies",
            properties: changed,
          });
          companyId = res.id;
          created = true;
          // AVA verknüpfen.
          try {
            await gateway.request(
              `/v1/companies/${encodeURIComponent(args.avaCompanyId)}/crm/links`,
              {
                method: "POST",
                body: {
                  crmType: "HUBSPOT" as CrmLinkType,
                  crmExternalId: companyId,
                  crmDisplayName: changed.name ?? enrich.props.name ?? null,
                },
                signal: ctx.signal,
              },
            );
          } catch (err) {
            errors.push(
              `AVA-Verknüpfung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else if (companyId && Object.keys(changed).length > 0) {
          await updateHubspotObject(crm, {
            objectType: "companies",
            objectId: companyId,
            properties: changed,
          });
        }
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // 8) Kontakte anlegen + verknüpfen.
      let contactsCreated = 0;
      if (companyId && contactPlan.length > 0) {
        for (const c of contactPlan) {
          const cProps: Record<string, string> = {};
          if (c.firstName) cProps.firstname = c.firstName;
          if (c.lastName) cProps.lastname = c.lastName;
          if (!c.firstName && !c.lastName) cProps.lastname = c.fullName;
          if (c.jobTitle) cProps.jobtitle = c.jobTitle;
          if (c.email) cProps.email = c.email;
          if (c.phone) cProps.phone = c.phone;
          try {
            await createHubspotObject(crm, {
              objectType: "contacts",
              properties: cProps,
              associations: [
                {
                  toObjectType: "companies" as HubspotObjectType,
                  toObjectId: companyId,
                },
              ],
            });
            contactsCreated += 1;
          } catch (err) {
            errors.push(
              `Kontakt „${c.fullName}" fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }

      return {
        applied: true,
        companyId,
        created,
        fieldsWritten: Object.keys(changed).length,
        contactsCreated,
        sources: enrich.sources,
        ...(errors.length > 0 ? { warnings: errors } : {}),
      };
    },
  });

  // v0.1.269 — Company-Create (Phase H5). Bisher waren Companies/
  // Contacts/Deals nur update-able; Create war bewusst weggelassen
  // weil "blind eine neue Firma anlegen" ohne Duplikat-Check Risiko
  // birgt. Mit Propose-and-Confirm + automatischer Dublettensuche
  // (crm_search_hubspot_companies) ist es jetzt sicher genug.
  //
  // v0.1.311 — Anreicherung intra-Tool. Wenn linkToAvaCompanyId
  // gegeben ist UND der Agent keine eigenen `properties` mitgibt,
  // fetcht das Tool selbst die AVA-Daten + baut die Property-Map.
  // Vorher: Agent schickte nur `name` → HubSpot ratet rest falsch.
  const createCompanyTool = defineTool({
    name: "crm_create_hubspot_company",
    description:
      "Legt eine NEUE Company in HubSpot an. Propose-and-Confirm via ask_user_choice. PFLICHT VORHER: crm_search_hubspot_companies aufrufen, um Dubletten zu erkennen — wenn schon eine Company mit dem Namen oder der Domain existiert, dem Nutzer das TRANSPARENT zeigen und nachfragen (Update statt Create? oder ist das ein anderer Account?). Mindestens `name` ist Pflicht; alle weiteren Properties (domain, industry, lifecyclestage, …) sind optional und werden 1:1 ans HubSpot-API gereicht. Bei enum-Feldern den value, nicht das label.\n\n" +
      "Wenn der Nutzer ein Pendant zu einer bereits in AVA bekannten Firma anlegt (Standard-Use-Case), IMMER auch `linkToAvaCompanyId` mitgeben — dann wird die HubSpot-Verknüpfung in einem Schritt mit angelegt, der Nutzer muss nichts manuell in der Firmenseite nachziehen. AVA-companyId vorher via `company_search` auflösen.\n\n" +
      "v0.1.311 — AUTO-ANREICHERUNG: Wenn `linkToAvaCompanyId` gegeben ist, fetcht das Tool SELBST die AVA-Companydaten (legalName, Adresse, Website, Domain, Headcount, Branche, Beschreibung, Umsatz aus Pubs) und befüllt die HubSpot-Properties automatisch. Du musst die Properties also NICHT selbst zusammenklauben — gib einfach name + linkToAvaCompanyId mit, der Rest passiert automatisch. Du musst eigene Properties NUR mitgeben, wenn du etwas Konkretes ergänzen oder überschreiben willst (deine Werte gewinnen gegen die AVA-Daten).\n\n" +
      "WENN AVA NOCH KEINE DATEN HAT (Pipeline noch nicht gelaufen), bricht das Tool mit klarer Fehlermeldung ab. Reaktion: dem User sagen, dass die Firma zuerst in AVA recherchiert werden muss (Tab 'Firmen' → Firma → 'neu recherchieren'). Erst danach in HubSpot anlegen. Workaround für Notfälle: OHNE linkToAvaCompanyId aufrufen — dann landet nur Name (+ ggf. explizite Domain/Properties) in HubSpot, der User muss den Rest manuell pflegen.",
    parameters: {
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          description: "Firmenname (Pflicht).",
        },
        domain: {
          type: "string",
          description:
            "Primäre Website-Domain (ohne https://, z. B. 'kunde.de'). Optional aber dringend empfohlen — HubSpot dedupliziert intern auch per Domain.",
        },
        properties: {
          type: "object",
          description:
            "Zusätzliche HubSpot-Properties (Property-Name → String-Wert). Schema vorher via crm_introspect_hubspot_company auf einer bestehenden Company lesen, um Property-Namen + Enum-Optionen zu kennen.",
          additionalProperties: { type: "string" },
        },
        linkToAvaCompanyId: {
          type: "string",
          description:
            "Optionale AVA-Master-Data-companyId. Wenn gesetzt, wird nach dem erfolgreichen Create automatisch eine HUBSPOT-Verknüpfung zu dieser AVA-Firma angelegt (entspricht crm_link_manual). Vorher via company_search auflösen.",
        },
        rationale: {
          type: "string",
          description: "Begründung (1 Satz) für den Confirm-Dialog.",
        },
      },
    },
    schema: yup
      .object({
        name: yup.string().trim().min(1).max(500).required(),
        domain: yup.string().trim().max(500).optional(),
        properties: yup.object().optional(),
        linkToAvaCompanyId: yup.string().trim().optional(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: {
      applied: boolean;
      id?: string;
      linked?: boolean;
      error?: string;
    }) =>
      r.applied
        ? r.linked
          ? `Company angelegt + verknüpft (${r.id})`
          : `Company angelegt (${r.id})`
        : r.error
          ? `Fehler: ${r.error}`
          : "Company nicht angelegt",
    run: async (args, ctx) => {
      const extraProps = (args.properties ?? {}) as Record<string, string>;
      const props: Record<string, string> = { name: args.name };
      if (args.domain) props.domain = args.domain;
      // v0.1.311 — Auto-Anreicherung: wenn der Agent linkToAvaCompanyId
      // mitgibt aber keine `properties` explizit befüllt, holen wir die
      // AVA-Companydaten und befüllen die HubSpot-Property-Map automatisch.
      // Verhindert das "HubSpot wird nur mit Name angelegt"-Antipattern.
      let avaSources: string[] = [];
      let avaHasData = true; // default true wenn Anreicherung nicht angefordert
      if (args.linkToAvaCompanyId) {
        const enrich = await gatherAvaCompanyDataForHubspot(
          args.linkToAvaCompanyId,
          ctx.signal,
        );
        avaSources = enrich.sources;
        avaHasData = enrich.hasData;
        // AVA-Daten fließen NUR ein, wenn der Agent sie nicht explizit
        // überschrieben hat. Agent-Werte gewinnen (explicit > implicit).
        for (const [k, v] of Object.entries(enrich.props)) {
          if (k === "name") continue; // Original-Name-Param hat Vorrang
          if (props[k] !== undefined) continue;
          if (extraProps[k] !== undefined) continue;
          props[k] = v;
        }
        // Wenn die Firma noch nicht durch die Pipeline lief, BRECHEN
        // wir mit klarem Hinweis ab — sonst landet wieder eine leere
        // Firma in HubSpot.
        if (!avaHasData) {
          return {
            applied: false,
            error:
              `Firma ${args.linkToAvaCompanyId} ist in AVA noch nicht durch die Recherche-Pipeline gelaufen ` +
              `(keine Profile-, Website- oder Publikationsdaten verfügbar). Bitte zuerst die ` +
              `Recherche anstoßen (z. B. via "Firma neu recherchieren") und dann erneut versuchen. ` +
              `Wenn du die Firma TROTZDEM ohne AVA-Anreicherung in HubSpot anlegen willst, ` +
              `ruf crm_create_hubspot_company OHNE linkToAvaCompanyId auf — dann gibt es nur ` +
              `Name + Domain (was du explizit mitgibst).`,
          };
        }
      }
      for (const [k, v] of Object.entries(extraProps)) {
        if (k === "name" || k === "domain") continue; // schon gesetzt
        props[k] = v; // explicit Agent-properties gewinnen
      }
      const propLines = Object.entries(props)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const linkHint = args.linkToAvaCompanyId
        ? `\n\nVerknüpft danach automatisch mit AVA-Firma ${args.linkToAvaCompanyId}.${
            avaSources.length > 0
              ? `\nAVA-Daten verwendet aus: ${avaSources.join(", ")}.`
              : ""
          }`
        : "";
      const value = await ctx.ui.askChoice(
        `Ich möchte folgende NEUE Company in HubSpot anlegen:\n\n${propLines}${rationaleBlock}${linkHint}\n\nFalls die Firma bereits existiert, sag bitte Bescheid — sonst gibt es ein Duplikat.`,
        [
          {
            value: "create",
            label: "Anlegen",
            description: "POST wird ans HubSpot-API gesendet",
          },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };
      let createdId: string;
      try {
        const result = await createHubspotObject(crm, {
          objectType: "companies",
          properties: props,
        });
        createdId = result.id;
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      // v0.1.271 — Auto-Link, wenn AVA-companyId bekannt ist. Bewusst NICHT
      // mit eigenem Confirm — der Nutzer hat dem Create zugestimmt und der
      // Link ist die intuitive Folgeaktion (sonst hängt die neue HubSpot-
      // Firma orphan im AVA-Detail). Sollte das Linking scheitern (z. B.
      // weil die companyId nicht existiert), wird das im Tool-Result
      // surfaced — die HubSpot-Firma bleibt bestehen, kein Rollback.
      let linked = false;
      let linkError: string | null = null;
      if (args.linkToAvaCompanyId) {
        try {
          await gateway.request(
            `/v1/companies/${encodeURIComponent(args.linkToAvaCompanyId)}/crm/links`,
            {
              method: "POST",
              body: {
                crmType: "HUBSPOT" as CrmLinkType,
                crmExternalId: createdId,
                crmDisplayName: args.name,
              },
              signal: ctx.signal,
            },
          );
          linked = true;
        } catch (err) {
          linkError = err instanceof Error ? err.message : String(err);
        }
      }

      return {
        applied: true,
        id: createdId,
        linked,
        ...(linkError ? { linkError } : {}),
      };
    },
  });

  // v0.1.278 — Contact-Create. Pflicht: email (HubSpots Dedup-Key).
  // Optional: firstname, lastname, jobtitle, phone, sowie weitere
  // Custom-Properties via properties-Map. linkToHubspotCompanyId für
  // Inline-Association in einem Tool-Call.
  const createContactTool = defineTool({
    name: "crm_create_hubspot_contact",
    description:
      "Legt einen NEUEN Contact in HubSpot an. PROPOSE-AND-CONFIRM via ask_user_choice. PFLICHT vorher: crm_search_hubspot_contacts mit der email — wenn schon ein Contact mit dieser email existiert, dem Nutzer das transparent zeigen und Update statt Create vorschlagen. Pflichtfeld ist `email` (HubSpots Dedup-Key). Empfohlen: firstname, lastname. Optional: linkToHubspotCompanyId für Inline-Verknüpfung zur Company.",
    parameters: {
      type: "object",
      required: ["email"],
      properties: {
        email: { type: "string", description: "E-Mail (Pflicht, HubSpots Dedup-Key)." },
        firstname: { type: "string" },
        lastname: { type: "string" },
        jobtitle: { type: "string" },
        phone: { type: "string" },
        properties: {
          type: "object",
          description: "Zusätzliche HubSpot-Properties (Name → String).",
          additionalProperties: { type: "string" },
        },
        linkToHubspotCompanyId: {
          type: "string",
          description: "Optionale HubSpot-companyId; Contact wird inline mit der Company verknüpft.",
        },
        rationale: { type: "string" },
      },
    },
    schema: yup
      .object({
        email: yup.string().email().required(),
        firstname: yup.string().trim().max(500).optional(),
        lastname: yup.string().trim().max(500).optional(),
        jobtitle: yup.string().trim().max(500).optional(),
        phone: yup.string().trim().max(500).optional(),
        properties: yup.object().optional(),
        linkToHubspotCompanyId: yup.string().trim().optional(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; id?: string; linked?: boolean; error?: string }) =>
      r.applied
        ? r.linked
          ? `Contact angelegt + verknüpft (${r.id})`
          : `Contact angelegt (${r.id})`
        : r.error
          ? `Fehler: ${r.error}`
          : "Contact nicht angelegt",
    run: async (args, ctx) => {
      const props: Record<string, string> = { email: args.email };
      if (args.firstname) props.firstname = args.firstname;
      if (args.lastname) props.lastname = args.lastname;
      if (args.jobtitle) props.jobtitle = args.jobtitle;
      if (args.phone) props.phone = args.phone;
      for (const [k, v] of Object.entries(
        (args.properties ?? {}) as Record<string, string>,
      )) {
        if (k in props) continue;
        props[k] = v;
      }
      const propLines = Object.entries(props)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      const linkHint = args.linkToHubspotCompanyId
        ? `\n\nVerknüpft mit Company ${args.linkToHubspotCompanyId}.`
        : "";
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Ich möchte folgenden NEUEN Contact in HubSpot anlegen:\n\n${propLines}${linkHint}${rationaleBlock}\n\nFalls dieser Contact bereits existiert (gleiche E-Mail), sag Bescheid — sonst gibt es ein Duplikat.`,
        [
          { value: "create", label: "Anlegen", description: "POST wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };
      let createdId: string;
      try {
        const r = await createHubspotObject(crm, {
          objectType: "contacts",
          properties: props,
          ...(args.linkToHubspotCompanyId
            ? {
                associations: [
                  {
                    toObjectType: "companies" as HubspotObjectType,
                    toObjectId: args.linkToHubspotCompanyId,
                  },
                ],
              }
            : {}),
        });
        createdId = r.id;
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return {
        applied: true,
        id: createdId,
        linked: Boolean(args.linkToHubspotCompanyId),
      };
    },
  });

  // v0.1.278 — Deal-Create. Trickier: dealstage ist an pipeline gekoppelt,
  // also empfehlen wir IMMER vorher introspect zu lesen. Pflicht-Association
  // zu mindestens einer Company oder einem Contact, sonst hängen Deals
  // orphan im CRM.
  const createDealTool = defineTool({
    name: "crm_create_hubspot_deal",
    description:
      "Legt einen NEUEN Deal in HubSpot an. PROPOSE-AND-CONFIRM via ask_user_choice. PFLICHT vorher: crm_introspect_hubspot_deal auf einem existierenden Deal aufrufen, um pipeline + dealstage-Optionen zu kennen (dealstage ist an pipeline gekoppelt — falsche Kombination wird silently rejected). Pflichtfelder: dealname, pipeline, dealstage. associations (Company/Contact) ist OPTIONAL und EMPFOHLEN: gib mind. 1 Verknüpfung an, dann wird sie direkt mit angelegt; lässt du sie weg, entsteht zunächst ein Deal ohne Verknüpfung, den du danach mit crm_associate_hubspot_objects verknüpfen kannst. Optional: amount, closedate (ISO), dealtype, hubspot_owner_id, weitere Properties.",
    parameters: {
      type: "object",
      required: ["dealname", "pipeline", "dealstage"],
      properties: {
        dealname: { type: "string" },
        pipeline: { type: "string", description: "Pipeline-Internal-Name aus dem Schema." },
        dealstage: {
          type: "string",
          description:
            "Stage-Internal-Name. MUSS zur pipeline passen — vorher via crm_introspect_hubspot_deal die gültigen Kombinationen prüfen.",
        },
        amount: { type: "string", description: "Geldbetrag als String (HubSpot konvertiert)." },
        closedate: { type: "string", description: "ISO-Date (z. B. 2026-12-31)." },
        dealtype: { type: "string" },
        hubspot_owner_id: {
          type: "string",
          description: "Owner-ID (numerisch). Aus crm_list_hubspot_owners.",
        },
        properties: {
          type: "object",
          description: "Weitere HubSpot-Properties (Name → String).",
          additionalProperties: { type: "string" },
        },
        associations: {
          type: "array",
          description:
            "Optional, empfohlen: Verknüpfungen zu Company/Contact. Leer lassen ist erlaubt (Deal wird dann ohne Verknüpfung angelegt).",
          items: {
            type: "object",
            required: ["objectType", "objectId"],
            properties: {
              objectType: { type: "string", enum: ["companies", "contacts"] },
              objectId: { type: "string" },
            },
          },
        },
        rationale: { type: "string" },
      },
    },
    schema: yup
      .object({
        dealname: yup.string().trim().min(1).max(500).required(),
        pipeline: yup.string().trim().min(1).required(),
        dealstage: yup.string().trim().min(1).required(),
        amount: yup.string().trim().optional(),
        closedate: yup.string().trim().optional(),
        dealtype: yup.string().trim().optional(),
        hubspot_owner_id: yup.string().trim().optional(),
        properties: yup.object().optional(),
        associations: yup
          .array()
          .of(
            yup
              .object({
                objectType: yup.string().oneOf(["companies", "contacts"]).required(),
                objectId: yup.string().trim().min(1).required(),
              })
              .required(),
          )
          .optional()
          .default([]),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; id?: string; error?: string }) =>
      r.applied
        ? `Deal angelegt (${r.id})`
        : r.error
          ? `Fehler: ${r.error}`
          : "Deal nicht angelegt",
    run: async (args, ctx) => {
      const props: Record<string, string> = {
        dealname: args.dealname,
        pipeline: args.pipeline,
        dealstage: args.dealstage,
      };
      if (args.amount) props.amount = args.amount;
      if (args.closedate) props.closedate = args.closedate;
      if (args.dealtype) props.dealtype = args.dealtype;
      if (args.hubspot_owner_id) props.hubspot_owner_id = args.hubspot_owner_id;
      for (const [k, v] of Object.entries(
        (args.properties ?? {}) as Record<string, string>,
      )) {
        if (k in props) continue;
        props[k] = v;
      }
      const propLines = Object.entries(props)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      const assocList = args.associations ?? [];
      const assocLine =
        assocList.length > 0
          ? assocList
              .map((a) => `${a.objectType.replace(/s$/, "")} ${a.objectId}`)
              .join(", ")
          : "— (ohne Verknüpfung; danach via crm_associate_hubspot_objects verknüpfbar)";
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Ich möchte folgenden NEUEN Deal in HubSpot anlegen:\n\n${propLines}\n\nVerknüpft mit: ${assocLine}${rationaleBlock}`,
        [
          { value: "create", label: "Anlegen", description: "POST wird gesendet" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };
      try {
        const result = await createHubspotObject(crm, {
          objectType: "deals",
          properties: props,
          associations: assocList.map((a) => ({
            toObjectType: a.objectType as HubspotObjectType,
            toObjectId: a.objectId,
          })),
        });
        return { applied: true, id: result.id };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // v0.1.311 — Enrich-Tool: existierende HubSpot-Company mit AVA-
  // Daten anreichern. Spiegelt den Auto-Anreicherungs-Pfad aus
  // crm_create_hubspot_company, aber für UPDATE statt CREATE.
  // Use-Case: User hat eine HubSpot-Firma die schon existiert
  // (manuell angelegt oder ohne Daten erzeugt) und will die Felder
  // mit den neuen AVA-Erkenntnissen aktualisieren.
  const enrichCompanyFromAvaTool = defineTool({
    name: "crm_enrich_hubspot_company_from_ava",
    description:
      "Aktualisiert eine BESTEHENDE HubSpot-Company mit Daten aus AVA. Holt AVA-Daten (legalName, Adresse, Website, Domain, Headcount, Branche, Beschreibung, Umsatz aus letzter Publikation), baut den Diff gegen die aktuellen HubSpot-Werte und zeigt im Confirm-Dialog WAS geändert wird. Nur Felder mit echtem Wert in AVA + Unterschied gegen HubSpot werden vorgeschlagen. Use-Case: 'Reicher die HubSpot-Firma Strategic IT mit den neuesten AVA-Daten an.'\n\nVoraussetzung: AVA-Pipeline ist für die Firma gelaufen (sonst sagt das Tool das klar). HubSpot-companyId vorher z. B. via crm_search_hubspot_companies oder crm_list_links_for_company auflösen.",
    parameters: {
      type: "object",
      required: ["hubspotCompanyId", "avaCompanyId"],
      properties: {
        hubspotCompanyId: {
          type: "string",
          description:
            "HubSpot-companyId der zu aktualisierenden Firma.",
        },
        avaCompanyId: {
          type: "string",
          description:
            "AVA-companyId der Quell-Firma (vorher via company_search auflösen).",
        },
        rationale: {
          type: "string",
          description: "Kurze Begründung (1 Satz) für den Confirm-Dialog.",
        },
      },
    },
    schema: yup
      .object({
        hubspotCompanyId: yup.string().trim().min(1).required(),
        avaCompanyId: yup.string().trim().min(1).required(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: {
      applied: boolean;
      changedFields?: number;
      error?: string;
    }) =>
      r.applied
        ? `${r.changedFields ?? 0} Felder in HubSpot aktualisiert`
        : r.error
          ? `Fehler: ${r.error}`
          : "Anreicherung verworfen",
    run: async (args, ctx) => {
      // 1. AVA-Daten holen
      const enrich = await gatherAvaCompanyDataForHubspot(
        args.avaCompanyId,
        ctx.signal,
      );
      if (!enrich.hasData) {
        // v0.1.320 — Diagnostik im Fehler mitsenden, damit Agent + User
        // genau sehen welche Endpoints leer waren bzw. mit welchem
        // Fehler. Vorher war das "ist nicht durch die Pipeline gelaufen"
        // generisch und führte zu Frust ("aber die Daten sind doch da!").
        const diagSummary = enrich.diagnostics
          .map((d) => `${d.endpoint}=${d.ok ? "ok" : `LEER (${d.reason ?? "?"})`}`)
          .join(", ");
        return {
          applied: false,
          error:
            `Keine ergänzbaren AVA-Daten für Firma ${args.avaCompanyId} gefunden. ` +
            `Endpoint-Status: ${diagSummary}. ` +
            `Wenn alle Endpoints "LEER" zeigen: Firma wahrscheinlich noch nicht durch ` +
            `die Recherche-Pipeline. Sonst: einzelne Producer haben gefehlt — ggf. ` +
            `re-run, dann erneut versuchen.`,
        };
      }
      // 2. Aktuelle HubSpot-Werte holen für Diff
      const intro = await introspectHubspotObject(
        crm,
        "companies",
        args.hubspotCompanyId,
      );
      // 3. Diff: nur Felder die in HubSpot fehlen ODER abweichen
      const toUpdate: Record<string, string> = {};
      const diffLines: string[] = [];
      const schemaByName = new Map(intro.schema.map((p) => [p.name, p]));
      for (const [name, newVal] of Object.entries(enrich.props)) {
        const current = intro.currentValues[name];
        if (current === newVal) continue; // identisch
        if (current && String(current).trim() === String(newVal).trim()) continue;
        toUpdate[name] = newVal;
        const label = schemaByName.get(name)?.label ?? name;
        const oldDisplay = current ? String(current) : "(leer)";
        diffLines.push(`  ${label} (${name}): ${oldDisplay} → ${newVal}`);
      }
      if (Object.keys(toUpdate).length === 0) {
        // v0.1.320 — Auch hier Diagnostik im Fehler. Wenn nichts geupdatet
        // wird, möchte der Agent (und der User) wissen: lag es daran dass
        // die HubSpot-Felder schon befüllt waren, oder hat AVA von Anfang
        // an keine Daten für diese Felder geliefert?
        const gatheredFields = Object.keys(enrich.props);
        const detail =
          gatheredFields.length === 0
            ? "AVA hat KEINE Properties geliefert obwohl Endpoints geantwortet haben — vermutlich gibt's diese Felder noch nicht in den Producer-Ergebnissen."
            : `AVA hat geliefert: ${gatheredFields.join(", ")}. Diese Felder sind in HubSpot bereits identisch.`;
        return {
          applied: false,
          changedFields: 0,
          gatheredFields,
          sources: enrich.sources,
          error: `Keine Änderungen. ${detail}`,
        };
      }
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Ich möchte die HubSpot-Company ${args.hubspotCompanyId} mit AVA-Daten anreichern:\n\n${diffLines.join("\n")}${rationaleBlock}\n\nAVA-Quellen: ${enrich.sources.join(", ")}.`,
        [
          {
            value: "apply",
            label: "Übernehmen",
            description: "PATCH wird an HubSpot gesendet",
          },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "apply") return { applied: false, changedFields: 0 };
      try {
        await updateHubspotObject(crm, {
          objectType: "companies",
          objectId: args.hubspotCompanyId,
          properties: toUpdate,
        });
        return { applied: true, changedFields: Object.keys(toUpdate).length };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // v0.1.278 — Delete-Tools (Phase 2). HubSpot's DELETE ist ein soft-
  // delete: Record landet für 90 Tage im "archived"-Zustand, wieder-
  // herstellbar via Admin-UI. Danach endgültig weg. Confirm zeigt eine
  // Record-Vorschau damit der User nicht versehentlich den falschen
  // löscht.
  const buildDeleteTool = (objectType: HubspotObjectType, label: string): Tool => {
    return defineTool({
      name: `crm_delete_hubspot_${SINGULAR[objectType]}`,
      description: `Löscht (= archiviert) einen HubSpot-${label}. PROPOSE-AND-CONFIRM via ask_user_choice mit Record-Vorschau. HubSpot stellt den Record 90 Tage lang wieder her — danach endgültig weg. Bei Companies/Contacts/Deals werden Verknüpfungen automatisch gelöst, die verbundenen Records selbst bleiben erhalten.`,
      parameters: {
        type: "object",
        required: ["objectId"],
        properties: {
          objectId: { type: "string" },
          rationale: { type: "string", description: "Begründung (1 Satz)." },
        },
      },
      schema: yup
        .object({
          objectId: yup.string().trim().min(1).required(),
          rationale: yup.string().trim().max(500).optional(),
        })
        .noUnknown(true),
      preview: (r: { applied: boolean; error?: string }) =>
        r.applied
          ? `${label} gelöscht`
          : r.error
            ? `Fehler: ${r.error}`
            : "Nicht gelöscht",
      run: async (args, ctx) => {
        const preview = await previewHubspotObject(crm, {
          objectType,
          objectId: args.objectId,
        });
        if (!preview) {
          return {
            applied: false,
            error: `${label} ${args.objectId} nicht gefunden — möglicherweise schon gelöscht.`,
          };
        }
        const summary = Object.entries(preview)
          .filter(([, v]) => v != null && v !== "")
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        const rationaleBlock = args.rationale
          ? `\n\nBegründung: ${args.rationale}`
          : "";
        const value = await ctx.ui.askChoice(
          `Soll ich folgenden ${label} in HubSpot LÖSCHEN?\n\nID: ${args.objectId}\n${summary}${rationaleBlock}\n\nHubSpot archiviert den Record 90 Tage lang — bis dahin kannst du ihn im HubSpot-Admin wiederherstellen.`,
          [
            { value: "delete", label: "Löschen", description: "DELETE wird gesendet" },
            { value: "cancel", label: "Behalten" },
          ],
          ctx.signal,
        );
        if (value !== "delete") return { applied: false };
        try {
          await deleteHubspotObject(crm, { objectType, objectId: args.objectId });
          return { applied: true };
        } catch (err) {
          return {
            applied: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    });
  };

  const deleteCompanyTool = buildDeleteTool("companies", "Company");
  const deleteContactTool = buildDeleteTool("contacts", "Contact");
  const deleteDealTool = buildDeleteTool("deals", "Deal");
  const deleteNoteTool = buildDeleteTool("notes", "Note");
  const deleteTaskTool = buildDeleteTool("tasks", "Task");

  return [
    statusTool,
    connectTool,
    disconnectTool,
    listLinksTool,
    fetchDetailsRawTool,
    enrichNowTool,
    searchHubspotTool,
    linkManualTool,
    introspectHubspotTool,
    updateHubspotTool,
    contactPair.introspect,
    contactPair.update,
    dealPair.introspect,
    dealPair.update,
    notePair.introspect,
    notePair.update,
    taskPair.introspect,
    taskPair.update,
    searchContactsTool,
    searchDealsTool,
    listOwnersTool,
    listAssociationsTool,
    associateTool,
    disassociateTool,
    createCompanyTool,
    syncCompanyTool,
    enrichCompanyFromAvaTool,
    createContactTool,
    createDealTool,
    createNoteTool,
    createTaskTool,
    deleteCompanyTool,
    deleteContactTool,
    deleteDealTool,
    deleteNoteTool,
    deleteTaskTool,
    listTasksTool,
    listNotesForObjectTool,
    completeTaskTool,
  ];
}

const OBJECT_LABEL: Record<HubspotObjectType, string> = {
  companies: "Company",
  contacts: "Contact",
  deals: "Deal",
  notes: "Note",
  tasks: "Task",
};
