import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { GatewayClient } from "../gateway-client";
import type { Tool } from "../types";

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

  return [
    search,
    get,
    profile,
    keywords,
    website,
    publications,
    contacts,
    structuredContent,
  ];
}
