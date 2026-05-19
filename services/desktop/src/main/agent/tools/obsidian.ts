import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { KnowledgeManager } from "../../knowledge/manager";

// v0.1.235 — Obsidian-Chat-Tools (Phase 3).
//
// Obsidian-Anbindung läuft über das Community-Plugin „Local REST API"
// — der Nutzer installiert + aktiviert es im Vault, gibt uns die
// Base-URL (typisch http://127.0.0.1:27123) und den API-Key aus den
// Plugin-Settings. Wir validieren Connectivity + speichern beide
// Werte verschlüsselt im OS-Keychain.

export function buildObsidianTools(deps: {
  knowledge: KnowledgeManager;
}): Tool[] {
  const km = deps.knowledge;

  const connectStart = defineTool({
    name: "obsidian_connect_start",
    description:
      "Begin connecting AVA to an Obsidian vault. Returns step-by-step instructions for the user to install the 'Local REST API' community plugin, copy the API key + port, and send both back. ALWAYS call this FIRST when the user asks to connect Obsidian — don't paraphrase the steps from memory.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => ({
      instructions: [
        '1. Öffne Obsidian. Geh zu Settings → Community plugins. Wenn nötig, schalte „Restricted mode“ aus.',
        '2. Klick auf „Browse“, suche „Local REST API“ (von „coddingtonbear“), installiere + aktiviere.',
        '3. Im aktivierten Plugin findest du den API-Key sowie die Server-Ports: „Insecure HTTP Server Port“ (Standard 27123) und „Encrypted HTTPS Server Port“ (27124).',
        "4. Empfehlung: HTTP nutzen (Port 27123). HTTPS hat ein selbst-signiertes Zertifikat, das macht mehr Aufwand als Nutzen für lokalen Verkehr.",
        '5. Kopier dir den API-Key. Schreib ihn mir zusammen mit der Base-URL zurück (z. B. „http://127.0.0.1:27123 — API-Key: xyz123“).',
      ].join("\n"),
      nextStep:
        "When the user replies with the credentials, call obsidian_connect_save_credentials with baseUrl + apiKey.",
    }),
    preview: () => "Obsidian-Connect-Anleitung gesendet",
  });

  const connectSaveCredentials = defineTool({
    name: "obsidian_connect_save_credentials",
    description:
      "Persist the Obsidian Local-REST-API credentials and validate them by hitting the / endpoint. Stores baseUrl + apiKey encrypted in the OS keychain. Returns ok+vault-name on success, or a structured error.",
    parameters: {
      type: "object",
      properties: {
        baseUrl: {
          type: "string",
          description:
            "Base URL of the Obsidian Local REST API plugin. Default for HTTP: http://127.0.0.1:27123. Default for HTTPS: https://127.0.0.1:27124.",
        },
        apiKey: {
          type: "string",
          description:
            "The API key shown in the Local REST API plugin settings.",
        },
      },
      required: ["baseUrl", "apiKey"],
    },
    schema: yup.object({
      baseUrl: yup
        .string()
        .trim()
        .matches(
          /^https?:\/\//i,
          "baseUrl muss mit http:// oder https:// beginnen",
        )
        .required(
          "baseUrl fehlt. Default ist http://127.0.0.1:27123 für den HTTP-Modus des Plugins.",
        ),
      apiKey: yup
        .string()
        .trim()
        .min(8, "API-Key wirkt zu kurz")
        .required("API-Key fehlt."),
    }),
    run: async (args) => {
      try {
        // Adapter erwartet einen JSON-Envelope als `token`. Siehe
        // ObsidianAdapter.connect() für das Format.
        const envelope = JSON.stringify({
          apiKey: args.apiKey,
          baseUrl: args.baseUrl,
        });
        await km.connect("obsidian", envelope);
        const snap = km.snapshot();
        const obsidian = snap.providers.find((p) => p.kind === "obsidian");
        return {
          ok: true,
          connected: true,
          vault: obsidian?.displayName ?? "Vault",
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
        ? `Obsidian verbunden: ${r.vault}`
        : `Obsidian-Connect fehlgeschlagen`,
  });

  const disconnect = defineTool({
    name: "obsidian_disconnect",
    description:
      "Disconnect Obsidian. Clears the stored API key + base URL from the OS keychain. The user will need to re-do the connect flow to reconnect.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      await km.disconnect("obsidian");
      return { ok: true };
    },
    preview: () => "Obsidian getrennt",
  });

  const search = defineTool({
    name: "obsidian_search",
    description:
      "Full-text search across the Obsidian vault. Returns up to 25 hits with file path (id), title, and a short context snippet. Use when the user references a note by content or topic.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search string. Plugin does substring matching.",
        },
        limit: {
          type: "integer",
          description: "Max number of results (default 25, max 100).",
        },
      },
      required: ["query"],
    },
    schema: yup.object({
      query: yup
        .string()
        .trim()
        .required("Suchbegriff fehlt — Obsidian-Search braucht ein query."),
      limit: yup.number().integer().min(1).max(100).optional(),
    }),
    run: async (args) => {
      const hits = await km.search("obsidian", args.query, {
        limit: args.limit ?? 25,
      });
      return { hits };
    },
    preview: (r) => `${(r.hits as Array<unknown>).length} Obsidian-Treffer`,
  });

  const getNote = defineTool({
    name: "obsidian_get_note",
    description:
      "Load a single Obsidian note by its vault-relative path. Returns the markdown content + frontmatter + timestamps. Path uses forward slashes and includes the .md extension (e.g., 'Daily Notes/2026-05-19.md').",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Vault-relative path to the note (e.g. 'CRM/Kerstin Komarnicki.md'). Forward slashes only.",
        },
      },
      required: ["path"],
    },
    schema: yup.object({
      path: yup
        .string()
        .trim()
        .required("path fehlt. Erst obsidian_search nutzen um den Pfad zu finden."),
    }),
    run: async (args) => {
      const item = await km.getItem("obsidian", args.path);
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Obsidian-Note: ${item?.title ?? "?"}`;
    },
  });

  const listNotes = defineTool({
    name: "obsidian_list_notes",
    description:
      "List files + sub-folders in a vault folder. Returns entries with `path` and `isFolder`. Pass an empty `folder` to list the vault root. Use this when the user wants to know what's in a specific folder.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description:
            "Vault-relative folder path. Empty string or omitted = vault root. Forward slashes only.",
        },
      },
      required: [],
    },
    schema: yup.object({
      folder: yup.string().optional(),
    }),
    run: async (args) => {
      const entries = await km.listObsidianFolder(args.folder ?? null);
      return { entries };
    },
    preview: (r) => {
      const count = (r.entries as Array<unknown>).length;
      return `${count} Einträge im Vault-Ordner`;
    },
  });

  const createNote = defineTool({
    name: "obsidian_create_note",
    description:
      "Create a new Obsidian note. Title becomes the filename (auto-appended .md). Optional folder parameter places it in a sub-folder; omit for vault root. Content is Markdown. Returns the new note's path + content.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Title of the note. Used as filename. Slashes / backslashes will be replaced with spaces.",
        },
        folder: {
          type: "string",
          description:
            "Optional vault-relative folder to place the note in. Empty = vault root.",
        },
        content: {
          type: "string",
          description:
            "Markdown body of the note. Can include YAML frontmatter at the top if needed.",
        },
      },
      required: ["title"],
    },
    schema: yup.object({
      title: yup.string().trim().required("title fehlt."),
      folder: yup.string().optional(),
      content: yup.string().optional(),
    }),
    run: async (args) => {
      const item = await km.createItem("obsidian", args.folder ?? null, {
        title: args.title,
        content: args.content,
      });
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Obsidian-Note erstellt: ${item?.title ?? "?"}`;
    },
  });

  const appendToNote = defineTool({
    name: "obsidian_append_to_note",
    description:
      "Append Markdown content to the end of an existing Obsidian note. Existing content stays untouched. To replace the whole note instead, use obsidian_replace_note.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path to the note (with .md).",
        },
        content: {
          type: "string",
          description: "Markdown to append at the end.",
        },
      },
      required: ["path", "content"],
    },
    schema: yup.object({
      path: yup.string().trim().required("path fehlt."),
      content: yup.string().required("content fehlt."),
    }),
    run: async (args) => {
      const item = await km.updateItem("obsidian", args.path, {
        appendContent: args.content,
      });
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Obsidian-Note erweitert: ${item?.title ?? "?"}`;
    },
  });

  const replaceNote = defineTool({
    name: "obsidian_replace_note",
    description:
      "Replace the ENTIRE content of an Obsidian note with new Markdown. Existing content is deleted. Use append_to_note instead if you want to add to existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    schema: yup.object({
      path: yup.string().trim().required("path fehlt."),
      content: yup.string().required("content fehlt."),
    }),
    run: async (args) => {
      const item = await km.updateItem("obsidian", args.path, {
        replaceContent: args.content,
      });
      return { item };
    },
    preview: (r) => {
      const item = r.item as { title?: string };
      return `Obsidian-Note überschrieben: ${item?.title ?? "?"}`;
    },
  });

  return [
    connectStart,
    connectSaveCredentials,
    disconnect,
    search,
    getNote,
    listNotes,
    createNote,
    appendToNote,
    replaceNote,
  ];
}
