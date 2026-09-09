// W1b — Firmen-Kontext fuer Workflow-Laeufe (Grundgedanke des Operators,
// 2026-09-09): Ein Workflow-Lauf bezieht sich IMMER auf EINE Firma. Der
// vollstaendige Kontext dieser Firma (Stammdaten, Profil, Schlagworte,
// Kontakte, Jahresabschluesse mit Kennzahlen, CRM-Stand; bei Radar-
// Kandidaten das Mini-Profil) liegt dem Lauf als Klartext vor, damit
// Nodes dynamisch mit den richtigen Werten gefuellt werden koennen.
//
// Die Daten kommen ueber die vorhandenen Lese-Tools der Registry — kein
// zweiter Datenpfad, und Anbieter-/Feature-Sperren gelten automatisch.

import type { ToolRegistry } from "../agent/tool-registry";
import type { ToolContext } from "../agent/types";

export interface CompanyScope {
  companyId?: string;
  discoveryId?: string;
  companyName?: string;
}

export interface CompanyContext {
  scope: CompanyScope;
  /** Strukturierte Sicht (fuer $company in Expressions). */
  json: Record<string, unknown>;
  /** Klartext fuer KI-Nodes und die semantische Platzhalter-Befuellung. */
  text: string;
  /** Welche Quellen geliefert haben. */
  quellen: string[];
}

const SECTION_MAX_CHARS = 14_000;
const TOTAL_MAX_CHARS = 70_000;

const COMPANY_SOURCES: Array<{ tool: string; titel: string; key: string }> = [
  { tool: "company_get", titel: "Stammdaten", key: "stammdaten" },
  { tool: "company_profile", titel: "Firmenprofil", key: "profil" },
  { tool: "company_keywords", titel: "Schlagworte", key: "schlagworte" },
  { tool: "company_contacts", titel: "Kontakte und Ansprechpartner", key: "kontakte" },
  { tool: "company_publications", titel: "Jahresabschluesse und Kennzahlen (Finanzen)", key: "finanzen" },
  // v0.1.599 — Handelsregister-Auszug: Rechtsform, Stammkapital, Gruendungsjahr,
  // Geschaeftsfuehrung, letzte Registeraenderung (fuer Platzhalter wie
  // $geschaeftsfuehrer oder $stammkapital). 404 = noch nicht extrahiert.
  { tool: "company_structured_content", titel: "Handelsregister (Rechtsform, Kapital, Geschaeftsfuehrung)", key: "register" },
  { tool: "company_crm_summary", titel: "CRM-Stand", key: "crm" },
];

function kuerzen(v: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(v, null, 1);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}\n… [gekuerzt]` : s;
}

export async function buildCompanyContext(
  registry: ToolRegistry,
  scope: CompanyScope,
  ctx: ToolContext,
): Promise<CompanyContext> {
  const json: Record<string, unknown> = { ...scope };
  const parts: string[] = [];
  const quellen: string[] = [];

  if (scope.companyId) {
    for (const src of COMPANY_SOURCES) {
      const tool = registry.get(src.tool);
      if (!tool) continue;
      try {
        const result = await tool.run(tool.parseArgs({ companyId: scope.companyId }), ctx);
        if (result == null) continue;
        json[src.key] = result;
        quellen.push(src.tool);
        parts.push(`## ${src.titel}\n${kuerzen(result, SECTION_MAX_CHARS)}`);
        if (!json.name) {
          const r = result as Record<string, unknown>;
          const name = (r.name ?? r.legalName ?? (r.company as Record<string, unknown> | undefined)?.name) as string | undefined;
          if (typeof name === "string") json.name = name;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/\b404\b|not_found/i.test(msg)) {
          parts.push(`## ${src.titel}\n[keine Daten vorhanden]`);
          continue;
        }
        parts.push(`## ${src.titel}\n[nicht verfuegbar: ${msg.slice(0, 160)}]`);
      }
    }
  } else if (scope.discoveryId) {
    const tool = registry.get("discovery_candidates");
    if (tool) {
      try {
        const result = (await tool.run(tool.parseArgs({ limit: 200 }), ctx)) as { rows?: Array<Record<string, unknown>>; candidates?: Array<Record<string, unknown>> };
        const rows = result.rows ?? result.candidates ?? [];
        const hit = rows.find((r) => r.discoveryId === scope.discoveryId);
        if (hit) {
          json.radar = hit;
          json.name = (hit.name as string | undefined) ?? json.name;
          quellen.push("discovery_candidates");
          parts.push(`## Radar-Kandidat (Mini-Profil, ICP-Match)\n${kuerzen(hit, SECTION_MAX_CHARS)}`);
        }
      } catch (err) {
        parts.push(`## Radar-Kandidat\n[nicht verfuegbar: ${err instanceof Error ? err.message.slice(0, 160) : String(err)}]`);
      }
    }
  }
  if (scope.companyName && !json.name) json.name = scope.companyName;

  let text = `# Firmen-Kontext: ${String(json.name ?? scope.companyId ?? scope.discoveryId ?? "unbekannt")}\n\n${parts.join("\n\n")}`;
  if (text.length > TOTAL_MAX_CHARS) text = `${text.slice(0, TOTAL_MAX_CHARS)}\n… [gekuerzt]`;
  if (parts.length === 0) text += "\n[Kein Kontext verfuegbar — Firma nicht im Bestand?]";
  return { scope: { ...scope, ...(json.name ? { companyName: String(json.name) } : {}) }, json, text, quellen };
}
