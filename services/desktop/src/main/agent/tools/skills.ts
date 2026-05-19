import { existsSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { SkillStore } from "../../skills/store";
import type { SkillsTrustStore } from "../../skills/trust-store";
import { saveSkillToDisk } from "../../skills/save";
import { B2B_SCOPES, LANGUAGES, type B2bScope } from "../../skills/schema";

// v0.1.236 — Knowledge P4: Self-Authoring Skills mit Human-in-the-Loop.
//
// Der Agent kann eigene Skills (gespeicherte Mini-Playbooks) anlegen,
// suchen, lesen und löschen. JEDE Mutation läuft über
// `ctx.ui.askChoice` als Inline-Bestätigung im Chat — der User sagt
// explizit Ja/Nein, bevor die Datei geschrieben oder gelöscht wird.
//
// Architektur:
//   - Skills sind SKILL.md-Dateien unter `<userData>/skills/<name>/`.
//   - SkillStore (fs-watch) reloaded automatisch, sobald die Datei
//     da/weg ist. Wir rufen trotzdem explizit `reload()`, weil watch
//     auf Linux nur den Top-Level beobachtet.
//   - User-erstellte Skills sind by-default untrusted. Wenn der User
//     den Inline-Confirm bestätigt, vertrauen wir den Skill sofort
//     automatisch (über SkillsTrustStore) — sonst müsste er gleich
//     zweimal zustimmen (einmal im Chat, einmal im Settings-Tab).
//   - `requires-user-confirm` bleibt im Frontmatter `true` (Schema-
//     Default), sodass beim späteren AUSFÜHREN des Skills nochmal
//     pro Run gefragt wird. Anlegen ≠ blanko-Ausführen.

export function buildSkillsTools(deps: {
  /** Lazy-Getter: SkillStore wird im Boot erst NACH dem
   *  Registry-Build initialisiert (siehe main/index.ts). */
  getSkillStore: () => SkillStore | null;
  /** Lazy-Getter aus dem gleichen Grund. */
  getTrustStore: () => SkillsTrustStore | null;
  /** Absoluter Pfad zu `<userData>/skills`. */
  userDir: string;
  /** Lazy-Getter für die aktuelle Tool-Liste (Validierung von
   *  `allowedTools`). Wird lazy ausgewertet, weil die Registry beim
   *  Tool-Build noch nicht vollständig ist — `availableTools` liefert
   *  zum Aufrufzeitpunkt die finale Liste inklusive der hier
   *  registrierten skill_*-Tools. */
  availableTools: () => string[];
}): Tool[] {
  const { userDir } = deps;
  const getStore = (): SkillStore | null => deps.getSkillStore();
  const getTrust = (): SkillsTrustStore => {
    const t = deps.getTrustStore();
    if (!t) {
      throw new Error(
        "Skills-Trust-Store ist nicht initialisiert. Bitte AVA neu starten.",
      );
    }
    return t;
  };

  // -------- Helpers ---------------------------------------------------------

  const ensureStore = (): SkillStore => {
    const s = getStore();
    if (!s) {
      throw new Error(
        "Skills-Store ist nicht initialisiert. Bitte AVA neu starten.",
      );
    }
    return s;
  };

  const safeUnderUserDir = (name: string): string => {
    const target = resolve(join(userDir, name));
    const root = resolve(userDir);
    if (!target.startsWith(root + sep)) {
      throw new Error(`Ungültiger Skill-Name (Pfad-Traversal abgewiesen).`);
    }
    return target;
  };

  // -------- skill_list ------------------------------------------------------

  const list = defineTool({
    name: "skill_list",
    description:
      "List all skills available to AVA (user-scope + workspace-scope). Returns name, description, language, b2b-scope, enabled-state and trust-state. Use this when the user asks 'welche Skills hast du?' or before suggesting to create a new one (avoid duplicates).",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}),
    run: async () => {
      const store = ensureStore();
      const rows = store.list().map((s) => ({
        name: s.name,
        description: s.description,
        language: s.language,
        b2bScope: s.b2bScope,
        scope: s.scope,
        trust: s.trust,
        gateSatisfied: s.gateSatisfied,
        gateReason: s.gateReason,
        allowedTools: s.allowedTools,
      }));
      return { skills: rows };
    },
    preview: (r) => `${(r.skills as Array<unknown>).length} Skills geladen`,
  });

  // -------- skill_get -------------------------------------------------------

  const get = defineTool({
    name: "skill_get",
    description:
      "Load the full content of one skill — frontmatter + markdown body. Use BEFORE proposing an update so you have the exact existing body to diff against.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Kebab-case name of the skill (as returned by skill_list).",
        },
      },
      required: ["name"],
    },
    schema: yup.object({
      name: yup.string().trim().required("name fehlt."),
    }),
    run: async (args) => {
      const store = ensureStore();
      const s = store.get(args.name);
      if (!s) {
        return { ok: false, error: `Skill '${args.name}' nicht gefunden.` };
      }
      return {
        ok: true,
        skill: {
          name: s.name,
          description: s.description,
          language: s.language,
          b2bScope: s.b2bScope,
          allowedTools: s.allowedTools,
          requiresUserConfirm: s.requiresUserConfirm,
          userInvocable: s.userInvocable,
          body: s.body,
          scope: s.scope,
          trust: s.trust,
        },
      };
    },
    preview: (r) => (r.ok ? `Skill geladen: ${(r.skill as { name: string }).name}` : "Skill nicht gefunden"),
  });

  // -------- skill_search ----------------------------------------------------

  const search = defineTool({
    name: "skill_search",
    description:
      "Substring-search across skill names + descriptions + bodies. Returns up to 10 hits sorted by relevance. Use this at the start of EVERY turn where the user asks AVA to do something repeatable ('mach mir ein …', 'wie immer …', 'analysiere das Profil') — there might already be a skill for it.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (case-insensitive)." },
      },
      required: ["query"],
    },
    schema: yup.object({
      query: yup.string().trim().min(1).required("query fehlt."),
    }),
    run: async (args) => {
      const store = ensureStore();
      const q = args.query.toLowerCase();
      const scored = store
        .list()
        .map((s) => {
          let score = 0;
          if (s.name.toLowerCase().includes(q)) score += 10;
          if (s.description.toLowerCase().includes(q)) score += 5;
          if (s.body.toLowerCase().includes(q)) score += 1;
          return { s, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map(({ s }) => ({
          name: s.name,
          description: s.description,
          b2bScope: s.b2bScope,
          trust: s.trust,
        }));
      return { hits: scored };
    },
    preview: (r) => `${(r.hits as Array<unknown>).length} Skill-Treffer`,
  });

  // -------- skill_create ----------------------------------------------------

  const create = defineTool({
    name: "skill_create",
    description:
      "Create a new skill OR overwrite an existing user-scope skill. ALWAYS prompts the user for inline confirmation via a Ja/Nein dialog BEFORE writing — the user sees the proposed frontmatter + body preview. Use when the user says 'merk dir das als Skill', 'leg dafür einen Skill an', or after they've taught you a procedure you'd want to re-use. Workspace-scope skills can NOT be overwritten here.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Kebab-case identifier, e.g. 'outreach-followup'. Lowercase letters, digits, dashes. Must start with a letter.",
        },
        description: {
          type: "string",
          description:
            "One-sentence trigger that AVA later uses to decide when this skill applies. Write it from AVA's perspective: 'Wenn der Nutzer einen LinkedIn-Profil-Link schickt, …'",
        },
        body: {
          type: "string",
          description:
            "Markdown instructions for AVA. Step-by-step, imperative ('Suche …', 'Antworte …'). This is the skill itself.",
        },
        language: {
          type: "string",
          enum: ["de", "en"],
          description: "Sprache der Skill-Inhalte. Default 'de'.",
        },
        b2bScope: {
          type: "string",
          enum: [...B2B_SCOPES],
          description:
            "Welcher B2B-Kontext: outreach | qualifying | competitive | data-extraction | internal.",
        },
        allowedTools: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: liste konkreter Tools, die der Skill aufrufen darf (z.B. ['notion_search', 'company_get']). Leer = reine Prosa-Skill ohne Tool-Aufrufe.",
        },
      },
      required: ["name", "description", "body", "b2bScope"],
    },
    schema: yup.object({
      name: yup.string().trim().required("name fehlt."),
      description: yup.string().trim().required("description fehlt."),
      body: yup.string().required("body fehlt."),
      language: yup.mixed<typeof LANGUAGES[number]>().oneOf([...LANGUAGES]).optional(),
      b2bScope: yup.mixed<B2bScope>().oneOf([...B2B_SCOPES]).required("b2bScope fehlt."),
      allowedTools: yup.array().of(yup.string().required()).optional(),
    }),
    run: async (args, ctx) => {
      const store = ensureStore();
      const existing = store.get(args.name);
      if (existing && existing.scope === "workspace") {
        return {
          ok: false,
          error:
            "Dieser Skill liegt im Workspace-Repo und kann nicht durch AVA überschrieben werden. Der Nutzer muss ihn dort selbst editieren.",
        };
      }

      // Validiere allowed-tools gegen die laufende Tool-Registry, damit
      // der Agent keinen Phantom-Tool-Namen einbaut.
      const known = new Set(deps.availableTools());
      const unknown = (args.allowedTools ?? []).filter((t) => !known.has(t));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `Unbekannte Tools in allowed-tools: ${unknown.join(", ")}. Skill nicht angelegt.`,
        };
      }

      // Inline-Confirmation im Chat.
      const isUpdate = !!existing;
      const preview = args.body.length > 600 ? args.body.slice(0, 600) + "…" : args.body;
      const prompt =
        (isUpdate
          ? `Soll ich den bestehenden Skill **${args.name}** ersetzen?`
          : `Soll ich folgendes neues Skill anlegen?`) +
        `\n\n**Name:** ${args.name}` +
        `\n**Beschreibung:** ${args.description}` +
        `\n**Scope:** ${args.b2bScope}` +
        `\n**Erlaubte Tools:** ${(args.allowedTools ?? []).join(", ") || "(keine)"}` +
        `\n\n---\n${preview}`;
      const choice = await ctx.ui.askChoice(
        prompt,
        [
          { value: "yes", label: isUpdate ? "Ja, ersetzen" : "Ja, anlegen" },
          { value: "no", label: "Nein, abbrechen" },
        ],
        ctx.signal,
      );
      if (choice !== "yes") {
        return { ok: false, cancelled: true, error: "Vom Nutzer abgelehnt." };
      }

      const saveResult = await saveSkillToDisk(userDir, {
        frontmatter: {
          name: args.name,
          description: args.description,
          language: args.language ?? "de",
          "b2b-scope": args.b2bScope,
          "allowed-tools": args.allowedTools ?? [],
          "requires-user-confirm": true,
          "disable-model-invocation": false,
          "user-invocable": true,
          arguments: [],
        },
        body: args.body,
      });
      if (!saveResult.ok) {
        return { ok: false, error: saveResult.error ?? "Schreiben fehlgeschlagen." };
      }

      // Store neu einlesen — die fs-watch tut das auch, aber wir wollen
      // synchron den frischen Hash haben, um sofort zu trusten.
      await store.reload();
      const fresh = store.get(args.name);
      if (fresh) {
        getTrust().trust(args.name, fresh.hash, fresh.allowedTools);
        await store.reload();
      }

      return {
        ok: true,
        name: args.name,
        path: saveResult.path,
        updated: isUpdate,
      };
    },
    preview: (r) =>
      r.ok
        ? r.updated
          ? `Skill ersetzt: ${r.name}`
          : `Skill angelegt: ${r.name}`
        : r.cancelled
          ? "Skill-Anlage abgebrochen"
          : `Skill-Fehler`,
  });

  // -------- skill_delete ----------------------------------------------------

  const del = defineTool({
    name: "skill_delete",
    description:
      "Delete a user-scope skill after explicit user confirmation. Workspace-scope skills cannot be deleted from here. Trust state is cleared along with the file.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Kebab-case name of the skill." },
      },
      required: ["name"],
    },
    schema: yup.object({
      name: yup.string().trim().required("name fehlt."),
    }),
    run: async (args, ctx) => {
      const store = ensureStore();
      const target = store.get(args.name);
      if (!target) {
        return { ok: false, error: `Skill '${args.name}' nicht gefunden.` };
      }
      if (target.scope === "workspace") {
        return {
          ok: false,
          error:
            "Workspace-Skills liegen im Projekt-Repo und können nicht durch AVA gelöscht werden.",
        };
      }

      const choice = await ctx.ui.askChoice(
        `Soll ich den Skill **${args.name}** wirklich löschen?\n\n${target.description}`,
        [
          { value: "yes", label: "Ja, löschen" },
          { value: "no", label: "Nein, behalten" },
        ],
        ctx.signal,
      );
      if (choice !== "yes") {
        return { ok: false, cancelled: true, error: "Vom Nutzer abgelehnt." };
      }

      const skillDir = safeUnderUserDir(args.name);
      try {
        if (existsSync(skillDir)) {
          rmSync(skillDir, { recursive: true, force: true });
        }
        getTrust().revoke(args.name);
        await store.reload();
        return { ok: true, name: args.name };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    preview: (r) =>
      r.ok
        ? `Skill gelöscht: ${r.name}`
        : r.cancelled
          ? "Löschung abgebrochen"
          : `Skill-Fehler`,
  });

  return [list, get, search, create, del];
}
