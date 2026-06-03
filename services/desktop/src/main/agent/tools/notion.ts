import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { KnowledgeManager } from "../../knowledge/manager";

// v0.1.227 — Die in v0.1.226 hier eingebauten lokalen
// `coerceJsonObject` / `coerceJsonArray`-Helpers sind weg. Der zentrale
// Tool-Arg-Normalizer (`tool-arg-normalizer.ts`) macht das jetzt für
// ALLE Tools gleichzeitig. Wenn das Notion-Tool wieder einen
// LLM-Misformat-Trick sieht, ist es nicht mehr ein Notion-spezifisches
// Problem.

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
      "Workspace-wide fuzzy search across all pages and databases AVA's Notion integration has been granted access to. Returns up to 25 hits with id, title, type (page/database), and URL.\n\nUse this for general discovery (\"was hat der User schon in Notion?\"), NOT for finding a specific database row by name to update it. For that, use notion_list_databases + notion_query_database with a title-filter — search returns workspace-wide hits including sub-pages, notes, and linked-view shadows that can look like the row you want but aren't.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search string. Notion does fuzzy title + content matching. Empty string returns most-recent items.",
        },
        limit: {
          type: "integer",
          description: "Max number of results (default 25, max 100).",
        },
      },
      required: [],
    },
    schema: yup.object({
      // v0.1.233 — query optional gemacht. LLM ruft `notion_search` häufig
      // ohne Argument auf weil es denkt, das sei eine "discover-state"-
      // Operation. Notion's /v1/search akzeptiert leeren Query und liefert
      // dann jüngste Items zurück — das ist ein sinnvoller Default statt
      // einem nervigen "query is required"-Yup-Fehler.
      query: yup.string().optional(),
      limit: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      const limit = args.limit ?? 25;
      const hits = await km.search("notion", args.query ?? "", { limit });
      return { hits };
    },
    preview: (r) =>
      `${(r.hits as Array<unknown>).length} Notion-Treffer`,
  });

  const listDatabases = defineTool({
    name: "notion_list_databases",
    description:
      "List all Notion databases the integration has access to. Returns id + title + URL per entry. ALWAYS call this as STEP 1 when the user wants to read OR modify anything in their Notion CRM — do not ask the user 'which database' first. Pick the most CRM-shaped result automatically (by title); only fall back to ask_user_choice if there are two equally plausible candidates. If you've already called this in the current turn / earlier, you may reuse the result; do not call it twice in a row.",
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
      "Inspect the property schema of a specific Notion database — what columns it has, what type each is (title/select/multi_select/date/number/checkbox/status/…), and the available options for select-like columns. ALWAYS call this BEFORE notion_create_page OR notion_update_page targeting a database, so you can map the user's natural-language values (\"Status auf erledigt\") to the actual property name + the actual option name (\"Verloren\" or \"Abgeschlossen\" or whatever the schema actually offers). NEVER ask the user via ask_user_text what the field name or status option is — this tool returns that information directly.",
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
      databaseId: yup
        .string()
        .required(
          "databaseId fehlt. Erst notion_list_databases aufrufen und dann diese ID hier übergeben.",
        ),
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
      "Run a structured query against a Notion database. Returns matching rows with simplified properties. Use this — NOT notion_search — when you need to find a specific row by its title or other property to then update it.\n\nFINDING A ROW BY NAME (most common case): call notion_introspect_database FIRST to learn the exact name of the title-property. Then filter on that property. Required filter shape: {\"property\": \"<exact-name>\", \"<type>\": {\"contains\": \"<wert>\"}}. The wrapper key after `property` MUST match the property's actual type: `title` for title-fields, `rich_text` for text-fields, `select`/`status`/`multi_select` for option-fields, `date` for date-fields, `number` for numbers, `checkbox` for booleans.\n\nWORKING EXAMPLES (assume schema has title-property called 'Name'):\n  - Find by title-contains:   {\"property\":\"Name\",\"title\":{\"contains\":\"Kerstin\"}}\n  - Find by title-equals:     {\"property\":\"Name\",\"title\":{\"equals\":\"Kerstin Komarnicki\"}}\n  - Filter on status field:   {\"property\":\"Status\",\"status\":{\"equals\":\"Lead\"}}\n  - Filter on date:           {\"property\":\"Created\",\"date\":{\"on_or_after\":\"2026-01-01\"}}\n  - Combine with AND:         {\"and\":[ <filter1>, <filter2> ]}\n  - Combine with OR:          {\"or\":[ <filter1>, <filter2> ]}\n\nDO NOT SEND:\n  - Empty filter `{}` — that's invalid in Notion; just omit the parameter to get all rows.\n  - Type-wrapper without `property`: `{\"title\":{\"contains\":\"X\"}}` is missing the property name.\n  - Stringified JSON for the filter — pass a real object.\n\nIf Notion still returns 400, the error response contains the actual property list of the database — read it, pick the correct property + wrapper, and retry. See https://developers.notion.com/reference/post-database-query-filter for the full spec.\n\nWithout `filter`, returns the most recently edited rows.",
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
      databaseId: yup
        .string()
        .required(
          "databaseId fehlt. Erst notion_list_databases aufrufen um die richtige Datenbank-ID zu finden, dann diese hier übergeben.",
        ),
      filter: yup.object().optional(),
      sorts: yup.array().optional(),
      pageSize: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      // v0.1.233 — Filter-Shape defensiv normalisieren. Das LLM
      // schickt manchmal:
      //   - Array von Property-Filtern → Notion will `{and: [...]}` als Wrapper
      //   - Plattes Property-Filter aber ohne `property`-Key (z. B.
      //     `{Status: {equals: "Lead"}}`) → ungültig
      // Wir wrappen Arrays auto in `{and: ...}`. Andere Misformate
      // gehen unverändert durch und Notion antwortet mit ihrem
      // normalen Validation-Error, den der Agent dann self-healen
      // kann.
      let normalisedFilter = args.filter as unknown;
      if (Array.isArray(normalisedFilter)) {
        normalisedFilter = { and: normalisedFilter };
      }
      // v0.1.246 — Empty-Object-Filter weg, das ist Notion-ungültig.
      // Wenn der Agent wirklich keinen Filter wollte, soll er das
      // Argument einfach weglassen.
      if (
        normalisedFilter &&
        typeof normalisedFilter === "object" &&
        !Array.isArray(normalisedFilter) &&
        Object.keys(normalisedFilter as Record<string, unknown>).length === 0
      ) {
        normalisedFilter = undefined;
      }
      const items = await km.queryNotionDatabase(args.databaseId, {
        filter: normalisedFilter,
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
    schema: yup.object({
      pageId: yup
        .string()
        .required(
          "pageId fehlt. Erst notion_search oder notion_query_database benutzen, um eine Page-ID zu bekommen.",
        ),
    }),
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
      properties: yup.object().optional(),
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
      "Update an existing Notion page: patch property values and/or append Markdown content to the bottom. `replaceContent` is not yet supported in this version.\n\nMANDATORY PLAYBOOK when the user asks to change something in their Notion CRM (\"setze Status von ESIS auf erledigt\", \"Follow-Up von Beckmann auf 2026\"):\n  1. notion_list_databases — find the target DB. Pick the most CRM-shaped one automatically (by title); only ask the user when two are equally plausible.\n  2. notion_introspect_database — read the EXACT property names + the available Status/Select OPTIONS. You need this to map the user's word (\"erledigt\") to the actual option name (\"Verloren\" / \"Disqualifiziert\" / etc.).\n  3. notion_query_database — find the row by title-filter (the person or company the user named).\n  4. notion_update_page on THAT pageId with the mapped values.\n\nDO NOT, under any circumstances, ask the user via ask_user_text for: which database, which field, which status option, which row, or to spell out a value they already gave you in plain German. ALL of that is discoverable via the four tools above. The only acceptable user-question during this flow is a single ask_user_choice when an option-name truly cannot be inferred from the schema (e.g. user says \"hat sich erledigt\" and the Status field offers both \"Verloren\" AND \"Abgeschlossen\" as plausible mappings — show those two options).\n\nFinding the right pageId: DO NOT use notion_search for CRM-row lookups. It returns workspace-wide results including sub-pages, notes, and linked-database-views, so you can end up updating the wrong page that happens to share a title. Use notion_query_database with a title-filter instead. If you accidentally call notion_update_page on a non-row page, the tool throws a clear error and you should switch to the query_database flow.\n\nProperty values: pass FLAT values keyed by property name. Examples: { 'Status': 'Aktiv', 'Hotness': 'Cold', 'Follow-Up': '2026-07-16', 'Tags': ['lead', 'b2b'], 'Score': 42, 'Active': true }. DO NOT wrap in Notion-API objects like { 'Status': { 'status': { 'name': 'Aktiv' } } } — AVA does that mapping internally. DO NOT JSON.stringify the whole properties object — pass it as a real JSON object.\n\nThe tool has verify-after built in: if a property update silently no-ops or hits an invalid option, you get back a structured German error you can correct from. Lean on that instead of asking the user first.\n\nIF THE ERROR MENTIONS \"HTTP 200 aber serverseitig nichts gespeichert\" OR \"NICHT übernommen\": Sag dem User UNMISSVERSTÄNDLICH, dass die Notion-Integration vermutlich nur auf der einzelnen Page verbunden ist, nicht auf der gesamten Datenbank. Schreibvorgänge erfordern Database-Level-Connection. Anleitung an den User: 'Bitte in Notion die Datenbank öffnen (nicht die Row) → oben rechts ⋯ → Connections → AVA verbinden. Danach nochmal versuchen.' Probiere NICHT, das durch Property-Name-Variation oder Retry zu umgehen — das ist eine Berechtigungsfrage, kein Mapping-Bug.",
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
      properties: yup.object().optional(),
      appendContent: yup.string().optional(),
    }),
    run: async (args) => {
      const item = await km.updateItem("notion", args.pageId, {
        properties: args.properties as Record<string, unknown> | undefined,
        appendContent: args.appendContent,
      });
      // v0.1.237 — Warnings (z. B. „Property nicht im Schema") aus dem
      // Adapter aufs Top-Level heben, damit der Agent sie nicht im
      // verschachtelten Item übersieht.
      // v0.1.254 — Diagnostics auch hochheben (patchBodySent +
      // patchResponseLastEditedTime + patchResponseProperties), damit
      // der Agent bei silent-no-op-Symptomen direkt sehen kann was wir
      // an Notion geschickt und was Notion zurückgegeben hat, ohne im
      // Mainprozess-Log zu graben.
      const itemTyped = item as {
        warnings?: string[];
        diagnostics?: Record<string, unknown>;
      };
      const out: {
        item: typeof item;
        warnings?: string[];
        diagnostics?: Record<string, unknown>;
      } = { item };
      if (itemTyped.warnings && itemTyped.warnings.length > 0) {
        out.warnings = itemTyped.warnings;
      }
      if (itemTyped.diagnostics) {
        out.diagnostics = itemTyped.diagnostics;
      }
      return out;
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      const warnings = r.warnings as string[] | undefined;
      const suffix =
        warnings && warnings.length > 0
          ? ` (${warnings.length} Warnung${warnings.length === 1 ? "" : "en"})`
          : "";
      return `Notion-Seite aktualisiert: ${item?.title ?? "?"}${suffix}`;
    },
  });

  // v0.1.293 — Soft-Delete einer Notion-Page. Notion-API kennt kein
  // DELETE-Verb auf Pages; stattdessen `PATCH { archived: true }` →
  // Page landet im 30-Tage-Trash, von einem User (nicht der Integration)
  // wiederherstellbar. PROPOSE-AND-CONFIRM via ask_user_choice mit
  // Page-Vorschau, damit der User nicht versehentlich die falsche
  // löscht (mehrere Pages können denselben Titel haben — gerade bei
  // CRM-Setups mit "Herbst Datentechnik GmbH" + Dubletten).
  const deletePage = defineTool({
    name: "notion_delete_page",
    description:
      "Archiviert (= soft-delete) eine Notion-Page. PROPOSE-AND-CONFIRM via ask_user_choice mit Page-Vorschau (Titel + Properties). Notion stellt die Page 30 Tage lang im Trash bereit; ein User-Mitglied (nicht die Integration) kann sie dort wiederherstellen.\n\nBerechtigungs-Gotcha: gleiche Semantik wie notion_update_page — die Integration muss auf der DATENBANK verbunden sein, nicht nur auf der einzelnen Page. Sonst kommt HTTP 200 + keine Änderung zurück. Tool detected das per Verify-After und gibt eine klare Fehlermeldung mit Klick-Pfad.\n\nNutze für: stale leere Pages aufräumen (z. B. nach einem create-no-op), falsche Dubletten löschen, Test-Pages räumen. NICHT für CRM-Rows mit Daten — frag den User vorher explizit zur Bestätigung.",
    parameters: {
      type: "object",
      required: ["pageId"],
      properties: {
        pageId: { type: "string" },
        rationale: {
          type: "string",
          description: "Begründung, warum diese Page gelöscht werden soll (1 Satz).",
        },
      },
    },
    schema: yup
      .object({
        pageId: yup.string().trim().min(1).required(),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; error?: string }) =>
      r.applied
        ? "Notion-Page archiviert"
        : r.error
          ? `Fehler: ${r.error}`
          : "Nicht archiviert",
    run: async (args, ctx) => {
      // Page laden für die Vorschau im Confirm-Dialog.
      let preview: { title: string; url?: string; props: string };
      try {
        const item = await km.getItem("notion", args.pageId);
        const sampleProps = Object.entries(item.properties ?? {})
          .slice(0, 6)
          .map(([k, v]) => `  ${k}: ${formatPreviewValue(v)}`)
          .join("\n");
        preview = {
          title: item.title || "(ohne Titel)",
          url: item.url,
          props: sampleProps || "  (keine Properties)",
        };
      } catch (err) {
        return {
          applied: false,
          error:
            `Page ${args.pageId} nicht ladbar — möglicherweise schon archiviert ` +
            `oder falsche ID. Details: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Soll ich folgende Notion-Page ARCHIVIEREN?\n\n` +
          `Titel: ${preview.title}\n` +
          `ID: ${args.pageId}\n` +
          (preview.url ? `URL: ${preview.url}\n` : "") +
          `\nProperties (Auszug):\n${preview.props}${rationaleBlock}\n\n` +
          `Notion hält die Page 30 Tage lang im Trash — bis dahin kann sie ` +
          `ein User-Mitglied wiederherstellen.`,
        [
          {
            value: "archive",
            label: "Archivieren",
            description: "PATCH archived=true wird gesendet",
          },
          { value: "cancel", label: "Behalten" },
        ],
        ctx.signal,
      );
      if (value !== "archive") return userDeclined();
      try {
        await km.deleteItem("notion", args.pageId);
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
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
    deletePage,
  ];
}

// v0.1.293 — Mini-Helper für die Page-Vorschau im Confirm-Dialog.
// Hält Werte auf ~40 Zeichen, damit der Dialog nicht explodiert.
function formatPreviewValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.slice(0, 3).map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
