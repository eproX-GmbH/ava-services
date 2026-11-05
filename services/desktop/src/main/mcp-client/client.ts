// Verbindung zu einem MCP-Dienst (docs/PLAN_CLOSE_MCP.md, C2): Streamable HTTP
// zuerst, SSE als Rueckfall fuer aeltere Dienste. Zugang ueber Kopfzeilen
// (Bearer oder beliebige Kopfzeilen), die der Nutzer in den Einstellungen
// hinterlegt hat. OAuth mit dynamischer Registrierung folgt (C6/C3).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { McpDienst, McpGeheimnisse } from "./store";

export interface McpWerkzeugBeschreibung {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; title?: string };
}

export interface McpAufrufErgebnis {
  text: string;
  strukturiert: unknown;
  istFehler: boolean;
}

const VERBINDUNGS_ZEITLIMIT_MS = 20_000;
const AUFRUF_ZEITLIMIT_MS = 120_000;

export function kopfzeilenAus(dienst: McpDienst, g: McpGeheimnisse): Record<string, string> {
  const h: Record<string, string> = {};
  if (dienst.zugang === "zugangscode" && g.zugangscode) h["authorization"] = `Bearer ${g.zugangscode}`;
  if (dienst.zugang === "kopfzeilen" && g.kopfzeilen) for (const [k, v] of Object.entries(g.kopfzeilen)) if (k && v) h[k] = v;
  return h;
}

export class McpVerbindung {
  private client: Client | null = null;
  private transportArt: "http" | "sse" | null = null;

  constructor(private readonly dienst: McpDienst, private readonly geheimnisse: McpGeheimnisse) {}

  get art(): "http" | "sse" | null {
    return this.transportArt;
  }

  async verbinden(): Promise<void> {
    const url = new URL(this.dienst.url);
    const headers = kopfzeilenAus(this.dienst, this.geheimnisse);
    const requestInit: RequestInit = { headers };
    const versuche: Array<{ art: "http" | "sse"; baue: () => StreamableHTTPClientTransport | SSEClientTransport }> = [
      { art: "http", baue: () => new StreamableHTTPClientTransport(url, { requestInit }) },
      { art: "sse", baue: () => new SSEClientTransport(url, { requestInit, eventSourceInit: { fetch: (u, init) => fetch(u, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }) } }) },
    ];
    let letzterFehler: unknown = null;
    for (const v of versuche) {
      const client = new Client({ name: "ava-desktop", version: "1.0.0" }, { capabilities: {} });
      const transport = v.baue();
      try {
        await mitZeitlimit(client.connect(transport), VERBINDUNGS_ZEITLIMIT_MS, "Verbindung");
        this.client = client;
        this.transportArt = v.art;
        return;
      } catch (err) {
        letzterFehler = err;
        await client.close().catch(() => undefined);
      }
    }
    throw new Error(fehlerText(letzterFehler));
  }

  async werkzeuge(): Promise<McpWerkzeugBeschreibung[]> {
    const c = this.mussVerbunden();
    const alle: McpWerkzeugBeschreibung[] = [];
    let cursor: string | undefined;
    do {
      const r = await mitZeitlimit(c.listTools(cursor ? { cursor } : undefined), VERBINDUNGS_ZEITLIMIT_MS, "Werkzeugliste");
      for (const t of r.tools) {
        alle.push({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          annotations: t.annotations as McpWerkzeugBeschreibung["annotations"],
        });
      }
      cursor = r.nextCursor;
    } while (cursor && alle.length < 500);
    return alle;
  }

  async aufrufen(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpAufrufErgebnis> {
    const c = this.mussVerbunden();
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: AUFRUF_ZEITLIMIT_MS, ...(signal ? { signal } : {}) });
    const content = (r.content as Array<{ type: string; text?: string; mimeType?: string }> | undefined) ?? [];
    const texte: string[] = [];
    for (const teil of content) {
      if (teil.type === "text" && typeof teil.text === "string") texte.push(teil.text);
      else if (teil.type === "image") texte.push(`[Bild ${teil.mimeType ?? ""} ausgelassen]`);
      else if (teil.type === "resource") texte.push("[Ressource ausgelassen]");
    }
    return { text: texte.join("\n"), strukturiert: (r as { structuredContent?: unknown }).structuredContent ?? null, istFehler: Boolean((r as { isError?: boolean }).isError) };
  }

  async schliessen(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transportArt = null;
    if (c) await c.close().catch(() => undefined);
  }

  private mussVerbunden(): Client {
    if (!this.client) throw new Error(`${this.dienst.name} ist nicht verbunden.`);
    return this.client;
  }
}

async function mitZeitlimit<T>(p: Promise<T>, ms: number, was: string): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  const limit = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${was}: Zeitüberschreitung nach ${Math.round(ms / 1000)} s`)), ms);
  });
  try {
    return await Promise.race([p, limit]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export function fehlerText(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  if (/401|unauthori/i.test(m)) return "Der Dienst lehnt den Zugang ab (401). Zugangscode oder Kopfzeilen prüfen.";
  if (/403|forbidden/i.test(m)) return "Der Dienst verweigert den Zugriff (403). Rechte oder Bereich des Zugangs prüfen.";
  if (/404/.test(m)) return "Unter dieser Adresse antwortet kein Dienst (404). Adresse prüfen.";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(m)) return "Der Dienst ist nicht erreichbar. Adresse und Internetverbindung prüfen.";
  return m.slice(0, 300);
}
