// Verbundene Dienste (docs/PLAN_CLOSE_MCP.md, C2): Ablage der Dienste, die ihre
// Werkzeuge ueber MCP anbieten. Metadaten liegen lesbar in einer Datei je
// Konto, Zugangsdaten (Zugangscode, Kopfzeilen) verschluesselt ueber den
// Schluesselbund des Rechners — wie bei den CRM-Token.

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { credentials, paths } from "../../core/platform";

export type McpZugangArt = "keine" | "zugangscode" | "kopfzeilen";
/** Werkzeugdienst (MCP) oder Agent (A2A). */
export type DienstArt = "mcp" | "a2a";

export interface McpDienst {
  id: string;
  /** Fehlt bei Eintraegen vor dem A2A-Ausbau: dann MCP. */
  art?: DienstArt;
  /** Anzeigename, vom Nutzer vergeben ("Close", "CompLeadly"). */
  name: string;
  /** Kurzname fuer Werkzeugnamen: `mcp_<slug>_<werkzeug>`. */
  slug: string;
  url: string;
  zugang: McpZugangArt;
  /** Nur die Namen der Kopfzeilen (Werte verschluesselt). */
  kopfzeilenNamen: string[];
  erstelltAm: string;
  zuletztVerbunden: string | null;
  werkzeuge: number;
  fehler: string | null;
}

export interface McpGeheimnisse {
  zugangscode?: string;
  kopfzeilen?: Record<string, string>;
}

interface Eintrag extends McpDienst {
  geheimnisse?: string;
}

interface Datei {
  dienste: Eintrag[];
}

function datei(): string {
  return join(paths().get("userData"), "mcp-dienste.json");
}

async function lese(): Promise<Datei> {
  const p = datei();
  if (!existsSync(p)) return { dienste: [] };
  try {
    const raw = JSON.parse(await fs.readFile(p, "utf8")) as Datei;
    return { dienste: Array.isArray(raw.dienste) ? raw.dienste : [] };
  } catch {
    return { dienste: [] };
  }
}

async function schreibe(d: Datei): Promise<void> {
  await fs.writeFile(datei(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

function entschluessele(e: Eintrag): McpGeheimnisse {
  if (!e.geheimnisse) return {};
  try {
    if (!credentials().isEncryptionAvailable()) return {};
    return JSON.parse(credentials().decryptString(Buffer.from(e.geheimnisse, "base64"))) as McpGeheimnisse;
  } catch {
    return {};
  }
}

function verschluessele(g: McpGeheimnisse): string | undefined {
  const leer = !g.zugangscode && (!g.kopfzeilen || Object.keys(g.kopfzeilen).length === 0);
  if (leer) return undefined;
  if (!credentials().isEncryptionAvailable()) throw new Error("Der Schlüsselbund dieses Rechners ist nicht verfügbar; Zugangsdaten lassen sich nicht sicher speichern.");
  return credentials().encryptString(JSON.stringify(g)).toString("base64");
}

export function neueId(): string {
  return "md_" + randomBytes(6).toString("hex");
}

/** Kurzname aus dem Anzeigenamen: nur a-z0-9, hoechstens 12 Zeichen, eindeutig. */
export function slugAus(name: string, vergeben: Set<string>): string {
  const basis = name
    .toLowerCase()
    .replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue").replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12) || "dienst";
  let s = basis;
  let n = 2;
  while (vergeben.has(s)) s = `${basis.slice(0, 10)}${n++}`;
  return s;
}

export async function ladeDienste(): Promise<Array<{ dienst: McpDienst; geheimnisse: McpGeheimnisse }>> {
  const d = await lese();
  return d.dienste.map((e) => {
    const { geheimnisse: _g, ...dienst } = e;
    return { dienst, geheimnisse: entschluessele(e) };
  });
}

export async function speichereDienst(dienst: McpDienst, geheimnisse?: McpGeheimnisse): Promise<void> {
  const d = await lese();
  const i = d.dienste.findIndex((e) => e.id === dienst.id);
  const alt = i >= 0 ? d.dienste[i]! : null;
  const eintrag: Eintrag = { ...dienst, geheimnisse: geheimnisse ? verschluessele(geheimnisse) : alt?.geheimnisse };
  if (i >= 0) d.dienste[i] = eintrag;
  else d.dienste.push(eintrag);
  await schreibe(d);
}

export async function entferneDienst(id: string): Promise<void> {
  const d = await lese();
  d.dienste = d.dienste.filter((e) => e.id !== id);
  await schreibe(d);
}
