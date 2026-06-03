// v0.1.264 — HubSpot Object Write-Pfade (Phase H, generalisiert).
//
// Ersetzt write-companies.ts. Die ursprüngliche Implementierung war
// hartcoded für "companies"; jetzt parametrisiert über objectType
// ("companies" | "contacts" | "deals"), weil die HubSpot-API-Pfade
// und Schema-Behandlung für alle drei Object-Types nahezu identisch
// sind:
//
//   /crm/v3/properties/{objectType}      → Schema
//   /crm/v3/objects/{objectType}/{id}    → GET/PATCH
//
// Backward-compat: die alten introspectHubspotCompany /
// updateHubspotCompany-Wrapper bleiben als dünne Funktionen erhalten
// damit existierende Imports nicht brechen.
//
// Compute-Locality: HubSpot-API direkt vom main-process, kein
// Gateway-Hop. Access-Token aus CrmManager.

import type { CrmManager } from ".";

const HUBSPOT_API = "https://api.hubapi.com";

export type HubspotObjectType =
  | "companies"
  | "contacts"
  | "deals"
  | "notes"
  | "tasks"
  // v0.1.374 — Engagement-/Aktivitäts-Typen, damit AVA echte
  // „Anruf/E-Mail/Meeting protokollieren" statt nur „Notiz" anlegen kann.
  | "calls"
  | "emails"
  | "meetings";

// ---- Property-Schema (introspect) ----------------------------------------

export interface HubspotPropertyOption {
  label: string;
  value: string;
  description?: string;
}

export interface HubspotPropertySchema {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  description: string | null;
  options: HubspotPropertyOption[];
  readOnlyValue: boolean;
  hidden: boolean;
}

export interface IntrospectResult {
  objectType: HubspotObjectType;
  objectId: string;
  currentValues: Record<string, string | null>;
  schema: HubspotPropertySchema[];
}

/** Filter für read-only / system-properties. Pro objectType etwas
 *  großzügiger bei `hs_*`-Properties die für Sales-Workflows nützlich sind. */
function isUserEditableProperty(
  objectType: HubspotObjectType,
  p: {
    name: string;
    calculated?: boolean;
    hidden?: boolean;
    modificationMetadata?: { readOnlyValue?: boolean };
  },
): boolean {
  if (p.calculated) return false;
  if (p.modificationMetadata?.readOnlyValue) return false;
  if (p.hidden) return false;
  // Whitelist sinnvoller hs_*-Properties pro Object-Type. Notes + Tasks
  // sind primär hs_*-driven (das ist der HubSpot-Engagement-Style), also
  // sind die Whitelists hier großzügig.
  const HS_WHITELIST: Record<HubspotObjectType, Set<string>> = {
    companies: new Set(["hs_lead_status"]),
    contacts: new Set([
      "hs_lead_status",
      "hs_persona",
      "hs_buying_role",
      "hs_marketable_status",
      "hs_marketable_reason_id",
    ]),
    deals: new Set([
      "hs_deal_stage_probability",
      "hs_priority",
      "hs_forecast_amount",
      "hs_forecast_probability",
      "hs_acv",
      "hs_arr",
      "hs_mrr",
      "hs_tcv",
    ]),
    notes: new Set([
      "hs_note_body",
      "hs_timestamp",
      "hs_attachment_ids",
    ]),
    tasks: new Set([
      "hs_task_subject",
      "hs_task_body",
      "hs_task_status",
      "hs_task_priority",
      "hs_task_type",
      "hs_task_completion_date",
      "hs_timestamp",
    ]),
    // v0.1.374 — Engagement-Typen sind komplett hs_*-driven.
    calls: new Set([
      "hs_call_title",
      "hs_call_body",
      "hs_call_direction",
      "hs_call_disposition",
      "hs_call_duration",
      "hs_call_status",
      "hs_call_from_number",
      "hs_call_to_number",
      "hs_timestamp",
    ]),
    emails: new Set([
      "hs_email_subject",
      "hs_email_text",
      "hs_email_html",
      "hs_email_direction",
      "hs_email_status",
      "hs_email_headers",
      "hs_timestamp",
    ]),
    meetings: new Set([
      "hs_meeting_title",
      "hs_meeting_body",
      "hs_meeting_location",
      "hs_meeting_start_time",
      "hs_meeting_end_time",
      "hs_meeting_outcome",
      "hs_timestamp",
    ]),
  };
  if (p.name.startsWith("hs_") && !HS_WHITELIST[objectType].has(p.name)) {
    return false;
  }
  return true;
}

export async function introspectHubspotObject(
  crm: CrmManager,
  objectType: HubspotObjectType,
  objectId: string,
): Promise<IntrospectResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) {
    throw new Error(
      "HubSpot ist nicht verbunden. Bitte zuerst in den Einstellungen verbinden.",
    );
  }

  // 1. Schema
  const schemaJson = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/properties/${objectType}`,
  )) as {
    results?: Array<{
      name: string;
      label: string;
      type: string;
      fieldType: string;
      description?: string | null;
      options?: Array<{ label: string; value: string; description?: string; hidden?: boolean }>;
      modificationMetadata?: { readOnlyValue?: boolean };
      hidden?: boolean;
      calculated?: boolean;
    }>;
  };

  const schema: HubspotPropertySchema[] = (schemaJson.results ?? [])
    .filter((p) => isUserEditableProperty(objectType, p))
    .map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      description: (p.description ?? "").trim() || null,
      options: (p.options ?? [])
        .filter((o) => !o.hidden)
        .map((o) => ({
          label: o.label,
          value: o.value,
          ...(o.description ? { description: o.description } : {}),
        })),
      readOnlyValue: p.modificationMetadata?.readOnlyValue ?? false,
      hidden: p.hidden ?? false,
    }));

  // 2. Aktuelle Werte (Batches von 100 Property-Namen wegen URL-Länge)
  const writableNames = schema.map((p) => p.name);
  const currentValues: Record<string, string | null> = {};
  for (let i = 0; i < writableNames.length; i += 100) {
    const slice = writableNames.slice(i, i + 100);
    const url = new URL(
      `${HUBSPOT_API}/crm/v3/objects/${objectType}/${encodeURIComponent(objectId)}`,
    );
    url.searchParams.set("properties", slice.join(","));
    const json = (await hubspotFetch(accessToken, url.toString())) as {
      properties?: Record<string, string | null>;
    };
    for (const [k, v] of Object.entries(json.properties ?? {})) {
      currentValues[k] = v ?? null;
    }
  }

  return { objectType, objectId, currentValues, schema };
}

// ---- Update (PATCH + Verify-after) ---------------------------------------

export interface UpdateInput {
  objectType: HubspotObjectType;
  objectId: string;
  properties: Record<string, string>;
}

export interface UpdateResult {
  ok: boolean;
  objectType: HubspotObjectType;
  objectId: string;
  diff: Array<{
    name: string;
    before: string | null;
    after: string | null;
    applied: boolean;
  }>;
  notApplied: string[];
}

export async function updateHubspotObject(
  crm: CrmManager,
  input: UpdateInput,
): Promise<UpdateResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");

  const propsToTouch = Object.keys(input.properties);
  if (propsToTouch.length === 0) {
    return {
      ok: true,
      objectType: input.objectType,
      objectId: input.objectId,
      diff: [],
      notApplied: [],
    };
  }

  const objectUrl = `${HUBSPOT_API}/crm/v3/objects/${input.objectType}/${encodeURIComponent(input.objectId)}`;

  // 1. Vorher-Snapshot
  const beforeUrl = new URL(objectUrl);
  beforeUrl.searchParams.set("properties", propsToTouch.join(","));
  const beforeJson = (await hubspotFetch(accessToken, beforeUrl.toString())) as {
    properties?: Record<string, string | null>;
  };
  const before = beforeJson.properties ?? {};

  // 2. PATCH
  await hubspotFetch(accessToken, objectUrl, {
    method: "PATCH",
    body: JSON.stringify({ properties: input.properties }),
  });

  // 3. Fresh-GET (Ground-Truth gegen No-Op-Bugs — Notion-Lesson v0.1.255)
  const afterUrl = new URL(objectUrl);
  afterUrl.searchParams.set("properties", propsToTouch.join(","));
  const afterJson = (await hubspotFetch(accessToken, afterUrl.toString())) as {
    properties?: Record<string, string | null>;
  };
  const after = afterJson.properties ?? {};

  // 4. Diff
  const diff: UpdateResult["diff"] = [];
  const notApplied: string[] = [];
  for (const [name, intended] of Object.entries(input.properties)) {
    const beforeVal = before[name] ?? null;
    const afterVal = after[name] ?? null;
    const applied = normalize(afterVal) === normalize(intended);
    diff.push({ name, before: beforeVal, after: afterVal, applied });
    if (!applied) notApplied.push(name);
  }

  return {
    ok: notApplied.length === 0,
    objectType: input.objectType,
    objectId: input.objectId,
    diff,
    notApplied,
  };
}

function normalize(v: string | null): string {
  if (v == null) return "";
  return String(v).trim();
}

// ---- Backward-compat-Wrapper für die v0.1.263-API ------------------------

export async function introspectHubspotCompany(
  crm: CrmManager,
  companyId: string,
): Promise<IntrospectResult & { companyId: string }> {
  const result = await introspectHubspotObject(crm, "companies", companyId);
  return { ...result, companyId };
}

export async function updateHubspotCompany(
  crm: CrmManager,
  input: { companyId: string; properties: Record<string, string> },
): Promise<UpdateResult & { companyId: string }> {
  const result = await updateHubspotObject(crm, {
    objectType: "companies",
    objectId: input.companyId,
    properties: input.properties,
  });
  return { ...result, companyId: input.companyId };
}

// ---- Search (Contacts + Deals) -------------------------------------------

export interface ContactSearchResult {
  items: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    jobTitle: string | null;
    company: string | null;
  }>;
}

export async function searchHubspotContacts(
  crm: CrmManager,
  args: { query: string; limit?: number },
): Promise<ContactSearchResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const json = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/objects/contacts/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: args.query,
        properties: ["firstname", "lastname", "email", "jobtitle", "company"],
        limit,
      }),
    },
  )) as {
    results?: Array<{
      id: string;
      properties: Record<string, string | null | undefined>;
    }>;
  };
  return {
    items: (json.results ?? []).map((r) => ({
      id: r.id,
      firstName: trimOrNull(r.properties.firstname),
      lastName: trimOrNull(r.properties.lastname),
      email: trimOrNull(r.properties.email),
      jobTitle: trimOrNull(r.properties.jobtitle),
      company: trimOrNull(r.properties.company),
    })),
  };
}

export interface DealSearchResult {
  items: Array<{
    id: string;
    name: string | null;
    amount: string | null;
    stage: string | null;
    pipeline: string | null;
    closeDate: string | null;
  }>;
}

export async function searchHubspotDeals(
  crm: CrmManager,
  args: { query: string; limit?: number },
): Promise<DealSearchResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const json = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/objects/deals/search`,
    {
      method: "POST",
      body: JSON.stringify({
        query: args.query,
        properties: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
        limit,
      }),
    },
  )) as {
    results?: Array<{
      id: string;
      properties: Record<string, string | null | undefined>;
    }>;
  };
  return {
    items: (json.results ?? []).map((r) => ({
      id: r.id,
      name: trimOrNull(r.properties.dealname),
      amount: trimOrNull(r.properties.amount),
      stage: trimOrNull(r.properties.dealstage),
      pipeline: trimOrNull(r.properties.pipeline),
      closeDate: trimOrNull(r.properties.closedate),
    })),
  };
}

// ---- Owners --------------------------------------------------------------

export interface HubspotOwner {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  archived: boolean;
}

/** Liefert alle aktiven Owner des Portals. HubSpot-Owner-Listen sind
 *  typischerweise klein (Team-Größen), wir lassen die Pagination weg
 *  und holen die ersten 500 — bei Bedarf erweiterbar. */
export async function listHubspotOwners(
  crm: CrmManager,
): Promise<HubspotOwner[]> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const url = new URL(`${HUBSPOT_API}/crm/v3/owners`);
  url.searchParams.set("limit", "500");
  url.searchParams.set("archived", "false");
  const json = (await hubspotFetch(accessToken, url.toString())) as {
    results?: Array<{
      id: string;
      email?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      archived?: boolean;
    }>;
  };
  return (json.results ?? []).map((o) => ({
    id: o.id,
    email: trimOrNull(o.email),
    firstName: trimOrNull(o.firstName),
    lastName: trimOrNull(o.lastName),
    archived: o.archived ?? false,
  }));
}

// ---- Create (Notes / Tasks etc.) -----------------------------------------
//
// Create-Pfad ist NEU in v0.1.266 — bisher waren alle Tools update-only
// (bewusst, weil Create-from-Chat schwer rückgängig zu machen ist).
// Für Notes und Tasks ist Create aber der Haupt-Use-Case: "schreib mir
// eine Notiz zu ACME" / "leg mir eine Aufgabe an". Update bleibt zusätz-
// lich verfügbar (Status setzen, Task-Body anpassen).
//
// Associations werden inline beim Create mitgegeben — das ist HubSpot-
// Standard für Notes/Tasks, weil ein verwaister Note ohne Bezug zu
// Company/Contact/Deal in der UI quasi unauffindbar wird.

export interface CreateInput {
  objectType: HubspotObjectType;
  properties: Record<string, string>;
  /** Inline-Associations zum Zeitpunkt der Anlage. Default-Type pro
   *  Object-Type wird automatisch gewählt (Notes/Tasks ↔ Companies =
   *  202, ↔ Contacts = 200/204, ↔ Deals = 214). HubSpot selbst nimmt
   *  den richtigen Default wenn man die associationCategory leer
   *  lässt — wir nutzen deshalb HUBSPOT_DEFINED + den entsprechenden
   *  default-typeId. */
  associations?: Array<{
    toObjectType: HubspotObjectType;
    toObjectId: string;
  }>;
}

export interface CreateResult {
  id: string;
  /** Voll-Object wie HubSpot zurückgibt (für UI-Preview). */
  raw: Record<string, unknown>;
}

/** Default-Association-Type-IDs aus HubSpot v4 — DIRECTIONAL (from→to).
 *  Aus dem stabil dokumentierten HUBSPOT_DEFINED-Catalog hardcoded,
 *  Live-Lookup pro Create wäre zu teuer.
 *
 *  v0.1.283 — vorher hatten wir nur NOTE_TASK_DEFAULT_TYPE_IDS, das
 *  fälschlich auch für Contact→Company-Inline-Assoc beim Contact-Create
 *  genommen wurde. Resultat: HubSpot warf "invalid from object type 0-1
 *  for associations to be created. expected: 0-46. For definition 0-190".
 *  Type 190 ist Note→Company (FROM=note), nicht Contact→Company. Jetzt
 *  korrekt directional getrennt. */
const DEFAULT_ASSOC_TYPE_ID: Partial<
  Record<HubspotObjectType, Partial<Record<HubspotObjectType, number>>>
> = {
  // v0.1.347 — Deal-Richtungen waren paarweise VERTAUSCHT (Label-Kommentar
  // stimmte, Zahl nicht). HubSpot HUBSPOT_DEFINED-Defaults (primary):
  //   deal_to_contact=3, contact_to_deal=4, deal_to_company=5,
  //   company_to_deal=6. Vorher stand deal_to_company=6 (= company_to_deal)
  //   etc. → crm_create_hubspot_deal mit Company-Inline-Assoc warf HTTP 400
  //   („invalid association type"). Jetzt korrekt.
  contacts: {
    companies: 1, // contact_to_company (primary)
    deals: 4, // contact_to_deal
  },
  companies: {
    contacts: 2, // company_to_contact (primary)
    deals: 6, // company_to_deal
  },
  deals: {
    contacts: 3, // deal_to_contact
    companies: 5, // deal_to_company
  },
  notes: {
    companies: 190, // note_to_company
    contacts: 202, // note_to_contact
    deals: 214, // note_to_deal
  },
  tasks: {
    companies: 192, // task_to_company
    contacts: 204, // task_to_contact
    deals: 216, // task_to_deal
  },
  // v0.1.374 — Engagement→Objekt-Default-Assoc-IDs (HUBSPOT_DEFINED).
  calls: {
    companies: 182, // call_to_company
    contacts: 194, // call_to_contact
    deals: 206, // call_to_deal
  },
  emails: {
    companies: 186, // email_to_company
    contacts: 198, // email_to_contact
    deals: 210, // email_to_deal
  },
  meetings: {
    companies: 188, // meeting_to_company
    contacts: 200, // meeting_to_contact
    deals: 212, // meeting_to_deal
  },
};

export async function createHubspotObject(
  crm: CrmManager,
  input: CreateInput,
): Promise<CreateResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");

  const body: Record<string, unknown> = {
    properties: input.properties,
  };

  if (input.associations && input.associations.length > 0) {
    body.associations = input.associations.map((a) => {
      const typeId =
        DEFAULT_ASSOC_TYPE_ID[input.objectType]?.[a.toObjectType];
      if (typeId == null) {
        throw new Error(
          `Keine Default-Association-Type-ID für ${input.objectType} → ${a.toObjectType} bekannt.`,
        );
      }
      return {
        to: { id: a.toObjectId },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: typeId,
          },
        ],
      };
    });
  }

  const json = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/objects/${input.objectType}`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  )) as { id: string } & Record<string, unknown>;

  return { id: json.id, raw: json };
}

// ---- Delete (soft, archive in HubSpot-Terminologie) ----------------------
//
// HubSpot's DELETE-Endpoint ist ein soft-delete: der Record geht für
// 90 Tage in einen "archived"-Zustand und kann via Admin-UI wieder-
// hergestellt werden. Danach endgültig weg. Vorab im Confirm-Dialog
// genau das so kommunizieren.

export interface DeleteResult {
  ok: true;
  objectType: HubspotObjectType;
  objectId: string;
}

export async function deleteHubspotObject(
  crm: CrmManager,
  args: { objectType: HubspotObjectType; objectId: string },
): Promise<DeleteResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const url = `${HUBSPOT_API}/crm/v3/objects/${args.objectType}/${encodeURIComponent(args.objectId)}`;
  await hubspotFetch(accessToken, url, { method: "DELETE" });
  return { ok: true, objectType: args.objectType, objectId: args.objectId };
}

/** Read-only-Vorschau für den Delete-Confirm-Dialog. Pro Object-Type
 *  zeigen wir Felder, die der User beim Löschen "wiedererkennt".
 *  Liefert null wenn nicht gefunden (z. B. schon gelöscht). */
export async function previewHubspotObject(
  crm: CrmManager,
  args: { objectType: HubspotObjectType; objectId: string },
): Promise<Record<string, string | null> | null> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const PREVIEW_PROPS: Record<HubspotObjectType, string[]> = {
    companies: ["name", "domain", "city", "industry", "lifecyclestage"],
    contacts: ["firstname", "lastname", "email", "company", "jobtitle"],
    deals: ["dealname", "amount", "dealstage", "pipeline", "closedate"],
    notes: ["hs_note_body", "hs_timestamp"],
    tasks: ["hs_task_subject", "hs_task_status", "hs_task_priority", "hs_timestamp"],
    calls: ["hs_call_title", "hs_call_body", "hs_call_direction", "hs_timestamp"],
    emails: ["hs_email_subject", "hs_email_text", "hs_email_direction", "hs_timestamp"],
    meetings: ["hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_timestamp"],
  };
  const url = new URL(
    `${HUBSPOT_API}/crm/v3/objects/${args.objectType}/${encodeURIComponent(args.objectId)}`,
  );
  url.searchParams.set("properties", PREVIEW_PROPS[args.objectType].join(","));
  try {
    const json = (await hubspotFetch(accessToken, url.toString())) as {
      properties?: Record<string, string | null>;
    };
    return json.properties ?? {};
  } catch {
    return null;
  }
}

// ---- Engagement-Listings (Notes/Tasks per Filter) ------------------------

export interface TaskListEntry {
  id: string;
  subject: string | null;
  status: string | null; // NOT_STARTED, IN_PROGRESS, COMPLETED, WAITING, DEFERRED
  priority: string | null; // LOW, MEDIUM, HIGH
  type: string | null; // EMAIL, CALL, TODO
  ownerId: string | null;
  dueAt: string | null;
  completedAt: string | null;
}

export interface ListTasksFilter {
  ownerId?: string;
  statuses?: string[];
  /** ISO-Timestamp — nur Tasks deren hs_timestamp ≤ dueBy. */
  dueBy?: string;
  limit?: number;
}

export async function listHubspotTasks(
  crm: CrmManager,
  filter: ListTasksFilter,
): Promise<{ items: TaskListEntry[] }> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 200));

  const filterGroups: Array<{ filters: Array<Record<string, unknown>> }> = [];
  const baseFilters: Array<Record<string, unknown>> = [];
  if (filter.ownerId) {
    baseFilters.push({
      propertyName: "hubspot_owner_id",
      operator: "EQ",
      value: filter.ownerId,
    });
  }
  if (filter.dueBy) {
    baseFilters.push({
      propertyName: "hs_timestamp",
      operator: "LTE",
      value: filter.dueBy,
    });
  }
  if (filter.statuses && filter.statuses.length > 0) {
    // HubSpot Search erlaubt IN-Operator
    baseFilters.push({
      propertyName: "hs_task_status",
      operator: "IN",
      values: filter.statuses,
    });
  }
  if (baseFilters.length > 0) {
    filterGroups.push({ filters: baseFilters });
  }

  const json = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/objects/tasks/search`,
    {
      method: "POST",
      body: JSON.stringify({
        filterGroups,
        properties: [
          "hs_task_subject",
          "hs_task_status",
          "hs_task_priority",
          "hs_task_type",
          "hs_timestamp",
          "hs_task_completion_date",
          "hubspot_owner_id",
        ],
        sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
        limit,
      }),
    },
  )) as {
    results?: Array<{
      id: string;
      properties: Record<string, string | null | undefined>;
    }>;
  };

  return {
    items: (json.results ?? []).map((r) => ({
      id: r.id,
      subject: trimOrNull(r.properties.hs_task_subject),
      status: trimOrNull(r.properties.hs_task_status),
      priority: trimOrNull(r.properties.hs_task_priority),
      type: trimOrNull(r.properties.hs_task_type),
      ownerId: trimOrNull(r.properties.hubspot_owner_id),
      dueAt: trimOrNull(r.properties.hs_timestamp),
      completedAt: trimOrNull(r.properties.hs_task_completion_date),
    })),
  };
}

export interface NoteListEntry {
  id: string;
  body: string | null;
  createdAt: string | null;
  ownerId: string | null;
}

export async function listHubspotNotesForObject(
  crm: CrmManager,
  args: {
    objectType: HubspotObjectType;
    objectId: string;
    limit?: number;
  },
): Promise<{ items: NoteListEntry[] }> {
  // Vorgehen: erst Associations Object → notes auflisten, dann Notes-IDs
  // per batch-read holen. Direktes Such-Filter über Associations gibt's
  // bei HubSpot nicht.
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  const assoc = await listHubspotAssociations(crm, {
    fromObjectType: args.objectType,
    fromObjectId: args.objectId,
    toObjectType: "notes",
  });
  const noteIds = assoc.associations.slice(0, limit).map((a) => a.toObjectId);
  if (noteIds.length === 0) return { items: [] };

  const json = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/objects/notes/batch/read`,
    {
      method: "POST",
      body: JSON.stringify({
        inputs: noteIds.map((id) => ({ id })),
        properties: ["hs_note_body", "hs_timestamp", "hubspot_owner_id"],
      }),
    },
  )) as {
    results?: Array<{
      id: string;
      properties: Record<string, string | null | undefined>;
    }>;
  };

  return {
    items: (json.results ?? [])
      .map((r) => ({
        id: r.id,
        body: trimOrNull(r.properties.hs_note_body),
        createdAt: trimOrNull(r.properties.hs_timestamp),
        ownerId: trimOrNull(r.properties.hubspot_owner_id),
      }))
      // Neueste zuerst
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")),
  };
}

// ---- Associations (HubSpot v4) -------------------------------------------
//
// HubSpot v4 Associations: jede Verknüpfung zwischen zwei Object-Records
// hat genau einen Association-Type. Die häufigsten sind "default"
// (Company→Contact: primary contact, Company→Deal: primary deal,
// Contact→Deal: deal-contact-relation). Für Standard-CRM-Workflows
// reicht der default-Typ — Custom-Association-Types lassen wir bewusst
// weg, weil die UX dafür eine eigene Schema-Introspection bräuchte.
//
// Endpoints:
//   GET    /crm/v4/objects/{from}/{fromId}/associations/{to}
//   PUT    /crm/v4/objects/{from}/{fromId}/associations/default/{to}/{toId}
//   DELETE /crm/v4/objects/{from}/{fromId}/associations/{to}/{toId}

export interface AssociationEntry {
  toObjectId: string;
  /** v4-Antworten geben einen Array von Association-Type-Records;
   *  wir konsolidieren auf die labels. Leer wenn nur "default". */
  associationTypeLabels: string[];
}

export async function listHubspotAssociations(
  crm: CrmManager,
  args: {
    fromObjectType: HubspotObjectType;
    fromObjectId: string;
    toObjectType: HubspotObjectType;
  },
): Promise<{ associations: AssociationEntry[] }> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const url = `${HUBSPOT_API}/crm/v4/objects/${args.fromObjectType}/${encodeURIComponent(args.fromObjectId)}/associations/${args.toObjectType}`;
  const json = (await hubspotFetch(accessToken, url)) as {
    results?: Array<{
      toObjectId: number | string;
      associationTypes?: Array<{ label?: string | null; typeId?: number; category?: string }>;
    }>;
  };
  return {
    associations: (json.results ?? []).map((r) => ({
      toObjectId: String(r.toObjectId),
      associationTypeLabels: (r.associationTypes ?? [])
        .map((t) => t.label)
        .filter((l): l is string => !!l && l.length > 0),
    })),
  };
}

export async function associateHubspotObjects(
  crm: CrmManager,
  args: {
    fromObjectType: HubspotObjectType;
    fromObjectId: string;
    toObjectType: HubspotObjectType;
    toObjectId: string;
  },
): Promise<{ ok: true }> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const url = `${HUBSPOT_API}/crm/v4/objects/${args.fromObjectType}/${encodeURIComponent(args.fromObjectId)}/associations/default/${args.toObjectType}/${encodeURIComponent(args.toObjectId)}`;
  // PUT mit leerem Body — HubSpot v4 erwartet das exakt so für default-Type
  await hubspotFetch(accessToken, url, { method: "PUT" });
  return { ok: true };
}

export async function disassociateHubspotObjects(
  crm: CrmManager,
  args: {
    fromObjectType: HubspotObjectType;
    fromObjectId: string;
    toObjectType: HubspotObjectType;
    toObjectId: string;
  },
): Promise<{ ok: true }> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) throw new Error("HubSpot ist nicht verbunden.");
  const url = `${HUBSPOT_API}/crm/v4/objects/${args.fromObjectType}/${encodeURIComponent(args.fromObjectId)}/associations/${args.toObjectType}/${encodeURIComponent(args.toObjectId)}`;
  await hubspotFetch(accessToken, url, { method: "DELETE" });
  return { ok: true };
}

// ---- HTTP-Helper ---------------------------------------------------------

function trimOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

async function hubspotFetch(
  accessToken: string,
  url: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      throw new Error(
        "HubSpot hat die Anmeldung abgelehnt (401). Bitte Verbindung erneut herstellen.",
      );
    }
    if (res.status === 403) {
      throw new Error(
        "HubSpot lehnt den Schreibzugriff ab (403). Möglicherweise fehlt ein OAuth-Scope — bitte Verbindung trennen und neu autorisieren.",
      );
    }
    throw new Error(`HubSpot API-Fehler ${res.status}: ${body.slice(0, 400)}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
