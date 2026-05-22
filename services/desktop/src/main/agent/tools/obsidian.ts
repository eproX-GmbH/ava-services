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

  // v0.1.296 — Frontmatter-Patch. Schreibt YAML-Header-Felder einer
  // Note in-place; Body bleibt unverändert. Use-Case: Obsidian-als-CRM,
  // wo Status/Stage/Owner/Datums-Felder im Frontmatter liegen.
  //
  // Properties müssen als FLATE Werte rein, NICHT als YAML-String. Der
  // Adapter macht die Type-Korrekturen (String → "Aktiv", Bool → true,
  // Array → ["b2b", "lead"], Date-String → "2026-07-16"). Pro Key
  // schickt der Adapter einen PATCH-Call ans Plugin; Verify-After durch
  // Re-Read des Frontmatters.
  const updateFrontmatter = defineTool({
    name: "obsidian_update_frontmatter",
    description:
      "Update YAML-frontmatter fields of an Obsidian note. Body content stays untouched. Use this when the user wants to change a CRM-style field that lives in the YAML header (Status, Stage, Owner, Follow-Up, Tags, …).\n\nPlaybook for CRM-style requests ('setze Status von X-Note auf Aktiv', 'Follow-Up von Beckmann auf 2026'):\n  1. obsidian_search ODER obsidian_list_notes — finde die Note. Lieber `list_notes` mit Folder-Pfad als Workspace-Suche, weil letzteres auch Body-Treffer einbezieht.\n  2. obsidian_get_note — lies das aktuelle Frontmatter, damit du die EXAKTEN Key-Namen (case-sensitive!) und das aktuelle Wert-Schema (string vs. array vs. bool) siehst.\n  3. obsidian_update_frontmatter mit den geänderten Keys.\n\nProperty values: pass FLAT values. Examples: { 'Status': 'Aktiv', 'Stage': 'Lead', 'Follow-Up': '2026-07-16', 'Tags': ['b2b','lead'], 'Hotness': 'Cold' }. NICHT als YAML-String wrappen.\n\nIF VERIFY-AFTER FAILS mit 'nicht übernommen': Der API-Key hat vermutlich nur Read-Scope. User-Anweisung: 'Bitte in Obsidian → Settings → Local REST API prüfen, ob der genutzte API-Key Write-Berechtigung hat. Falls nein, einen neuen Key mit vollem Scope erzeugen und in AVA neu hinterlegen.' NICHT durch Property-Variation retryen — Berechtigungsfrage.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        properties: {
          type: "object",
          description:
            "Map of frontmatter-key → new value. Keys not listed remain unchanged.",
        },
      },
      required: ["path", "properties"],
    },
    schema: yup.object({
      path: yup.string().trim().required("path fehlt."),
      properties: yup.object().required("properties fehlt."),
    }),
    run: async (args) => {
      const item = await km.updateItem("obsidian", args.path, {
        properties: args.properties as Record<string, unknown> | undefined,
      });
      // Warnings + Diagnostics aus dem Adapter aufs Top-Level heben.
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
      return `Obsidian-Frontmatter aktualisiert: ${item?.title ?? "?"}${suffix}`;
    },
  });

  // v0.1.296 — Delete-Tool mit Propose-and-Confirm. Obsidian löscht
  // DIREKT (kein Trash via REST-API), deshalb Pflicht-Gate mit
  // Vorschau (Path, Frontmatter-Auszug, erste 3 Body-Zeilen).
  const deleteNote = defineTool({
    name: "obsidian_delete_note",
    description:
      "Löscht eine Obsidian-Note PERMANENT (kein Vault-Trash via REST-API). PROPOSE-AND-CONFIRM via ask_user_choice mit Path + Frontmatter-Vorschau + erste 3 Body-Zeilen. Bei explizitem User-Wunsch oder zum Aufräumen von Test/Stale-Notes.\n\nACHTUNG: Im Gegensatz zu Notion gibt es KEIN Soft-Delete — die Datei ist nach DELETE weg (es sei denn ein Backup-System wie Obsidian Sync / iCloud / Git-Repo fängt es ab). Frag den User bei Unsicherheit IMMER vor dem Aufruf — nicht erst der Confirm-Dialog vom Tool.\n\nIF VERIFY-AFTER MELDET 'existiert immer noch': API-Key hat keinen Write-Scope. Gleiche Diagnose wie bei update_frontmatter.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        rationale: {
          type: "string",
          description: "Begründung warum diese Note gelöscht werden soll (1 Satz).",
        },
      },
      required: ["path"],
    },
    schema: yup
      .object({
        path: yup.string().trim().required("path fehlt."),
        rationale: yup.string().trim().max(500).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; error?: string }) =>
      r.applied
        ? "Obsidian-Note gelöscht"
        : r.error
          ? `Fehler: ${r.error}`
          : "Nicht gelöscht",
    run: async (args, ctx) => {
      // Note laden für Confirm-Vorschau.
      let preview: { title: string; fm: string; bodyHead: string };
      try {
        const item = await km.getItem("obsidian", args.path);
        const fmEntries = Object.entries(item.properties ?? {})
          .slice(0, 5)
          .map(([k, v]) => `  ${k}: ${formatPreviewValue(v)}`)
          .join("\n");
        const body = item.content ?? "";
        const bodyHead = body
          .split("\n")
          .slice(0, 3)
          .map((l) => "  " + (l.length > 80 ? l.slice(0, 77) + "…" : l))
          .join("\n");
        preview = {
          title: item.title || args.path,
          fm: fmEntries || "  (keine Frontmatter-Felder)",
          bodyHead: bodyHead || "  (leerer Body)",
        };
      } catch (err) {
        return {
          applied: false,
          error:
            `Note "${args.path}" nicht ladbar — möglicherweise schon ` +
            `gelöscht oder falscher Pfad. Details: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const rationaleBlock = args.rationale
        ? `\n\nBegründung: ${args.rationale}`
        : "";
      const value = await ctx.ui.askChoice(
        `Soll ich folgende Obsidian-Note PERMANENT LÖSCHEN?\n\n` +
          `Pfad: ${args.path}\n` +
          `Titel: ${preview.title}\n\n` +
          `Frontmatter (Auszug):\n${preview.fm}\n\n` +
          `Body-Anfang:\n${preview.bodyHead}${rationaleBlock}\n\n` +
          `⚠ ACHTUNG: Obsidian REST-API hat keinen Trash — die Datei ist ` +
          `nach DELETE weg, außer ein externes Backup (Obsidian Sync, ` +
          `iCloud, Git) fängt es ab.`,
        [
          {
            value: "delete",
            label: "Löschen",
            description: "DELETE wird gesendet",
          },
          { value: "cancel", label: "Behalten" },
        ],
        ctx.signal,
      );
      if (value !== "delete") return { applied: false };
      try {
        await km.deleteItem("obsidian", args.path);
        return { applied: true };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // v0.1.297 — Folder-Schema-Introspection. Aggregiert die Frontmatter-
  // Konvention eines Ordners (z. B. CRM/) damit der Agent vor einem
  // update_frontmatter weiss, welche Keys es gibt und was übliche Werte
  // sind. Notion-Äquivalent: introspect_database.
  const introspectFolder = defineTool({
    name: "obsidian_introspect_folder",
    description:
      "Sampled bis zu 20 Notes (Default) in einem Vault-Ordner und gibt eine aggregierte Übersicht der Frontmatter-Konvention zurück: welche YAML-Keys gibt es überhaupt, was sind ihre Werte-Typen (string/number/boolean/array/date), wie oft kommen sie vor, was sind beispielhafte Werte. Nutze das VOR obsidian_update_frontmatter sobald du den Zielordner kennst, damit du die exakten Key-Namen (case-sensitive!) und die passenden Wert-Typen siehst. Vault-Schema gibt's konzeptionell nicht — das ist die nächstbeste Approximation.\n\nSonst-Strategie: Wenn du keinen Ordner kennst, frag den User. Heuristik für CRM: Ordner-Namen mit 'CRM', 'Kontakte', 'Pipeline', 'Deals' sind plausibel — wenn ein einzelner offensichtlich passt, nimm den ohne nachzufragen.",
    parameters: {
      type: "object",
      properties: {
        folder: {
          type: "string",
          description:
            "Vault-relativer Ordner-Pfad ohne führenden Slash. Beispiel: 'CRM' oder 'Projekte/2026'.",
        },
        sampleSize: {
          type: "number",
          description:
            "Wie viele Notes maximal sampeln (Default 20, Min 1, Max 50). Größer = präzisere Aggregation, aber mehr Latenz.",
        },
      },
      required: ["folder"],
    },
    schema: yup.object({
      folder: yup.string().trim().required("folder fehlt."),
      sampleSize: yup.number().integer().min(1).max(50).optional(),
    }),
    run: async (args) => {
      return km.introspectObsidianFolder(args.folder, {
        sampleSize: args.sampleSize,
      });
    },
    preview: (r) => {
      const summary = r as {
        folder?: string;
        notesScanned?: number;
        keys?: Array<unknown>;
      };
      return `Obsidian-Ordner '${summary.folder ?? "?"}' introspected: ${summary.notesScanned ?? 0} Notes, ${summary.keys?.length ?? 0} Keys`;
    },
  });

  // v0.1.297 — Tag-Listing.
  const listTags = defineTool({
    name: "obsidian_list_tags",
    description:
      "Listet alle Tags im Vault mit der jeweiligen Anzahl Notes. Nutze das, wenn der User nach Tag-Strukturen fragt ('welche Tags hab ich überhaupt?') oder als Vorbereitung für eine Tag-basierte Filterung.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const tags = await km.listObsidianTags();
      return { tags };
    },
    preview: (r) => {
      const tags = (r as { tags?: Array<unknown> }).tags ?? [];
      return `Obsidian-Vault: ${tags.length} Tag${tags.length === 1 ? "" : "s"}`;
    },
  });

  // v0.1.297 — Tag-Suche. Schneller + zielsicherer als obsidian_search,
  // wenn der User Tag-basiert filtern will ('alle #lead-Notes').
  const searchByTag = defineTool({
    name: "obsidian_search_by_tag",
    description:
      "Listet alle Notes mit einem bestimmten Tag. Tag mit oder ohne führendes # akzeptiert. Schneller + zielsicherer als obsidian_search, wenn der User Tag-basiert filtern will ('zeig mir alle #lead-Notes', 'welche Notes haben #b2b?'). Falls du nicht sicher bist welche Tags es überhaupt gibt: erst obsidian_list_tags.",
    parameters: {
      type: "object",
      properties: {
        tag: {
          type: "string",
          description:
            "Tag-Name mit oder ohne führendes #. Beispiele: 'lead', '#lead', 'b2b/customer'.",
        },
      },
      required: ["tag"],
    },
    schema: yup.object({
      tag: yup.string().trim().required("tag fehlt."),
    }),
    run: async (args) => {
      const hits = await km.searchObsidianByTag(args.tag);
      return { tag: args.tag, hits };
    },
    preview: (r) => {
      const hits = (r as { hits?: Array<unknown> }).hits ?? [];
      const tag = (r as { tag?: string }).tag ?? "?";
      return `${hits.length} Note${hits.length === 1 ? "" : "s"} mit Tag '${tag}'`;
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
    updateFrontmatter,
    deleteNote,
    introspectFolder,
    listTags,
    searchByTag,
  ];
}

// v0.1.296 — Lokaler Mini-Helper für die Delete-Confirm-Vorschau.
// (Spiegelt formatPreviewValue aus notion.ts; bewusst dupliziert
// statt geteilt, weil beide Tools eigentlich unabhängig sind.)
function formatPreviewValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (Array.isArray(v)) return v.slice(0, 3).map(String).join(", ");
  if (typeof v === "object") return JSON.stringify(v).slice(0, 60);
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
