import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { KnowledgeManager } from "../../knowledge/manager";

// v0.1.226 — Defensive Coercion für LLM-Tool-Calls.
//
// Beobachtet bei mehreren Modell-Familien (Claude Sonnet 4, Gemma 4,
// Mistral): das LLM packt strukturierte Tool-Argumente gelegentlich
// in einen JSON-Stringify, statt sie als Objekt zu schicken. Yup
// lehnt das mit „properties must be a object type, but the final
// value was: '{…}'" ab.
//
// Tolerant-Parser: wenn das Argument als String reinkommt, versuchen
// wir es zu parsen. Klappt es, weiterreichen als Objekt; klappt es
// nicht, geben wir den String unverändert weiter — yup wirft dann
// wieder seinen normalen "must be object"-Fehler, der dem Agent
// klarer signalisiert, was schief lief.
function coerceJsonObject() {
  return yup
    .object()
    .nullable()
    .transform((value, originalValue) => {
      if (typeof originalValue === "string") {
        const s = originalValue.trim();
        if (s.length === 0) return null;
        try {
          const parsed = JSON.parse(s);
          if (typeof parsed === "object" && parsed !== null) return parsed;
        } catch {
          /* fall through; yup wird gleich werfen */
        }
      }
      return value;
    });
}

/** Same idea für Array-Argumente (z. B. `sorts` in query_database). */
function coerceJsonArray() {
  return yup
    .array()
    .nullable()
    .transform((value, originalValue) => {
      if (typeof originalValue === "string") {
        const s = originalValue.trim();
        if (s.length === 0) return null;
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed;
        } catch {
          /* fall through */
        }
      }
      return value;
    });
}

// v0.1.225 — Notion-Chat-Tools (Phase 2).
//
// 8 Tools — der Connect-Flow ist bewusst zweistufig (`notion_connect_start`
// + `notion_connect_save_token`), weil der eigentliche Token via Chat
// vom User gepastet wird und wir den vor dem Persist explizit
// entgegen nehmen wollen (keine impliziten LLM-zu-Tool-Weiterleitungen
// von Geheimnissen).
//
// Sicherheit beim Token-Handling:
//   - User sieht in der Bubble den Marker `[redacted: Notion-…]` weil
//     die Pre-Persist-Redaction im MemoryStore (v0.1.224) den
//     Token-Pattern erkennt.
//   - Token-Wert kommt durch das LLM als String-Argument zum Tool
//     `notion_connect_save_token({token: "ntn_..."})`. Tool-Call-Args
//     werden inzwischen ebenfalls vor Disk-Write redacted (v0.1.225,
//     `redactInValue` in memory.ts), also kein Klartext im Transcript.
//   - Adapter packt den Token in safeStorage (OS-Keychain). Niemand
//     ausserhalb sieht ihn jemals wieder.

export function buildNotionTools(deps: {
  knowledge: KnowledgeManager;
}): Tool[] {
  const km = deps.knowledge;

  // 1) Connect-Flow Stufe 1: Anleitung
  const connectStart = defineTool({
    name: "notion_connect_start",
    description:
      "Begin connecting AVA to a Notion workspace. Returns the step-by-step instructions for the user to create a Personal Access Token (PAT) and share their workspace with the AVA integration. ALWAYS call this FIRST when the user asks to connect Notion — don't paraphrase the steps from memory, return them verbatim from this tool. After the user sends back their token, call `notion_connect_save_token` with the token string.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => ({
      instructions: [
        '1. Öffne https://www.notion.so/profile/integrations in deinem Browser.',
        '2. Klick auf "+ New integration", gib ihr einen Namen (z. B. AVA) + wähle den Workspace, mit dem du AVA verbinden möchtest.',
        '3. Wähle "Internal integration" + setze die Capabilities (Read content, Update content, Insert content je nach Bedarf).',
        '4. Speichern. Kopier den "Internal Integration Token" (beginnt mit ntn_… oder secret_…).',
        '5. WICHTIG: Geh in Notion zu der Seite oder Datenbank, mit der AVA arbeiten soll. Oben rechts auf "...", dann "Connections", dann "AVA" hinzufügen. Ohne diesen Schritt sieht die Integration deine Inhalte nicht.',
        '6. Schreib mir den Token zurück. Ich speichere ihn verschlüsselt im OS-Schlüsselbund.',
      ].join("\n"),
      nextStep:
        "When the user sends the token, call notion_connect_save_token with it.",
    }),
    preview: () => "Notion-Connect-Anleitung gesendet",
  });

  // 2) Connect-Flow Stufe 2: Token speichern + validieren
  const connectSaveToken = defineTool({
    name: "notion_connect_save_token",
    description:
      "Persist the Notion Personal Access Token the user just pasted in chat, then validate it by making a /v1/users/me call. The token is stored encrypted in the OS keychain. Returns the workspace display name on success or a structured error message on failure (most common: 401 invalid token, 403 integration not added to any pages yet). Never echo the token back in your reply.",
    parameters: {
      type: "object",
      properties: {
        token: {
          type: "string",
          description:
            "The Notion Personal Access Token, exactly as the user pasted it. Starts with ntn_ or secret_.",
        },
      },
      required: ["token"],
    },
    schema: yup.object({
      token: yup
        .string()
        .trim()
        .min(20, "Notion-Token wirkt zu kurz")
        .required(),
    }),
    run: async (args) => {
      try {
        await km.connect("notion", args.token);
        const snap = km.snapshot();
        const notion = snap.providers.find((p) => p.kind === "notion");
        return {
          ok: true,
          connected: true,
          workspace: notion?.displayName ?? "Unbekannt",
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Notion verbunden: ${r.workspace}`
        : `Notion-Connect fehlgeschlagen`,
  });

  const disconnect = defineTool({
    name: "notion_disconnect",
    description:
      "Disconnect Notion. Clears the stored token from the OS keychain. The user will need to re-do the connect flow to reconnect.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      await km.disconnect("notion");
      return { ok: true };
    },
    preview: () => "Notion getrennt",
  });

  const search = defineTool({
    name: "notion_search",
    description:
      "Workspace-wide fuzzy search across all pages and databases AVA's Notion integration has been granted access to. Returns up to 25 hits with id, title, type (page/database), and URL. Use this when the user references something by name and you need to find the matching object ID.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search string. Notion does fuzzy title + content matching.",
        },
        limit: {
          type: "integer",
          description: "Max number of results (default 25, max 100).",
        },
      },
      required: ["query"],
    },
    schema: yup.object({
      query: yup.string().required(),
      limit: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      const limit = args.limit ?? 25;
      const hits = await km.search("notion", args.query, { limit });
      return { hits };
    },
    preview: (r) =>
      `${(r.hits as Array<unknown>).length} Notion-Treffer`,
  });

  const listDatabases = defineTool({
    name: "notion_list_databases",
    description:
      "List all Notion databases the integration has access to. Returns id + title + URL per entry. Call this when the user wants to see/pick a CRM-like database (e.g. 'add this to my CRM in Notion').",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const databases = await km.listNotionDatabases();
      return { databases };
    },
    preview: (r) =>
      `${(r.databases as Array<unknown>).length} Notion-Datenbanken`,
  });

  const introspectDatabase = defineTool({
    name: "notion_introspect_database",
    description:
      "Inspect the property schema of a specific Notion database — what columns it has, what type each is (title/select/multi_select/date/number/checkbox/status/…), and the available options for select-like columns. ALWAYS call this BEFORE notion_create_page targeting a database, so you map your input to the actual property names that database uses.",
    parameters: {
      type: "object",
      properties: {
        databaseId: {
          type: "string",
          description:
            "The Notion database ID (UUID or hyphenated UUID).",
        },
      },
      required: ["databaseId"],
    },
    schema: yup.object({
      databaseId: yup.string().required(),
    }),
    run: async (args) => {
      const schema = await km.introspectSchema("notion", args.databaseId);
      return { schema };
    },
    preview: (r) => {
      const schema = r.schema as { containerTitle?: string; properties?: unknown[] };
      const count = Array.isArray(schema?.properties) ? schema.properties.length : 0;
      return `Notion-DB „${schema?.containerTitle ?? "?"}": ${count} Properties`;
    },
  });

  const queryDatabase = defineTool({
    name: "notion_query_database",
    description:
      "Run a structured query against a Notion database. Returns matching rows with simplified properties. Use filter + sorts only if you've already introspected the schema. Without filters, returns the most recently edited rows.",
    parameters: {
      type: "object",
      properties: {
        databaseId: { type: "string" },
        filter: {
          type: "object",
          description:
            "Notion filter spec, see https://developers.notion.com/reference/post-database-query-filter. Pass null/omit for unfiltered.",
        },
        sorts: {
          type: "array",
          description:
            "Notion sorts spec, e.g. [{property: 'Name', direction: 'ascending'}].",
        },
        pageSize: {
          type: "integer",
          description: "Max number of results (default 25, max 100).",
        },
      },
      required: ["databaseId"],
    },
    schema: yup.object({
      databaseId: yup.string().required(),
      // v0.1.226 — `filter` / `sorts` werden vom LLM gelegentlich als
      // JSON-Strings statt als strukturierte Werte geschickt. Tolerant
      // parsen + dann validieren.
      filter: coerceJsonObject().optional(),
      sorts: coerceJsonArray().optional(),
      pageSize: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      const items = await km.queryNotionDatabase(args.databaseId, {
        filter: args.filter,
        sorts: args.sorts,
        pageSize: args.pageSize,
      });
      return { items };
    },
    preview: (r) => `${(r.items as Array<unknown>).length} Notion-Zeilen`,
  });

  const getPage = defineTool({
    name: "notion_get_page",
    description:
      "Load a single Notion page (or database row): its title, properties, and content body converted to Markdown. The page ID comes from notion_search or notion_query_database.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string" },
      },
      required: ["pageId"],
    },
    schema: yup.object({ pageId: yup.string().required() }),
    run: async (args) => {
      const item = await km.getItem("notion", args.pageId);
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Notion-Seite: ${item?.title ?? "?"}`;
    },
  });

  const createPage = defineTool({
    name: "notion_create_page",
    description:
      "Create a new Notion page. If the parent is a database, properties must match the database schema (call notion_introspect_database first to learn the property names + types). If the parent is a page, only `title` and `content` apply. `content` accepts Markdown (paragraphs, headings #/##/###, bullet/numbered lists, [ ]/[x] to-dos, > quotes, ```code blocks```, ---). Returns the created page ID + URL.\n\nProperty values: pass FLAT values keyed by property name. Examples: { 'Name': 'Eclat GmbH', 'Status': 'Lead', 'Tags': ['b2b'], 'Erstkontakt': '2026-05-18' }. DO NOT wrap in Notion-API objects. DO NOT JSON.stringify the whole properties object.",
    parameters: {
      type: "object",
      properties: {
        parentId: {
          type: "string",
          description:
            "Database ID or Page ID under which to create the new page.",
        },
        title: { type: "string" },
        properties: {
          type: "object",
          description:
            "Database-property values, keyed by the EXACT property name from the schema. Strings for title/rich_text/select/status, arrays for multi_select, ISO 8601 for date, numbers for number, booleans for checkbox.",
        },
        content: {
          type: "string",
          description:
            "Markdown body content. Optional; can be added later via notion_update_page.",
        },
      },
      required: ["parentId"],
    },
    schema: yup.object({
      parentId: yup.string().required(),
      title: yup.string().optional(),
      // v0.1.226 — siehe coerceJsonObject(): LLM kann das auch als
      // JSON-String schicken; wir parsen das tolerant.
      properties: coerceJsonObject().optional(),
      content: yup.string().optional(),
    }),
    run: async (args) => {
      const item = await km.createItem("notion", args.parentId, {
        title: args.title,
        properties: args.properties as Record<string, unknown> | undefined,
        content: args.content,
      });
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string; url?: string };
      return `Notion-Seite erstellt: ${item?.title ?? "?"}`;
    },
  });

  const updatePage = defineTool({
    name: "notion_update_page",
    description:
      "Update an existing Notion page: patch property values and/or append Markdown content to the bottom. Property names must match the actual database schema (use notion_introspect_database if unsure). `replaceContent` is not yet supported in this version.\n\nProperty values: pass FLAT values keyed by property name. Examples: { 'Status': 'Aktiv', 'Hotness': 'Cold', 'Follow-Up': '2026-07-16', 'Tags': ['lead', 'b2b'], 'Score': 42, 'Active': true }. DO NOT wrap in Notion-API objects like { 'Status': { 'status': { 'name': 'Aktiv' } } } — AVA does that mapping internally. DO NOT JSON.stringify the whole properties object — pass it as a real JSON object.",
    parameters: {
      type: "object",
      properties: {
        pageId: { type: "string" },
        properties: {
          type: "object",
          description:
            "Partial map of property name → new value. Properties not listed remain unchanged.",
        },
        appendContent: {
          type: "string",
          description:
            "Markdown to append at the end of the page body. Existing content stays put.",
        },
      },
      required: ["pageId"],
    },
    schema: yup.object({
      pageId: yup.string().required(),
      // v0.1.226 — tolerantes Object-Parsing (siehe coerceJsonObject).
      properties: coerceJsonObject().optional(),
      appendContent: yup.string().optional(),
    }),
    run: async (args) => {
      const item = await km.updateItem("notion", args.pageId, {
        properties: args.properties as Record<string, unknown> | undefined,
        appendContent: args.appendContent,
      });
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Notion-Seite aktualisiert: ${item?.title ?? "?"}`;
    },
  });

  return [
    connectStart,
    connectSaveToken,
    disconnect,
    search,
    listDatabases,
    introspectDatabase,
    queryDatabase,
    getPage,
    createPage,
    updatePage,
  ];
}
