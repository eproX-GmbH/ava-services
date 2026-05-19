import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { ToolRegistry } from "../tool-registry";

// v0.1.240 — Lazy-Tool-Loading (Tool-Search + Tool-Load).
//
// Vorher haben wir bei jedem Turn ~40 Tool-Schemas mit fetten
// Beschreibungen mitgeschickt. Das hat bei OpenAI/Anthropic pro
// komplexer Anfrage 15-20 Cent gefressen, obwohl die meisten Tools
// gar nicht relevant waren. Jetzt sieht das Modell pro Turn nur
// einen winzigen Kern (tool_search/tool_load/skill_*/ask_user_*) und
// muss alles andere aktiv anfordern.
//
// Workflow für den Agent:
//   1. Anfrage ankommt, passende Tools fehlen im Kontext
//   2. `tool_search("notion CRM update")` → bekommt Top-Treffer mit
//      einer kurzen Summary pro Tool
//   3. `tool_load(["notion_list_databases", "notion_update_page", ...])`
//      → Tools landen in conversation.loadedToolNames, sind ab dem
//      NÄCHSTEN Turn im LLM-Kontext verfügbar
//   4. Normaler Tool-Call wie gewohnt
//
// Wichtig: Der ReAct-Loop in orchestrator.ts baut die `tools[]`-Liste
// VOR JEDEM Provider-streamChat-Call neu (siehe runLoop, for-Schleife
// über STEP_BUDGET). Damit greifen tool_load-Mutationen am
// loadedToolNames-Set schon im nächsten Step der gleichen User-Anfrage
// — der Agent kann also tool_search, tool_load und die eigentliche
// Aktion in einem einzigen User-Turn machen.

export interface ConversationToolLoadState {
  /** Read-only view of currently loaded tool names. Used by tool_search
   *  to mark already-loaded results so the LLM doesn't request them
   *  again. */
  getLoaded(): ReadonlySet<string>;
  /** Add names to the conversation's loaded-set. Unknown names get
   *  reported back so the LLM can correct typos via a follow-up
   *  tool_search. Returns three buckets so the LLM can see exactly
   *  what happened. */
  load(names: readonly string[]): {
    loaded: string[];
    alreadyLoaded: string[];
    unknown: string[];
  };
}

export interface MetaToolDeps {
  registry: ToolRegistry;
  /** Names that ALWAYS travel in the LLM context — `tool_search` skips
   *  them in its result so the agent doesn't get told "load
   *  ask_user_text" (which is already there). */
  coreToolNames: ReadonlySet<string>;
  /** Per-call accessor: the orchestrator updates a cell pointing at
   *  the currently-processed conversation right before invoking
   *  meta-tool.run(). This works because the orchestrator handles one
   *  input at a time per instance. */
  currentLoadState: () => ConversationToolLoadState;
}

/**
 * Extract a one-line summary from a tool. If the tool has an explicit
 * `summary`, use it. Otherwise take the first sentence of the
 * description, truncated to 200 chars — good-enough fallback so the
 * search returns reasonable results before every tool is hand-curated.
 */
function summaryOf(tool: Tool): string {
  if (tool.summary) return tool.summary;
  // First sentence: split on first period followed by space/newline/end.
  const desc = tool.description.trim();
  const match = desc.match(/^.+?[.!?](?:\s|$)/);
  const sentence = match ? match[0].trim() : desc;
  return sentence.length > 200 ? sentence.slice(0, 197) + "…" : sentence;
}

/**
 * Score a tool against a query. Higher = more relevant.
 *
 * Heuristic: name-match dominates (a tool called `notion_update_page`
 * with query "notion update" should top the list). Summary matches
 * are next, description matches lowest. Multi-word queries are OR'd
 * with per-word scoring so a long query like "update notion CRM row"
 * still ranks the notion-update-tool highest.
 */
function scoreTool(tool: Tool, queryWords: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const summary = summaryOf(tool).toLowerCase();
  const desc = tool.description.toLowerCase();
  const category = (tool.category ?? "").toLowerCase();
  let score = 0;
  for (const word of queryWords) {
    if (!word) continue;
    if (name.includes(word)) score += 10;
    if (category && category.includes(word)) score += 8;
    if (summary.includes(word)) score += 5;
    if (desc.includes(word)) score += 1;
  }
  return score;
}

export function buildMetaTools(deps: MetaToolDeps): Tool[] {
  const toolSearch = defineTool({
    name: "tool_search",
    summary:
      "Find tools by keyword. ALWAYS call this when you need a capability that isn't already in your visible tool list.",
    category: "meta",
    description:
      "Search the full tool catalogue by keyword. Returns the top matches with a short summary per tool. Use this when you need a capability (e.g. \"Notion update\", \"LinkedIn scrape\", \"voice transcribe\") that isn't in your current tool list. After picking results, call `tool_load` with their names to bring them into your context — they'll be available starting NEXT turn. Already-loaded tools are excluded from the result so you don't waste a load on something already present. Query is case-insensitive, multi-word, scored highest on name then summary then full description.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search keywords. Multi-word OK (e.g. 'notion crm update', 'linkedin scrape', 'memory recall').",
        },
        limit: {
          type: "integer",
          description:
            "Max results to return (default 8, max 20). Higher = more options + bigger response.",
        },
      },
      required: ["query"],
    },
    schema: yup.object({
      query: yup
        .string()
        .trim()
        .min(1, "query darf nicht leer sein")
        .required("query fehlt — was suchst du? (z. B. 'notion update')"),
      limit: yup.number().integer().min(1).max(20).optional(),
    }),
    run: async (args) => {
      const queryWords = args.query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      const loaded = deps.currentLoadState().getLoaded();
      const candidates = deps.registry.list().filter((t) => {
        if (deps.coreToolNames.has(t.name)) return false;
        if (loaded.has(t.name)) return false;
        return true;
      });
      const scored = candidates
        .map((t) => ({ tool: t, score: scoreTool(t, queryWords) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, args.limit ?? 8);
      const hits = scored.map(({ tool }) => ({
        name: tool.name,
        category: tool.category ?? null,
        summary: summaryOf(tool),
      }));
      // If nothing matched, return a helpful hint instead of an empty
      // list — saves the model from a confused "what now" cycle.
      if (hits.length === 0) {
        return {
          hits: [],
          hint:
            "Keine Treffer. Versuch's mit anderen Stichwörtern (z. B. einzelne Worte statt Phrasen). Oder die gesuchte Funktion existiert noch nicht als Tool — dann sag dem Nutzer das offen.",
        };
      }
      // v0.1.244 — Bundle-Hint. Wenn die Treffer aus einem bekannten
      // Workflow stammen, hängen wir die volle Bundle-Liste dran. So
      // lädt der Agent in EINEM tool_load die ganze Gruppe statt
      // unter-spezifisch nur die ersten 2 Treffer. Lazy-Loading bringt
      // sonst eine Regression: für „Firma X" lädt der Agent nur
      // company_search + company_crm_summary und verpasst die
      // restlichen 4 Recherche-Tools.
      const bundle = detectBundle(hits, args.query);
      if (bundle) {
        return {
          hits,
          suggestedBundle: bundle,
          bundleHint:
            `TIPP: Statt nur die Top-Treffer zu laden, ruf direkt ` +
            `tool_load([${bundle.tools.map((t) => `"${t}"`).join(", ")}]) ` +
            `für den vollen ${bundle.label}-Bundle. Das spart Roundtrips ` +
            `und ermöglicht den parallelen Fan-Out.`,
        };
      }
      return { hits };
    },
    preview: (r) => {
      const hits = (r.hits as Array<unknown>) ?? [];
      return `${hits.length} Tool-Treffer`;
    },
  });

  const toolLoad = defineTool({
    name: "tool_load",
    summary:
      "Load discovered tools into your context. Call after `tool_search` returns relevant matches.",
    category: "meta",
    description:
      "Bring one or more tools into your live tool-list. The loaded tools are usable starting with the NEXT step of the current answer cycle — you can call `tool_load` and then immediately invoke the freshly-loaded tool in the same user turn. Tools stay loaded for the rest of this conversation, so you only need to load them once. Unknown names are reported back — don't retry blindly, do another `tool_search` with corrected keywords. Already-loaded tools and core tools are silently ignored (no-op).",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 20,
          description:
            "Tool names to load (as returned by `tool_search`). Pass several at once when you need a whole group (e.g. all notion_* tools for a CRM workflow).",
        },
      },
      required: ["names"],
    },
    schema: yup.object({
      names: yup
        .array()
        .of(yup.string().trim().required())
        .min(1, "names darf nicht leer sein")
        .max(20, "höchstens 20 Tools auf einmal")
        .required("names fehlt"),
    }),
    run: async (args) => {
      const result = deps.currentLoadState().load(args.names);
      return result;
    },
    preview: (r) => {
      const loaded = (r.loaded as string[] | undefined) ?? [];
      const unknown = (r.unknown as string[] | undefined) ?? [];
      const parts: string[] = [];
      if (loaded.length > 0) parts.push(`${loaded.length} geladen`);
      if (unknown.length > 0) parts.push(`${unknown.length} unbekannt`);
      return parts.join(", ") || "Tool-Load: nichts neues";
    },
  });

  return [toolSearch, toolLoad];
}

/**
 * Names of the always-present tools. Kept here so `selectToolsForTurn`,
 * `tool_search` (skip-list) and the system-prompt builder all agree on
 * the canonical core. Touch this list with care — every addition
 * means more tokens per turn for EVERY conversation.
 */
export const ALWAYS_ON_CORE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
  // Meta — the discovery surface itself.
  "tool_search",
  "tool_load",
  // Skills — the agent constantly checks if a stored skill matches the
  // user's intent; these are cheap (read-only) and frequently used.
  "skill_search",
  "skill_get",
  // UI primitives — needed by half the workflows; trivially small.
  "ask_user_choice",
  "ask_user_text",
]);

// v0.1.244 — Tool-Bundles. Wenn `tool_search` Treffer aus einer
// bekannten Workflow-Gruppe liefert, hängt es einen Bundle-Hint an
// das Result, sodass der Agent in EINEM tool_load die ganze Gruppe
// holt statt unter-spezifisch nur die ersten 2 Treffer. Verhindert
// die Lazy-Loading-Regression beim Fan-Out für Firmen-Recherche.
//
// Match-Logik: wenn min. 2 der Top-Treffer zu einem Bundle gehören,
// gilt der Bundle als detected. Plus Query-Hint-Matches.
interface ToolBundle {
  label: string;
  tools: readonly string[];
  /** Lowercase query terms that strongly suggest this bundle even
   *  before we look at the hits. */
  queryHints: readonly string[];
}

const KNOWN_BUNDLES: readonly ToolBundle[] = [
  {
    label: "Firmen-Recherche",
    tools: [
      "company_search",
      "company_get",
      "company_profile",
      "company_publications",
      "company_contacts",
      "company_crm_summary",
    ],
    queryHints: ["firma", "firmen", "company", "übersicht", "recherche"],
  },
  {
    label: "Notion-CRM-Update",
    tools: [
      "notion_list_databases",
      "notion_introspect_database",
      "notion_query_database",
      "notion_update_page",
    ],
    queryHints: ["notion", "crm update", "datenbank"],
  },
  {
    label: "Notion-Read",
    tools: ["notion_search", "notion_list_databases", "notion_get_page"],
    queryHints: ["notion search", "notion lesen"],
  },
  {
    label: "Obsidian-Notes",
    tools: [
      "obsidian_list_notes",
      "obsidian_search",
      "obsidian_get_note",
      "obsidian_create_note",
      "obsidian_append_to_note",
      "obsidian_replace_note",
    ],
    queryHints: ["obsidian", "vault", "markdown note"],
  },
  {
    label: "Meldungen / Alerts",
    tools: [
      "alerts_list",
      "alerts_dismiss",
      "alerts_dismiss_all",
      "alerts_purge",
      "alerts_trigger_heartbeat",
      "alerts_get_prefs",
      "alerts_set_prefs",
    ],
    queryHints: ["alert", "meldung", "benachrichtigung", "heartbeat"],
  },
  {
    label: "Import / Bulk",
    tools: [
      "import_excel",
      "import_company",
      "import_companies_from_crm",
      "import_status",
    ],
    queryHints: ["import", "excel", "csv", "bulk"],
  },
  {
    label: "Watches",
    tools: [
      "watch_register",
      "watch_list",
      "watch_remove",
      "watch_pause",
      "watch_resume",
    ],
    queryHints: ["watch", "beobachten", "wiederkehrend"],
  },
];

function detectBundle(
  hits: ReadonlyArray<{ name: string }>,
  query: string,
): ToolBundle | null {
  const hitNames = new Set(hits.map((h) => h.name));
  const q = query.toLowerCase();
  let best: { bundle: ToolBundle; score: number } | null = null;
  for (const bundle of KNOWN_BUNDLES) {
    const hitMatches = bundle.tools.filter((t) => hitNames.has(t)).length;
    if (hitMatches < 2) continue;
    const queryMatch = bundle.queryHints.some((h) => q.includes(h)) ? 5 : 0;
    const score = hitMatches * 2 + queryMatch;
    if (!best || score > best.score) {
      best = { bundle, score };
    }
  }
  return best?.bundle ?? null;
}
