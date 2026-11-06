// Werkzeug-Rollen fuer Vorlagen (docs/PLAN_CLOSE_MCP.md, C5): Vorlagen, die
// Werkzeuge verbundener Dienste nutzen (Close, CompLeadly), kennen deren genaue
// Namen und Felder nicht — die stehen erst fest, wenn der Nutzer den Dienst
// verbunden hat. Eine Rolle beschreibt, welcher Dienst und welche Art Werkzeug
// gemeint ist; beim Anlegen wird sie gegen die tatsaechlich registrierten
// mcp_<dienst>_<werkzeug> aufgeloest. Semantische Argumente ("@leadId",
// "@text") werden auf die Feldnamen im Schema des Werkzeugs abgebildet.

import type { Tool } from "../agent/types";

export interface WerkzeugRolle {
  /** Anzeigename des Dienstes ("Close", "CompLeadly"). */
  dienstName: string;
  /** Muster auf den Kurznamen des Dienstes (slug aus den Einstellungen). */
  dienst: RegExp;
  /** Bevorzugte Original-Werkzeugnamen in Reihenfolge (exakt, ohne Praefix). */
  namen?: string[];
  /** Rueckfall-Muster auf den Original-Werkzeugnamen. */
  muster?: RegExp;
  /** Wofuer die Rolle steht (Anzeige, Rueckfrage). */
  zweck: string;
}

/** Semantische Felder → moegliche Feldnamen im Schema des Dienstes. */
const SYNONYME: Record<string, string[]> = {
  leadId: ["lead_id", "leadId", "lead", "leadID"],
  text: ["note", "text", "body", "content", "description", "message", "note_text"],
  linkedinUrl: ["linkedin_url", "linkedinUrl", "linkedInUrl", "profile_url", "profileUrl", "linkedin", "profile", "url"],
  name: ["name", "full_name", "fullName", "display_name"],
  vorname: ["first_name", "firstName", "vorname"],
  nachname: ["last_name", "lastName", "nachname"],
  firma: ["company", "company_name", "companyName", "organization"],
  position: ["position", "job_title", "jobTitle", "title", "headline"],
  zielgruppe: ["searchListName", "search_list_name", "target_audience", "targetAudience", "audience", "list_name", "listName", "list"],
  email: ["email", "email_address", "emailAddress"],
};

export interface AufgeloesteRolle {
  rolle: string;
  tool: string | null;
  kandidaten: Array<{ name: string; summary: string }>;
}

function slugAus(tool: Tool): string | null {
  const m = /^mcp:(.+)$/.exec(tool.category ?? "");
  return m ? m[1]! : null;
}

function originalName(tool: Tool, slug: string): string {
  return tool.name.startsWith(`mcp_${slug}_`) ? tool.name.slice(`mcp_${slug}_`.length) : tool.name;
}

/** Rolle gegen die registrierten Werkzeuge aufloesen (oder die vom Nutzer gewaehlte Vorgabe pruefen). */
export function rolleAufloesen(rolle: string, def: WerkzeugRolle, tools: Tool[], vorgabe?: string): AufgeloesteRolle {
  const desDienstes = tools.filter((t) => {
    const slug = slugAus(t);
    return slug !== null && def.dienst.test(slug);
  });
  const kandidaten = desDienstes.map((t) => ({ name: t.name, summary: t.summary ?? t.description.slice(0, 140) }));
  if (vorgabe) return { rolle, tool: desDienstes.some((t) => t.name === vorgabe) ? vorgabe : null, kandidaten };
  for (const n of def.namen ?? []) {
    const treffer = desDienstes.find((t) => originalName(t, slugAus(t)!).toLowerCase() === n.toLowerCase());
    if (treffer) return { rolle, tool: treffer.name, kandidaten };
  }
  if (def.muster) {
    const treffer = desDienstes.find((t) => def.muster!.test(originalName(t, slugAus(t)!)));
    if (treffer) return { rolle, tool: treffer.name, kandidaten };
  }
  return { rolle, tool: null, kandidaten };
}

/**
 * Semantische Argumente ("@leadId": "{{ … }}") auf die Felder des Werkzeugs
 * abbilden. Unbekannte semantische Felder fallen weg; normale Argumente bleiben.
 * Liefert zusaetzlich Pflichtfelder des Werkzeugs, die nicht belegt sind.
 */
export function argumenteAbbilden(args: Record<string, unknown>, tool: Tool): { args: Record<string, unknown>; offenePflichtfelder: string[] } {
  const schema = (tool.parameters ?? {}) as { properties?: Record<string, unknown>; required?: string[] };
  const felder = Object.keys(schema.properties ?? {});
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!k.startsWith("@")) {
      out[k] = v;
      continue;
    }
    const sem = k.slice(1);
    const moegliche = SYNONYME[sem] ?? [sem];
    const feld = moegliche.find((m) => felder.includes(m)) ?? moegliche.map((m) => felder.find((f) => f.toLowerCase() === m.toLowerCase())).find(Boolean);
    if (feld && !(feld in out)) out[feld] = v;
  }
  const offenePflichtfelder = (schema.required ?? []).filter((r) => !(r in out));
  return { args: out, offenePflichtfelder };
}
