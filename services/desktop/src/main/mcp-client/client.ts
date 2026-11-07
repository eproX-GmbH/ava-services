// Verbindung zu einem MCP-Dienst (docs/PLAN_CLOSE_MCP.md, C2): Streamable HTTP
// zuerst, SSE als Rueckfall fuer aeltere Dienste. Zugang ueber Kopfzeilen
// (Bearer oder beliebige Kopfzeilen), die der Nutzer in den Einstellungen
// hinterlegt hat. OAuth mit dynamischer Registrierung folgt (C6/C3).

import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import * as yup from "yup";
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

/**
 * Kopfzeilen fuer den Zugang. Bei "client" (OAuth 2.0 Client Credentials) wird
 * ein Token geholt und bis kurz vor Ablauf wiederverwendet; deshalb asynchron
 * und je Anfrage aufgerufen (siehe fetch-Huelle in verbinden()).
 */
export async function zugangsKopfzeilen(dienst: McpDienst, g: McpGeheimnisse): Promise<Record<string, string>> {
  const h: Record<string, string> = {};
  if (dienst.zugang === "zugangscode" && g.zugangscode) h["authorization"] = `Bearer ${g.zugangscode}`;
  if (dienst.zugang === "kopfzeilen" && g.kopfzeilen) for (const [k, v] of Object.entries(g.kopfzeilen)) if (k && v) h[k] = v;
  if (dienst.zugang === "anmeldung" && g.benutzer && g.passwort) h["authorization"] = `Basic ${Buffer.from(`${g.benutzer}:${g.passwort}`, "utf8").toString("base64")}`;
  if (dienst.zugang === "client") h["authorization"] = `Bearer ${await clientToken(dienst, g)}`;
  return h;
}

const tokenCache = new Map<string, { token: string; bis: number }>();

/** OAuth 2.0 Client Credentials (RFC 6749 4.4): erst client_secret_post, bei 400/401 client_secret_basic. */
async function clientToken(dienst: McpDienst, g: McpGeheimnisse): Promise<string> {
  // Neues Secret oder andere Adresse (Zugang erneuert) = neuer Eintrag im Cache.
  const schluessel = `${dienst.id}:${g.clientId ?? ""}:${dienst.tokenAdresse ?? ""}:${dienst.scope ?? ""}:${createHash("sha256").update(g.clientSecret ?? "").digest("hex").slice(0, 16)}`;
  const c = tokenCache.get(schluessel);
  if (c && c.bis > Date.now() + 60_000) return c.token;
  if (!dienst.tokenAdresse || !g.clientId || !g.clientSecret) throw new Error("Zugang unvollständig: Adresse für die Anmeldung, Client-ID oder Client-Secret fehlt.");
  const basis = new URLSearchParams({ grant_type: "client_credentials", ...(dienst.scope ? { scope: dienst.scope } : {}) });
  const versuche: Array<{ body: URLSearchParams; headers: Record<string, string> }> = [
    { body: new URLSearchParams({ ...Object.fromEntries(basis), client_id: g.clientId, client_secret: g.clientSecret }), headers: {} },
    { body: basis, headers: { authorization: `Basic ${Buffer.from(`${encodeURIComponent(g.clientId)}:${encodeURIComponent(g.clientSecret)}`).toString("base64")}` } },
  ];
  let letzter = "";
  for (const v of versuche) {
    const r = await fetch(dienst.tokenAdresse, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...v.headers },
      body: v.body.toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (r.ok) {
      const j = tokenAntwort.validateSync(await r.json());
      tokenCache.set(schluessel, { token: j.access_token, bis: Date.now() + (j.expires_in ?? 3600) * 1000 });
      return j.access_token;
    }
    letzter = `${r.status}`;
    if (r.status !== 400 && r.status !== 401) break;
  }
  throw new Error(`Anmeldung beim Dienst abgelehnt (${letzter}). Zugang abgelaufen oder ungültig: Client-ID, Client-Secret oder Scopes prüfen.`);
}

const tokenAntwort = yup.object({ access_token: yup.string().min(8).required(), expires_in: yup.number().positive().optional() });

export class McpVerbindung {
  private client: Client | null = null;
  private transportArt: "http" | "sse" | null = null;

  constructor(private readonly dienst: McpDienst, private readonly geheimnisse: McpGeheimnisse) {}

  get art(): "http" | "sse" | null {
    return this.transportArt;
  }

  async verbinden(): Promise<void> {
    const url = new URL(this.dienst.url);
    // Zugang je Anfrage frisch: Client-Credentials-Token laufen ab, die Huelle holt sie neu.
    const mitZugang = async (u: string | URL, init?: RequestInit): Promise<Response> => {
      const zugang = await zugangsKopfzeilen(this.dienst, this.geheimnisse);
      const h = new Headers(init?.headers);
      for (const [k, v] of Object.entries(zugang)) h.set(k, v);
      return fetch(u, { ...init, headers: h });
    };
    const versuche: Array<{ art: "http" | "sse"; baue: () => StreamableHTTPClientTransport | SSEClientTransport }> = [
      { art: "http", baue: () => new StreamableHTTPClientTransport(url, { fetch: mitZugang }) },
      { art: "sse", baue: () => new SSEClientTransport(url, { fetch: mitZugang, eventSourceInit: { fetch: mitZugang } }) },
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
