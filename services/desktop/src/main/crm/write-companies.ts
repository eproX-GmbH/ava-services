// v0.1.263 — HubSpot Company Write-Pfade (Phase H).
//
// Bisher waren alle CRM-Tools read-only (siehe fetch-enrichment.ts +
// fetch-companies.ts). Mit der Notion-Erfahrung aus v0.1.244–v0.1.255
// im Gepäck baut diese Datei zwei Schreiboperationen:
//
//   - introspectHubspotCompany: liest das Property-Schema (Name, Typ,
//     enum-Optionen) sowie die aktuellen Werte einer Company.
//   - updateHubspotCompany: PATCHt eine oder mehrere Properties.
//     Fresh-GET-Verify nach dem PATCH — siehe Notion-Lesson v0.1.255,
//     wo HTTP 200 zurückkam, server-seitig aber nichts gespeichert wurde.
//
// Compute-Locality: HubSpot-API-Calls laufen direkt im main-process,
// kein Gateway-Hop. Access-Token kommt aus CrmManager (safeStorage-
// verschlüsselt), verlässt die Maschine nur Richtung api.hubapi.com.

import type { CrmManager } from ".";

const HUBSPOT_API = "https://api.hubapi.com";

// ---- Property-Schema (introspect) ----------------------------------------

export interface HubspotPropertyOption {
  label: string;
  value: string;
  description?: string;
}

export interface HubspotPropertySchema {
  name: string;
  label: string;
  type: string; // "string" | "number" | "date" | "datetime" | "enumeration" | "bool"
  fieldType: string; // "text", "select", "checkbox", "date", ...
  description: string | null;
  options: HubspotPropertyOption[]; // leer wenn nicht enum
  readOnlyValue: boolean;
  hidden: boolean;
}

export interface IntrospectResult {
  companyId: string;
  /** Alle aktuell gesetzten Properties (Name → Wert) für die Company. */
  currentValues: Record<string, string | null>;
  /** Property-Schema für alle Properties die der CRM-User pflegen kann.
   *  Filtert read-only-Felder (hs_object_id etc.) raus. */
  schema: HubspotPropertySchema[];
}

/** Holt Property-Schema (cache-bar) UND die aktuellen Werte der Company.
 *  Der Agent ruft das auf, BEVOR er eine Update-PATCH baut. */
export async function introspectHubspotCompany(
  crm: CrmManager,
  companyId: string,
): Promise<IntrospectResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) {
    throw new Error(
      "HubSpot ist nicht verbunden. Bitte zuerst in den Einstellungen verbinden.",
    );
  }

  // 1. Schema (alle Properties des Companies-Objects)
  const schemaJson = (await hubspotFetch(
    accessToken,
    `${HUBSPOT_API}/crm/v3/properties/companies`,
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
    .filter((p) => {
      // Read-only-Felder + System-Properties rausfiltern — verwirren
      // nur und können vom Agent eh nicht beschrieben werden.
      if (p.calculated) return false;
      if (p.modificationMetadata?.readOnlyValue) return false;
      if (p.hidden) return false;
      if (p.name.startsWith("hs_") && p.name !== "hs_lead_status") return false;
      return true;
    })
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

  // 2. Aktuelle Werte der Company (für die Felder, die wir bearbeiten dürfen).
  // HubSpot's GET /companies/{id} liefert nur Properties, die wir explizit
  // anfordern. Wir requeresten alles aus dem (gefilterten) Schema in
  // Batches á 100 (HubSpot's `properties`-Query-Param hat ein Längen-Limit
  // bei sehr großen Schemas).
  const writableNames = schema.map((p) => p.name);
  const currentValues: Record<string, string | null> = {};
  for (let i = 0; i < writableNames.length; i += 100) {
    const slice = writableNames.slice(i, i + 100);
    const url = new URL(
      `${HUBSPOT_API}/crm/v3/objects/companies/${encodeURIComponent(companyId)}`,
    );
    url.searchParams.set("properties", slice.join(","));
    const json = (await hubspotFetch(accessToken, url.toString())) as {
      properties?: Record<string, string | null>;
    };
    for (const [k, v] of Object.entries(json.properties ?? {})) {
      currentValues[k] = v ?? null;
    }
  }

  return { companyId, currentValues, schema };
}

// ---- Update (PATCH + Verify-after) ---------------------------------------

export interface UpdateInput {
  companyId: string;
  /** Property-Name → neuer Wert. Empty-String löscht das Feld
   *  (HubSpot-Konvention). Enum-Felder erwarten den `value`, nicht den
   *  `label` — der Agent muss das via Schema mappen. */
  properties: Record<string, string>;
}

export interface UpdateResult {
  ok: boolean;
  companyId: string;
  /** Per-Property Vergleich: was war vorher, was steht jetzt drin. */
  diff: Array<{
    name: string;
    before: string | null;
    after: string | null;
    /** True wenn HubSpot den Wert wirklich übernommen hat. */
    applied: boolean;
  }>;
  /** Wenn ein oder mehrere Properties NICHT übernommen wurden (HubSpot-
   *  No-Op trotz HTTP 200), ist das die Liste der betroffenen Namen.
   *  Lesson aus Notion-Fix v0.1.255: PATCH-Response ist nicht reliable,
   *  nur Fresh-GET ist Ground-Truth. */
  notApplied: string[];
}

export async function updateHubspotCompany(
  crm: CrmManager,
  input: UpdateInput,
): Promise<UpdateResult> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) {
    throw new Error("HubSpot ist nicht verbunden.");
  }

  // 1. Vor-Snapshot — wir wollen den echten Vorher-Zustand für den Diff.
  const propsToTouch = Object.keys(input.properties);
  if (propsToTouch.length === 0) {
    return { ok: true, companyId: input.companyId, diff: [], notApplied: [] };
  }
  const beforeUrl = new URL(
    `${HUBSPOT_API}/crm/v3/objects/companies/${encodeURIComponent(input.companyId)}`,
  );
  beforeUrl.searchParams.set("properties", propsToTouch.join(","));
  const beforeJson = (await hubspotFetch(
    accessToken,
    beforeUrl.toString(),
  )) as { properties?: Record<string, string | null> };
  const before = beforeJson.properties ?? {};

  // 2. PATCH selbst.
  const patchUrl = `${HUBSPOT_API}/crm/v3/objects/companies/${encodeURIComponent(input.companyId)}`;
  await hubspotFetch(accessToken, patchUrl, {
    method: "PATCH",
    body: JSON.stringify({ properties: input.properties }),
  });

  // 3. Fresh-GET — nicht die PATCH-Response trauen (siehe Notion-Lesson).
  const afterUrl = new URL(patchUrl);
  afterUrl.searchParams.set("properties", propsToTouch.join(","));
  const afterJson = (await hubspotFetch(
    accessToken,
    afterUrl.toString(),
  )) as { properties?: Record<string, string | null> };
  const after = afterJson.properties ?? {};

  // 4. Diff bauen + No-Op-Detection.
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
    companyId: input.companyId,
    diff,
    notApplied,
  };
}

function normalize(v: string | null): string {
  if (v == null) return "";
  return String(v).trim();
}

// ---- HTTP-Helper (Kopie von fetch-enrichment.ts mit PATCH-Support) ------

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
        "HubSpot lehnt den Schreibzugriff ab (403). Möglicherweise fehlt der crm.objects.companies.write-Scope — bitte Verbindung trennen und neu autorisieren.",
      );
    }
    throw new Error(
      `HubSpot API-Fehler ${res.status}: ${body.slice(0, 400)}`,
    );
  }
  // PATCH liefert 204 zurück bei einigen Pfaden — JSON-Parse defensiv.
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
