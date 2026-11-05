// Close CRM (docs/PLAN_CLOSE_MCP.md, C1): Verbindung ueber den API-Schluessel des
// Nutzers (HTTP Basic, Schluessel als Benutzername, leeres Passwort). Native
// bleibt nur, was AVA strukturell braucht: Schluessel pruefen, Leads fuer den
// Import lesen, Leads fuer die Verknuepfung suchen. Alles Fachliche (Kontakte,
// Aktivitaeten, Chancen) kommt spaeter ueber die MCP-Werkzeuge von Close (C2/C3).

import type { CompanyForImport, FetchCompaniesResult } from "./fetch-companies";

const BASE = "https://api.close.com/api/v1";
const SEITE = 100;

export function closeAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

async function closeFetch<T>(apiKey: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { authorization: closeAuthHeader(apiKey), accept: "application/json" } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) throw new Error("Close hat den API-Schlüssel abgelehnt (401). Bitte den Schlüssel in Close unter Einstellungen → API-Schlüssel prüfen.");
    if (res.status === 429) throw new Error("Close bremst gerade (429, zu viele Anfragen). Gleich noch einmal versuchen.");
    throw new Error(`Close API-Fehler: ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

interface CloseMe {
  id: string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  organizations?: Array<{ id: string; name?: string | null }>;
}

/** Schluessel pruefen; liefert das Konto-Label und die Organisation. */
export async function validateCloseKey(apiKey: string): Promise<{ account: string; orgId: string | null; email: string | null }> {
  const me = await closeFetch<CloseMe>(apiKey, "/me/");
  const org = me.organizations?.[0] ?? null;
  const email = me.email ?? null;
  const account = [org?.name ?? null, email].filter(Boolean).join(" · ") || me.id;
  return { account, orgId: org?.id ?? null, email };
}

interface CloseLead {
  id: string;
  display_name?: string | null;
  name?: string | null;
  url?: string | null;
  addresses?: Array<{ city?: string | null; country?: string | null }>;
}

interface CloseListe<T> {
  data: T[];
  has_more?: boolean;
}

/** Leads fuer den Import: Name plus Stadt (wie beim HubSpot-Import; ohne Stadt uebersprungen). */
export async function fetchCloseLeads(apiKey: string, maxCompanies: number): Promise<FetchCompaniesResult> {
  const out: CompanyForImport[] = [];
  let total = 0;
  let skipped = 0;
  let skip = 0;
  while (out.length < maxCompanies) {
    const seite = await closeFetch<CloseListe<CloseLead>>(apiKey, `/lead/?_limit=${SEITE}&_skip=${skip}&_fields=id,display_name,name,url,addresses`);
    for (const lead of seite.data) {
      total += 1;
      const name = (lead.display_name ?? lead.name ?? "").trim();
      const city = (lead.addresses?.[0]?.city ?? "").trim();
      if (!name || !city) {
        skipped += 1;
        continue;
      }
      out.push({ name, city, crmExternalId: lead.id, crmDisplayName: name });
      if (out.length >= maxCompanies) break;
    }
    if (!seite.has_more || seite.data.length === 0) break;
    skip += seite.data.length;
  }
  return { companies: out, skipped, total };
}

/** Leads fuer die manuelle Verknuepfung suchen (Close-Suchsyntax, Name reicht). */
export async function searchCloseLeads(apiKey: string, args: { query: string; limit?: number }): Promise<{ items: Array<{ id: string; name: string | null; domain: string | null; city: string | null }> }> {
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));
  const q = encodeURIComponent(args.query.trim());
  const seite = await closeFetch<CloseListe<CloseLead>>(apiKey, `/lead/?query=${q}&_limit=${limit}&_fields=id,display_name,name,url,addresses`);
  return {
    items: seite.data.map((l) => ({
      id: l.id,
      name: (l.display_name ?? l.name ?? "").trim() || null,
      domain: l.url ? l.url.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : null,
      city: l.addresses?.[0]?.city ?? null,
    })),
  };
}

/** Adresse des Leads in der Close-Oberflaeche. */
export function closeLeadUrl(leadId: string): string {
  return `https://app.close.com/lead/${encodeURIComponent(leadId)}/`;
}
