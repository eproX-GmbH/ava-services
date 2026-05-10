import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";
import { getDb as getLinkedInDb, signalsForCompany } from "../../linkedin/db";
import { read as readLinkedInSettings } from "../../linkedin/store";

// Read-only company tools (Phase 8.b).
//
// Each tool wraps one gateway endpoint from /v1/companies. Args are kept
// small — the model picks them, so simpler is better. Previews are short
// strings the renderer can render in a tool-result chip; the full result
// is fed back into the model via the `tool` message in the next loop.

interface Ctx {
  gateway: GatewayClient;
}

function pickFirst<T>(...vals: T[]): T | undefined {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== ("" as unknown)) return v;
  }
  return undefined;
}

export function buildCompanyTools(ctx: Ctx): Tool[] {
  const { gateway } = ctx;

  const search = defineTool({
    name: "company_search",
    description:
      "Fuzzy-search German companies by name. Returns up to `limit` candidate matches (id, name, location). Use this first when the user mentions a company by name.",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "Company name (partial OK)." },
        limit: {
          type: "integer",
          description: "Max matches to return.",
          minimum: 1,
          maximum: 25,
          default: 10,
        },
      },
      required: ["q"],
    },
    schema: yup.object({
      q: yup.string().trim().min(1).required(),
      limit: yup.number().integer().min(1).max(25).default(10),
    }),
    run: async (args, c) => {
      const data = await gateway.request<{
        items?: Array<Record<string, unknown>>;
        total?: number;
      }>("/v1/companies/search", {
        query: { q: args.q, limit: args.limit },
        signal: c.signal,
      });
      return { items: data.items ?? [], total: data.total ?? 0 };
    },
    preview: (r) =>
      r.total === 0
        ? "no matches"
        : `${r.total} match${r.total === 1 ? "" : "es"}`,
  });

  const get = defineTool({
    name: "company_get",
    description:
      "Fetch the canonical German-company record (legal name, register, address, industry codes) by its global companyId.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const name = pickFirst(
        (r as { name?: string }).name,
        (r as { legalName?: string }).legalName,
      );
      return name ? `company: ${name}` : "company record";
    },
  });

  const profile = defineTool({
    name: "company_profile",
    description:
      "Get the LLM-derived profile for a company (corporate purpose, summary, headcount, market positioning).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/profile`,
        { signal: c.signal },
      ),
    preview: () => "profile fetched",
  });

  const keywords = defineTool({
    name: "company_keywords",
    description:
      "List extracted keywords/tags for a company (industries, products, themes).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/keywords`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) => `${r.items.length} keywords`,
  });

  const website = defineTool({
    name: "company_website",
    description:
      "Get the crawled website summary for a company (homepage URL, scraped sections, last crawl).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/website`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const url = pickFirst(
        (r as { url?: string }).url,
        (r as { homepageUrl?: string }).homepageUrl,
      );
      return url ? `website: ${url}` : "website fetched";
    },
  });

  const publications = defineTool({
    name: "company_publications",
    description:
      "List financial publications (annual reports etc.) for a company. Each item carries year, KPIs, and stateOfAffairs narrative.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) => {
      const data = await gateway.request<{ items?: unknown[] }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/publications`,
        { signal: c.signal },
      );
      return { items: data.items ?? [] };
    },
    preview: (r) => `${r.items.length} publications`,
  });

  const contacts = defineTool({
    name: "company_contacts",
    description:
      "Get the contact aggregate for a company (board members, generic emails, phone numbers).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/contacts`,
        { signal: c.signal },
      ),
    preview: () => "contacts fetched",
  });

  const structuredContent = defineTool({
    name: "company_structured_content",
    description:
      "Get extracted structured content (facts, observations, signals) the cascade has stored for a company.",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<Record<string, unknown>>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/structured-content`,
        { signal: c.signal },
      ),
    preview: () => "structured content fetched",
  });

  // v0.1.65 — per-stage LLM provenance for the agent's reliability
  // hints. Returns one row per stage with `llmTier` (1..4 = C..S; null
  // for non-LLM scrape stages) and `llmModel` (e.g. "gpt-4o",
  // "qwen2.5:7b"; null on non-LLM or pre-tracking writes). The agent
  // is expected to soft-warn when answering with data sourced from
  // tier-B/C cells — see system-prompt update.
  const dataQuality = defineTool({
    name: "company_data_quality",
    description:
      "Get per-stage LLM provenance for a company: which model produced each cell, what tier (S/A/B/C reliability), and when. Use this to qualify your answer when the user asks about company facts — soft-warn on tier-B/C sources, especially Tier C (small local models can hallucinate).",
    parameters: {
      type: "object",
      properties: { companyId: { type: "string" } },
      required: ["companyId"],
    },
    schema: yup.object({ companyId: yup.string().trim().min(1).required() }),
    run: async (args, c) =>
      gateway.request<{
        companyId: string;
        stages: Record<
          string,
          {
            updatedAt: string | null;
            llmTier: number | null;
            llmModel: string | null;
          }
        >;
      }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/state`,
        { signal: c.signal },
      ),
    preview: (r) => {
      const llmStages = Object.values(r.stages).filter(
        (s) => s.llmTier != null,
      );
      if (llmStages.length === 0) return "no LLM data yet";
      const worst = Math.min(
        ...llmStages.map((s) => s.llmTier as number),
      );
      const letter = ({ 4: "S", 3: "A", 2: "B", 1: "C" } as const)[
        worst as 1 | 2 | 3 | 4
      ];
      return `worst tier across ${llmStages.length} stages: ${letter}`;
    },
  });

  // L6 — agent-facing window into the LinkedIn-Beobachter signals for a
  // company. Stays main-side (no gateway round-trip) because the data
  // lives in the local linkedin DB. Returns nothing when the master
  // switch is off so the tool degrades gracefully.
  const linkedInSignals = defineTool({
    name: "company_linkedin_signals",
    description:
      "Liefert die letzten LinkedIn-Signale für eine Firma. Zeigt Beitrag, Signal-Art, Stärke, gematchte Personen und kurze Zusammenfassung. Nutze das Tool, wenn der Nutzer fragt 'was tut sich bei <Firma> auf LinkedIn?' oder eine Status-Übersicht möchte.",
    parameters: {
      type: "object",
      properties: {
        companyId: { type: "string" },
        limit: {
          type: "integer",
          description: "Max signals to return.",
          minimum: 1,
          maximum: 50,
          default: 10,
        },
      },
      required: ["companyId"],
    },
    schema: yup.object({
      companyId: yup.string().trim().min(1).required(),
      limit: yup.number().integer().min(1).max(50).default(10),
    }),
    run: async (args) => {
      const settings = readLinkedInSettings();
      if (!settings.enabled) {
        return {
          enabled: false,
          items: [] as Array<Record<string, unknown>>,
          note: "LinkedIn-Beobachter ist deaktiviert.",
        };
      }
      const db = await getLinkedInDb();
      const rows = await signalsForCompany(db, args.companyId, args.limit);
      return {
        enabled: true,
        items: rows.map((r) => ({
          postUrn: r.postUrn,
          postedAt: r.postedAt,
          authorName: r.authorDisplayName,
          signalKind: r.signalKind,
          signalStrength: r.signalStrength,
          summary: r.summary,
          permalink: r.permalink,
        })),
      };
    },
    preview: (r) => {
      if (!r.enabled) return "linkedin disabled";
      return `${r.items.length} linkedin signal${r.items.length === 1 ? "" : "s"}`;
    },
  });

  return [
    search,
    get,
    profile,
    keywords,
    website,
    publications,
    contacts,
    structuredContent,
    dataQuality,
    linkedInSignals,
  ];
}
