// Workstream C4 — desktop-side HubSpot live enrichment fetcher.
//
// The gateway can't hold per-user HubSpot tokens (D11 keeps OAuth bearer
// material in the OS keychain on the desktop). To keep the read path
// fast for CompanyDetail / agent fan-outs, the renderer triggers this
// helper on a CRM-link details cache miss; we use the stored token to
// pull a compact enrichment payload from HubSpot and POST it back to the
// gateway's cache endpoint (TTL 6h).
//
// Shape is deliberately narrow — five contacts + five deals are enough
// for the renderer's compact summary, and HubSpot's batch endpoints
// cap us at a single round-trip each.
//
// On any HubSpot failure we surface `{ ok: false, error }` and DO NOT
// write to the cache — a stale-but-good cache row beats an empty one.

import type { CrmManager } from "./index";
import type { CrmProvider } from "./types";

export interface CrmEnrichmentPayload {
  crmType: "hubspot";
  crmExternalId: string;
  fetchedAt: string;
  company: {
    name: string | null;
    domain: string | null;
    industry: string | null;
    lifecycleStage: string | null;
    phone: string | null;
    city: string | null;
    country: string | null;
    employees: number | null;
    annualRevenue: number | null;
    createdAt: string | null;
    lastModified: string | null;
  };
  contacts: Array<{
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    jobTitle: string | null;
    phone: string | null;
    leadStatus: string | null;
    lastModified: string | null;
  }>;
  deals: Array<{
    id: string;
    name: string | null;
    amount: number | null;
    stage: string | null;
    pipeline: string | null;
    closeDate: string | null;
    createdAt: string | null;
    lastModified: string | null;
  }>;
  lastActivity: string | null;
  rawCounts: { contacts: number; deals: number };
}

export interface EnrichmentRunOptions {
  /** AVA master-data company id — used for the POST-back to the gateway. */
  companyId: string;
  /** CRM-side external id (HubSpot company object id). */
  crmExternalId: string;
  /** HubSpot is the only path implemented today. */
  crmType?: CrmProvider;
}

export type EnrichmentRunResult =
  | { ok: true; fetchedAt: string }
  | { ok: false; error: string };

const HUBSPOT_COMPANY_PROPERTIES = [
  "name",
  "domain",
  "industry",
  "lifecyclestage",
  "hs_lastmodifieddate",
  "createdate",
  "phone",
  "city",
  "country",
  "numberofemployees",
  "annualrevenue",
];

const HUBSPOT_CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "jobtitle",
  "phone",
  "hs_lead_status",
  "lastmodifieddate",
];

const HUBSPOT_DEAL_PROPERTIES = [
  "dealname",
  "amount",
  "dealstage",
  "pipeline",
  "closedate",
  "hs_lastmodifieddate",
  "createdate",
];

const ASSOC_CAP = 10;

interface HubspotCompanyResponse {
  id: string;
  properties: Record<string, string | null | undefined>;
  associations?: {
    contacts?: { results?: Array<{ id: string; type?: string }> };
    deals?: { results?: Array<{ id: string; type?: string }> };
  };
}

interface HubspotBatchResponse {
  results?: Array<{
    id: string;
    properties: Record<string, string | null | undefined>;
  }>;
}

function toIsoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

function toNumOrNull(value: string | null | undefined): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  return t.length > 0 ? t : null;
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
    throw new Error(
      `HubSpot API-Fehler: ${res.status} ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

async function fetchHubspotEnrichment(
  accessToken: string,
  crmExternalId: string,
): Promise<CrmEnrichmentPayload> {
  // 1. Company + associations.
  const companyUrl = new URL(
    `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(crmExternalId)}`,
  );
  companyUrl.searchParams.set("properties", HUBSPOT_COMPANY_PROPERTIES.join(","));
  companyUrl.searchParams.set("associations", "contacts,deals");
  const companyJson = (await hubspotFetch(accessToken, companyUrl.toString())) as
    HubspotCompanyResponse;

  const props = companyJson.properties ?? {};
  const contactAssocs = companyJson.associations?.contacts?.results ?? [];
  const dealAssocs = companyJson.associations?.deals?.results ?? [];
  const contactIds = contactAssocs.slice(0, ASSOC_CAP).map((r) => r.id);
  const dealIds = dealAssocs.slice(0, ASSOC_CAP).map((r) => r.id);

  // 2. Batch contacts.
  let contacts: CrmEnrichmentPayload["contacts"] = [];
  if (contactIds.length > 0) {
    const batch = (await hubspotFetch(
      accessToken,
      "https://api.hubapi.com/crm/v3/objects/contacts/batch/read",
      {
        method: "POST",
        body: JSON.stringify({
          properties: HUBSPOT_CONTACT_PROPERTIES,
          inputs: contactIds.map((id) => ({ id })),
        }),
      },
    )) as HubspotBatchResponse;
    contacts = (batch.results ?? []).map((row) => ({
      id: row.id,
      firstName: trimOrNull(row.properties.firstname),
      lastName: trimOrNull(row.properties.lastname),
      email: trimOrNull(row.properties.email),
      jobTitle: trimOrNull(row.properties.jobtitle),
      phone: trimOrNull(row.properties.phone),
      leadStatus: trimOrNull(row.properties.hs_lead_status),
      lastModified: toIsoOrNull(row.properties.lastmodifieddate),
    }));
  }

  // 3. Batch deals.
  let deals: CrmEnrichmentPayload["deals"] = [];
  if (dealIds.length > 0) {
    const batch = (await hubspotFetch(
      accessToken,
      "https://api.hubapi.com/crm/v3/objects/deals/batch/read",
      {
        method: "POST",
        body: JSON.stringify({
          properties: HUBSPOT_DEAL_PROPERTIES,
          inputs: dealIds.map((id) => ({ id })),
        }),
      },
    )) as HubspotBatchResponse;
    deals = (batch.results ?? []).map((row) => ({
      id: row.id,
      name: trimOrNull(row.properties.dealname),
      amount: toNumOrNull(row.properties.amount),
      stage: trimOrNull(row.properties.dealstage),
      pipeline: trimOrNull(row.properties.pipeline),
      closeDate: toIsoOrNull(row.properties.closedate),
      createdAt: toIsoOrNull(row.properties.createdate),
      lastModified: toIsoOrNull(row.properties.hs_lastmodifieddate),
    }));
  }

  // 4. Last activity = max of company.lastModified, contact.lastModified, deal.lastModified.
  const candidates: number[] = [];
  const companyModified = toIsoOrNull(props.hs_lastmodifieddate);
  if (companyModified) candidates.push(new Date(companyModified).getTime());
  for (const c of contacts) {
    if (c.lastModified) candidates.push(new Date(c.lastModified).getTime());
  }
  for (const d of deals) {
    if (d.lastModified) candidates.push(new Date(d.lastModified).getTime());
  }
  const lastActivity = candidates.length
    ? new Date(Math.max(...candidates)).toISOString()
    : null;

  return {
    crmType: "hubspot",
    crmExternalId,
    fetchedAt: new Date().toISOString(),
    company: {
      name: trimOrNull(props.name),
      domain: trimOrNull(props.domain),
      industry: trimOrNull(props.industry),
      lifecycleStage: trimOrNull(props.lifecyclestage),
      phone: trimOrNull(props.phone),
      city: trimOrNull(props.city),
      country: trimOrNull(props.country),
      employees: toNumOrNull(props.numberofemployees),
      annualRevenue: toNumOrNull(props.annualrevenue),
      createdAt: toIsoOrNull(props.createdate),
      lastModified: companyModified,
    },
    contacts,
    deals,
    lastActivity,
    rawCounts: { contacts: contactAssocs.length, deals: dealAssocs.length },
  };
}

/**
 * Run a fresh HubSpot enrichment fetch and push the payload to the
 * gateway cache. Caller supplies the gateway bearer; on success the
 * gateway's /crm/details response will serve the new payload until TTL.
 */
export async function runCrmEnrichment(
  crm: CrmManager,
  args: EnrichmentRunOptions,
  ctx: {
    gatewayUrl: string;
    getBearer: () => Promise<string | null>;
  },
): Promise<EnrichmentRunResult> {
  const provider: CrmProvider = args.crmType ?? "hubspot";
  if (provider !== "hubspot") {
    return {
      ok: false,
      error: `CRM ${provider} ist noch nicht für Live-Anreicherung implementiert.`,
    };
  }

  const accessToken = await crm.getAccessToken(provider);
  if (!accessToken) {
    return {
      ok: false,
      error: "HubSpot ist nicht verbunden. Bitte zuerst in den Einstellungen verbinden.",
    };
  }

  let payload: CrmEnrichmentPayload;
  try {
    payload = await fetchHubspotEnrichment(accessToken, args.crmExternalId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  const bearer = await ctx.getBearer();
  if (!bearer) {
    return { ok: false, error: "Nicht angemeldet — Cache-Push nicht möglich." };
  }

  const cacheUrl = `${ctx.gatewayUrl.replace(/\/+$/, "")}/v1/companies/${encodeURIComponent(args.companyId)}/crm/cache`;
  const res = await fetch(cacheUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ crmType: "HUBSPOT", payload }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      error: `Gateway-Cache-Push fehlgeschlagen: ${res.status} ${body.slice(0, 200)}`,
    };
  }

  return { ok: true, fetchedAt: payload.fetchedAt };
}

/**
 * HubSpot company search — used by the manual-link picker dialog.
 * Returns up to 25 candidates matching the user's query string.
 */
export async function searchHubspotCompanies(
  crm: CrmManager,
  args: { query: string; limit?: number },
): Promise<{ items: Array<{ id: string; name: string | null; domain: string | null; city: string | null }> }> {
  const accessToken = await crm.getAccessToken("hubspot");
  if (!accessToken) {
    throw new Error(
      "HubSpot ist nicht verbunden. Bitte zuerst in den Einstellungen verbinden.",
    );
  }
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const json = (await hubspotFetch(
    accessToken,
    "https://api.hubapi.com/crm/v3/objects/companies/search",
    {
      method: "POST",
      body: JSON.stringify({
        query: args.query,
        properties: ["name", "domain", "city"],
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
      name: trimOrNull(r.properties.name),
      domain: trimOrNull(r.properties.domain),
      city: trimOrNull(r.properties.city),
    })),
  };
}
