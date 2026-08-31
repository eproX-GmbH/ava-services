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

  // Workstream C — CRM-context fan-out.
  //
  // Wraps GET /v1/companies/:id/crm/details. Returns enriched payloads
  // for every CRM the company is linked to. Cheap when the cache row
  // is < 6h old (DB-only); a stale cache or `refresh=true` triggers a
  // fresh CRM-side fetch in the gateway (HubSpot today; Salesforce /
  // Dynamics surface `notConfigured: true`).
  //
  // Companies with no CRM links return `{ details: [] }` — the agent
  // should treat that as "no CRM context to report" and omit the
  // CRM-Kontext subsection from its summary.
  const crmSummary = defineTool({
    name: "company_crm_summary",
    description:
      "Pulls CRM-side context for an AVA company: open deals, recent contacts, " +
      "last activity. Use this when the user asks for an overview / status of a " +
      "specific company they've imported from a CRM (HubSpot today). Returns " +
      "empty when the company has no CRM link. Cheap to call when cached " +
      "(no CRM API hit for up to 6h); safe to include in the default fan-out " +
      "for open company questions without burning quota.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: { type: "string", description: "AVA master-data companyId." },
        refresh: {
          type: "boolean",
          description:
            "Force a fresh CRM-side fetch even if a cached payload < 6h old exists. Default false.",
        },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(1).required(),
        refresh: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: {
      details?: Array<{
        crmType?: string;
        deals?: unknown[];
        contacts?: unknown[];
        notConfigured?: boolean;
      }>;
    }) => {
      const details = r.details ?? [];
      if (details.length === 0) return "no CRM link";
      const dealCount = details.reduce(
        (n, d) => n + (Array.isArray(d.deals) ? d.deals.length : 0),
        0,
      );
      const contactCount = details.reduce(
        (n, d) => n + (Array.isArray(d.contacts) ? d.contacts.length : 0),
        0,
      );
      return `${dealCount} deals · ${contactCount} contacts across ${details.length} CRM(s)`;
    },
    run: async (args, c) =>
      gateway.request<{
        details: Array<{
          crmType: string;
          fetchedAt: string;
          notConfigured?: boolean;
          contacts?: unknown[];
          deals?: unknown[];
          notes?: unknown[];
          lastActivity?: string | null;
        }>;
      }>(
        `/v1/companies/${encodeURIComponent(args.companyId)}/crm/details`,
        { query: { refresh: args.refresh ? "true" : "false" }, signal: c.signal },
      ),
  });

  // ---- contact_linkedin_lookup (v0.1.476, WL0-Konsequenz 3) ---------------
  //
  // Gezielter LinkedIn-Profil-Nachschlag fuer einen bekannten Kontakt:
  // SERP-Suche (site:linkedin.com/in "<Name>" "<Firma>") ueber den
  // Gateway-Proxy, dann Slug≈Name-Plausibilitaetscheck (WL0 hat gezeigt,
  // dass der Slug bei echten Treffern den Namen traegt). Persist NUR
  // ueber die Nadeloehr-Route (POST …/contacts/linkedin-url) — mit
  // confirmAction (Klasse A: legt Neues an, ueberschreibt nichts).

  const foldName = (v: string): string =>
    v
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .replace(/ae/g, "a")
      .replace(/oe/g, "o")
      .replace(/ue/g, "u")
      .replace(/ss/g, "s")
      .replace(/[^a-z0-9]+/g, "-");

  const profileFromSerpUrl = (raw: string | undefined): string | null => {
    if (!raw) return null;
    try {
      const u = new URL(raw);
      const host = u.hostname.toLowerCase();
      if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
      const m = /^\/in\/([^/]+)/.exec(u.pathname);
      if (!m?.[1]) return null;
      const slug = decodeURIComponent(m[1]).trim().toLowerCase();
      return slug ? `https://www.linkedin.com/in/${encodeURIComponent(slug)}` : null;
    } catch {
      return null;
    }
  };

  const linkedinLookup = defineTool({
    name: "contact_linkedin_lookup",
    summary:
      "LinkedIn-Profil-URL fuer einen bekannten Kontakt per SERP-Suche finden und (nach Plausibilitaetscheck) am Kontakt speichern.",
    category: "kontakte linkedin",
    description:
      "Sucht die LinkedIn-Profil-URL einer Person (site:linkedin.com/in " +
      "Suche via SERP), prueft ob der Profil-Slug plausibel zum Namen " +
      "passt, und speichert den besten Treffer am Kontakt der Firma " +
      "(companyId + fullName noetig; Firmenname verbessert die Suche). " +
      "Bei mehreren plausiblen Treffern werden die Kandidaten " +
      "zurueckgegeben — dann per ask_user_choice klaeren lassen und mit " +
      "chosenUrl erneut aufrufen. Kostet 1 SERP-Abfrage.",
    parameters: {
      type: "object",
      required: ["companyId", "fullName"],
      properties: {
        companyId: { type: "string", description: "AVA-companyId der Firma." },
        fullName: { type: "string", description: "Voller Personenname." },
        companyName: {
          type: "string",
          description: "Firmenname fuer die Suche (empfohlen).",
        },
        chosenUrl: {
          type: "string",
          description:
            "Bereits geklaerte Profil-URL — ueberspringt die Suche und speichert direkt.",
        },
      },
    },
    schema: yup
      .object({
        companyId: yup.string().trim().min(2).required(),
        fullName: yup.string().trim().min(3).max(200).required(),
        companyName: yup.string().trim().max(200).optional(),
        chosenUrl: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r) => {
      const res = r as { saved?: boolean; kandidaten?: unknown[]; error?: string };
      if (res.error) return res.error;
      if (res.saved) return "Profil-URL gespeichert";
      if (res.kandidaten?.length) return `${res.kandidaten.length} Kandidaten — Auswahl noetig`;
      return "Kein plausibles Profil gefunden";
    },
    run: async (args, c) => {
      const persist = async (url: string): Promise<unknown> => {
        const value = await c.ui.confirmAction(
          {
            kind: "additive",
            prompt:
              `LinkedIn-Profil am Kontakt speichern?\n\n` +
              `${args.fullName} (${args.companyName ?? args.companyId})\n${url}`,
            confirmValue: "save",
            options: [
              { value: "save", label: "Speichern", description: "POST ans Gateway" },
              { value: "cancel", label: "Verwerfen" },
            ],
          },
          c.signal,
        );
        if (value !== "save") return { saved: false, abgebrochen: true };
        const res = await gateway.request<{
          saved: boolean;
          personId: string;
          normalizedUrl: string;
        }>(
          `/v1/companies/${encodeURIComponent(args.companyId)}/contacts/linkedin-url`,
          {
            method: "POST",
            body: { fullName: args.fullName, linkedinUrl: url },
            signal: c.signal,
          },
        );
        return { saved: res.saved, url: res.normalizedUrl, personId: res.personId };
      };

      if (args.chosenUrl) {
        const norm = profileFromSerpUrl(args.chosenUrl);
        if (!norm) {
          return { error: "chosenUrl ist keine LinkedIn-Profil-URL (linkedin.com/in/…)." };
        }
        return persist(norm);
      }

      const q = args.companyName
        ? `site:linkedin.com/in "${args.fullName}" "${args.companyName}"`
        : `site:linkedin.com/in "${args.fullName}"`;
      const body = await gateway.request<{
        organic_results?: Array<{ link?: string; title?: string }>;
      }>("/v1/proxy/valueserp", {
        method: "POST",
        body: { q, num: 10 },
        signal: c.signal,
      });

      // Plausibilitaet: alle Namens-Tokens (>=3 Zeichen) muessen im
      // gefalteten Slug vorkommen (WL0-Befund: bei echten Treffern
      // traegt der Slug den Namen; Umlaut-/ae-ue-Falten beidseitig).
      const tokens = foldName(args.fullName)
        .split("-")
        .filter((t) => t.length >= 3);
      const seen = new Set<string>();
      const plausibel: Array<{ url: string; titel: string | null }> = [];
      for (const r of body.organic_results ?? []) {
        const url = profileFromSerpUrl(r.link);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const slugFold = foldName(decodeURIComponent(url.split("/in/")[1] ?? ""));
        if (tokens.length > 0 && tokens.every((t) => slugFold.includes(t))) {
          plausibel.push({ url, titel: r.title ?? null });
        }
      }

      if (plausibel.length === 0) {
        return {
          saved: false,
          hinweis:
            "Kein Profil gefunden, dessen Slug plausibel zum Namen passt — nichts gespeichert (kein Raten).",
        };
      }
      if (plausibel.length === 1) return persist(plausibel[0]!.url);
      return {
        saved: false,
        kandidaten: plausibel,
        hinweis:
          "Mehrere plausible Profile — lass den Nutzer per ask_user_choice waehlen und rufe das Tool mit chosenUrl erneut auf.",
      };
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
    crmSummary,
    linkedinLookup,
  ];
}
