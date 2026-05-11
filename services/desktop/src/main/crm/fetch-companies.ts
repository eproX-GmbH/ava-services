// v0.1.57 — CRM → AVA company-list fetcher.
//
// Pulls companies from the user's connected CRM and shapes them into the
// minimal `[{name, city}]` rows the gateway's /v1/imports/from-list ingest
// expects. Each provider has its own paginator (HubSpot today; Salesforce +
// Dynamics return `not_implemented` until those OAuth apps are registered
// and we can test the actual API responses).
//
// Tokens come from CrmManager.getAccessToken — auto-refreshed if near expiry.
// The fetcher never persists tokens itself; it borrows for the duration of
// one fetch.
//
// Caller is responsible for surfacing the result to the agent. See
// agent/tools/imports.ts → import_companies_from_crm.

import type { CrmManager } from "./index";
import type { CrmProvider } from "./types";

export interface CompanyForImport {
  name: string;
  city: string;
  /** Workstream C — CRM-side identifier we'll persist as a
   *  CompanyCrmLink once master-data resolves the AVA companyId.
   *  HubSpot: `hs_object_id` (the company object's primary key).
   *  null for providers where we don't yet have an id available. */
  crmExternalId?: string;
  /** Display name captured at fetch-time for the eventual UI badge. */
  crmDisplayName?: string;
}

export interface FetchCompaniesResult {
  companies: CompanyForImport[];
  /** Rows the CRM returned but lacked enough data to import (no name AND/OR
   *  no city). Surfaced so the agent can warn the user. */
  skipped: number;
  /** Total rows the CRM returned (companies.length + skipped). */
  total: number;
}

export async function fetchCompaniesFromCrm(
  crm: CrmManager,
  provider: CrmProvider,
  opts: { maxCompanies?: number } = {},
): Promise<FetchCompaniesResult> {
  const accessToken = await crm.getAccessToken(provider);
  if (!accessToken) {
    throw new Error(
      `CRM ${provider} ist nicht verbunden. Bitte erst über Einstellungen oder im Chat verbinden.`,
    );
  }
  const max = opts.maxCompanies ?? 5000;

  switch (provider) {
    case "hubspot":
      return fetchHubSpot(accessToken, max);
    case "salesforce":
      throw new Error(
        "Salesforce-Import ist noch nicht implementiert. Bitte zunächst HubSpot verwenden.",
      );
    case "dynamics":
      throw new Error(
        "Microsoft-Dynamics-Import ist noch nicht implementiert. Bitte zunächst HubSpot verwenden.",
      );
  }
}

// =============================================================================
// HubSpot pager.
// =============================================================================
// API: GET https://api.hubapi.com/crm/v3/objects/companies
//   query: limit (max 100), properties (csv), after (opaque cursor)
//   auth:  Bearer <accessToken>
// Response: { results: [{id, properties: {name, city, ...}}], paging?: { next: { after } } }
//
// Properties pulled: name, city, country.
//   - We don't pull HubSpot's customer-defined "register number / court"
//     fields here — they vary across portals and the master-data pipeline
//     resolves them from name+city anyway via Unternehmensregister lookup.
// =============================================================================

const HUBSPOT_PAGE_SIZE = 100;
const HUBSPOT_PROPERTIES = ["name", "city", "country"];

interface HubSpotCompanyResponse {
  results: Array<{
    id: string;
    properties: {
      name?: string | null;
      city?: string | null;
      country?: string | null;
    };
  }>;
  paging?: {
    next?: {
      after?: string;
    };
  };
}

async function fetchHubSpot(
  accessToken: string,
  maxCompanies: number,
): Promise<FetchCompaniesResult> {
  const out: CompanyForImport[] = [];
  let total = 0;
  let skipped = 0;
  let cursor: string | undefined;

  while (out.length < maxCompanies) {
    const url = new URL("https://api.hubapi.com/crm/v3/objects/companies");
    url.searchParams.set("limit", String(HUBSPOT_PAGE_SIZE));
    url.searchParams.set("properties", HUBSPOT_PROPERTIES.join(","));
    if (cursor) url.searchParams.set("after", cursor);

    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 401 → access token revoked or expired beyond refresh. Tell the
      // caller in a way the agent can act on.
      if (res.status === 401) {
        throw new Error(
          "HubSpot hat die Anmeldung abgelehnt (401). Bitte Verbindung über Einstellungen oder im Chat erneut herstellen.",
        );
      }
      throw new Error(
        `HubSpot API-Fehler: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    const payload = (await res.json()) as HubSpotCompanyResponse;

    for (const row of payload.results) {
      total += 1;
      const name = row.properties.name?.trim();
      const city = row.properties.city?.trim();
      if (!name || !city) {
        skipped += 1;
        continue;
      }
      out.push({
        name,
        city,
        // hs_object_id IS the company id in HubSpot's CRM v3 API
        // (the top-level `id` field on each result).
        crmExternalId: row.id,
        crmDisplayName: name,
      });
      if (out.length >= maxCompanies) break;
    }

    cursor = payload.paging?.next?.after;
    if (!cursor) break;
  }

  return { companies: out, skipped, total };
}
