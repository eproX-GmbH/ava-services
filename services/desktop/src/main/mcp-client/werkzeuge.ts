// Werkzeuge eines verbundenen Dienstes als AVA-Werkzeuge (docs/PLAN_CLOSE_MCP.md,
// C2): Name `mcp_<dienst>_<werkzeug>`, Schema 1:1 vom Dienst, Kurzbeschreibung
// fuer tool_search, Kategorie `mcp`. Schreibende Werkzeuge (keine
// readOnlyHint-Annotation) laufen durch dieselbe Bestaetigung wie unsere
// eigenen Schreibwerkzeuge; destruktive nie ohne Nachfrage.

import { createHash } from "node:crypto";
import type { Tool } from "../agent/types";
import type { ActionKind } from "../agent/ui-bridge";
import { userDeclined } from "../agent/define-tool";
import type { McpWerkzeugBeschreibung } from "./client";
import type { McpDienst } from "./store";

const MAX_NAME = 64;

export function werkzeugName(slug: string, original: string): string {
  const rein = original.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase() || "werkzeug";
  const name = `mcp_${slug}_${rein}`;
  if (name.length <= MAX_NAME) return name;
  const hash = createHash("sha1").update(original).digest("hex").slice(0, 6);
  return `${name.slice(0, MAX_NAME - 7)}_${hash}`;
}

const LESEND_RE = /(^|_)(get|list|read|search|find|fetch|query|describe|show|lookup|count|check|stat|ask|view|export)(_|$)|^(get|list|read|search|find|fetch|query|describe|show|lookup|count|check|ask|view)[A-Z]/;
const LOESCHEND_RE = /(^|_)(delete|remove|destroy|purge|revoke|clear|drop)(_|$)|^(delete|remove|destroy|purge|revoke|clear|drop)[A-Z]/;

export function wirkungsklasse(w: McpWerkzeugBeschreibung): ActionKind | "read" {
  const a = w.annotations ?? {};
  if (a.readOnlyHint === true) return "read";
  if (a.readOnlyHint === false) return a.destructiveHint === true ? "destructive" : "mutating";
  // Ohne Annotationen (haeufig, z. B. DeepWiki, viele kleine Dienste): Name
  // entscheidet wie bei unseren eigenen Werkzeugen im Workflow-Katalog, damit
  // nicht jede Suche eine Rueckfrage ausloest. Unklar = schreibend.
  if (LOESCHEND_RE.test(w.name)) return "destructive";
  if (LESEND_RE.test(w.name)) return "read";
  return "mutating";
}

function kurz(text: string | undefined, max: number): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export interface WerkzeugBau {
  tool: Tool;
  klasse: ActionKind | "read";
}

export function baueWerkzeuge(
  dienst: McpDienst,
  beschreibungen: McpWerkzeugBeschreibung[],
  aufrufen: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<{ text: string; strukturiert: unknown; istFehler: boolean }>,
): WerkzeugBau[] {
  const vergeben = new Set<string>();
  const out: WerkzeugBau[] = [];
  for (const w of beschreibungen) {
    let name = werkzeugName(dienst.slug, w.name);
    if (vergeben.has(name)) name = werkzeugName(dienst.slug, `${w.name}_${vergeben.size}`);
    vergeben.add(name);
    const klasse = wirkungsklasse(w);
    const titel = w.title ?? w.annotations?.title ?? w.name;
    const parameters = w.inputSchema && typeof w.inputSchema === "object" ? w.inputSchema : { type: "object", properties: {} };
    const description =
      `[${dienst.name}] ${kurz(w.description, 900) || titel}` +
      (klasse === "read" ? "" : ` — schreibendes Werkzeug des Dienstes ${dienst.name}; AVA fragt vor dem Ausführen nach.`);
    const tool: Tool<Record<string, unknown>, { dienst: string; werkzeug: string; text: string; strukturiert: unknown }> = {
      name,
      summary: `${dienst.name}: ${kurz(w.description, 110) || titel}`,
      category: `mcp:${dienst.slug}`,
      description,
      parameters,
      parseArgs: (raw: unknown) => {
        if (raw == null) return {};
        if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("Argumente müssen ein Objekt sein.");
        return raw as Record<string, unknown>;
      },
      run: async (args, ctx) => {
        if (klasse !== "read") {
          const value = await ctx.ui.confirmAction(
            {
              kind: klasse,
              prompt: `Soll ich im Dienst ${dienst.name} das Werkzeug „${titel}“ ausführen?\n\n${JSON.stringify(args, null, 2).slice(0, 1200)}`,
              confirmValue: "ja",
              options: [
                { value: "ja", label: "Ausführen", description: `Aufruf geht an ${dienst.name}` },
                { value: "nein", label: "Abbrechen" },
              ],
            },
            ctx.signal,
          );
          if (value !== "ja") return userDeclined(`${dienst.name}: ${titel}`) as unknown as { dienst: string; werkzeug: string; text: string; strukturiert: unknown };
        }
        const r = await aufrufen(w.name, args, ctx.signal);
        if (r.istFehler) throw new Error(`${dienst.name} meldet einen Fehler: ${r.text.slice(0, 500) || "ohne Text"}`);
        return { dienst: dienst.name, werkzeug: w.name, text: r.text.slice(0, 60_000), strukturiert: r.strukturiert };
      },
      preview: (r) => `${r.dienst} · ${r.werkzeug}: ${kurz(r.text, 120) || "ohne Text"}`,
    };
    out.push({ tool: tool as unknown as Tool, klasse });
  }
  return out;
}
