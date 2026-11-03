// A2A-Endpunkt (docs/PLAN_MCP_OEFFNUNG.md §14): Agent2Agent-Protokoll als zweite
// Fassade ueber dieselben Werkzeuge wie /mcp.
//
//   GET  /.well-known/agent-card.json   Agentenkarte (oeffentlich; auch agent.json)
//   POST /a2a                           JSON-RPC: message/send, message/stream (SSE),
//                                       tasks/get, tasks/cancel,
//                                       tasks/pushNotificationConfig/set|get
//
// Auth wie /mcp (Bearer aus Keycloak, OAuth-Discovery der MCP-Metadata). Org-
// Schalter `mcp` + `mcp.a2a` (Standard aus); die Skill-Menge folgt den MCP-
// Schaltern (lesen, auftraege, kontakte, copilot). Lesende Skills antworten
// sofort als abgeschlossener Task; auftragsartige Skills legen eine Transaktion
// an und bleiben `working`, der Takt in lib/a2a-tasks.ts schliesst sie ab und
// benachrichtigt die Webhook-Adresse des Agenten. Freier Text ohne Skill geht
// an die laufende AVA des Nutzers (ava_fragen ueber das Kopf-Relais), sonst an
// firma_suchen.

import { Hono } from "hono";
import type { Context } from "hono";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { loadEnv } from "../lib/env";
import { logger } from "../lib/logger";
import { kopfRelais } from "../lib/kopf-relais";
import { getGatewayPool } from "../lib/producer-pools";
import { mcpBasis, istMcpHost } from "./mcp-oauth";
import { TOOLS, fuehreAus, kopfWerkzeuge, mcpAuth, schalterFuer, sichtbareTools, type McpSchalter, type ToolDef } from "./mcp";
import { KONTEXT_WERKZEUG, avaKontext } from "../lib/mcp-kontext";
import {
  agentNachricht,
  alsTask,
  istTerminal,
  pushKonfigSetzen,
  pushUrlErlaubt,
  taskAnlegen,
  taskLesen,
  taskPruefen,
  taskZustand,
  type A2aArtifact,
  type A2aMessage,
  type A2aPart,
  type TaskZeile,
} from "../lib/a2a-tasks";

const PROTOKOLL_VERSION = "0.3.0";
const AGENT_VERSION = "1.0.0";
const AUFTRAG_SKILLS = new Set(["import_anlegen", "recherche_anstossen", "neu_verarbeiten"]);
const FRAGEN_SKILL = "ava_fragen";
const MAX_EINGABE = 200_000;

type JsonRpcId = string | number | null;

// A2A-Fehlercodes (Spezifikation 0.3)
const FEHLER = {
  parse: -32700,
  anfrage: -32600,
  methode: -32601,
  params: -32602,
  intern: -32603,
  taskNichtGefunden: -32001,
  nichtAbbrechbar: -32002,
  pushNichtUnterstuetzt: -32003,
  nichtUnterstuetzt: -32004,
  inhalt: -32005,
} as const;

class RpcFehler extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

function a2aPfad(hostHeader: string | undefined): { base: string; pfad: string } {
  const b = mcpBasis(hostHeader);
  return { base: b.base, pfad: "/a2a" };
}

// ---- Agentenkarte ------------------------------------------------------------

function skillAusTool(t: ToolDef): Record<string, unknown> {
  return {
    id: t.name,
    name: t.name.replace(/_/g, " "),
    description: t.description.length > 1200 ? `${t.description.slice(0, 1200)}…` : t.description,
    tags: ["ava", t.schalter === "auftraege" ? "auftrag" : "lesen"],
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json", "text/plain"],
    examples: [`{"skill": "${t.name}", "args": {}}`],
  };
}

function agentenkarte(hostHeader: string | undefined): Record<string, unknown> {
  const env = loadEnv();
  const { base, pfad } = a2aPfad(hostHeader);
  const realm = (env.KEYCLOAK_REALM_URL ?? "").replace(/\/+$/, "");
  const skills = [
    {
      id: FRAGEN_SKILL,
      name: "AVA fragen",
      description:
        "Freie Frage oder Aufgabe in natürlicher Sprache an die AVA des Nutzers (läuft auf dessen Gerät oder Server mit dessen eigenem Modell). Nur verfügbar, wenn diese AVA gerade verbunden ist; sonst antwortet der Task mit einem Hinweis.",
      tags: ["ava", "chat"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      examples: ["Welche Firmen aus meiner Liste hatten diese Woche einen Geschäftsführerwechsel?"],
    },
    ...TOOLS.filter((t) => t.name !== KONTEXT_WERKZEUG).map(skillAusTool),
    {
      id: KONTEXT_WERKZEUG,
      name: "AVA Kontext",
      description: "Was AVA ist, was der Nutzer eingerichtet hat und welche Skills gerade freigeschaltet sind. Zu Beginn einmal abrufen.",
      tags: ["ava", "kontext"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      examples: ['{"skill": "ava_kontext"}'],
    },
  ];
  return {
    name: "AVA",
    description:
      "AVA liefert Firmenwissen aus Handelsregistern, Websites, Publikationen und LinkedIn: Firmen suchen und lesen, Ansprechpartner, Meldungen (Geschäftsführerwechsel, Insolvenzen, Stellen), Firmen aufnehmen und recherchieren lassen. Skills werden als Datenteil {\"skill\": \"<id>\", \"args\": {…}} oder als Text \"<id> {…}\" angesprochen; freier Text geht an die AVA des Nutzers. Lang laufende Aufträge melden sich über die Push-Adresse des Agenten, sobald sie fertig sind.",
    url: `${base}${pfad}`,
    provider: { organization: "eproX GmbH", url: "https://ava.bi" },
    version: AGENT_VERSION,
    protocolVersion: PROTOKOLL_VERSION,
    documentationUrl: "https://ava.bi",
    preferredTransport: "JSONRPC",
    capabilities: { streaming: true, pushNotifications: true, stateTransitionHistory: false },
    securitySchemes: realm
      ? {
          oauth2: {
            type: "oauth2",
            description: "OAuth 2.0 (PKCE) über den AVA-Anmeldedienst; Registrierung dynamisch über die MCP-OAuth-Metadata derselben Adresse.",
            flows: {
              authorizationCode: {
                authorizationUrl: `${realm}/protocol/openid-connect/auth`,
                tokenUrl: `${realm}/protocol/openid-connect/token`,
                scopes: { openid: "Anmeldung als AVA-Nutzer", offline_access: "Dauerhafte Verbindung" },
              },
            },
          },
          bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Zugriffstoken des AVA-Nutzers (Keycloak)." },
        }
      : { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
    security: realm ? [{ oauth2: ["openid"] }, { bearer: [] }] : [{ bearer: [] }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills,
  };
}

// ---- Nachricht → Skill ---------------------------------------------------------

interface Absicht {
  skill: string;
  args: Record<string, unknown>;
  freitext: string;
}

function textAus(parts: A2aPart[]): string {
  return parts
    .filter((p) => p.kind === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

function absichtErmitteln(m: A2aMessage, bekannt: Set<string>): Absicht {
  const freitext = textAus(m.parts);
  const metaSkill = typeof m.metadata?.skill === "string" ? m.metadata.skill : null;
  // 1) Datenteil {skill, args} oder {skill, ...args}
  for (const p of m.parts) {
    if (p.kind !== "data" || !p.data || typeof p.data !== "object") continue;
    const d = p.data as Record<string, unknown>;
    const skill = typeof d.skill === "string" ? d.skill : metaSkill;
    if (skill && bekannt.has(skill)) {
      const args = d.args && typeof d.args === "object" ? (d.args as Record<string, unknown>) : Object.fromEntries(Object.entries(d).filter(([k]) => k !== "skill"));
      return { skill, args, freitext };
    }
  }
  // 2) metadata.skill mit Argumenten aus metadata.args
  if (metaSkill && bekannt.has(metaSkill)) {
    const args = m.metadata?.args && typeof m.metadata.args === "object" ? (m.metadata.args as Record<string, unknown>) : {};
    return { skill: metaSkill, args, freitext };
  }
  // 3) Text "<skill> {json}" oder "<skill>"
  const mt = /^\s*([a-z_]+)\s*(\{[\s\S]*\})?\s*$/i.exec(freitext);
  if (mt && bekannt.has(mt[1]!.toLowerCase())) {
    let args: Record<string, unknown> = {};
    if (mt[2]) {
      try {
        args = JSON.parse(mt[2]) as Record<string, unknown>;
      } catch {
        throw new RpcFehler(FEHLER.params, `Argumente fuer ${mt[1]} sind kein gueltiges JSON.`);
      }
    }
    return { skill: mt[1]!.toLowerCase(), args, freitext };
  }
  // 4) Freier Text: AVA fragen (wenn verbunden) – die Entscheidung trifft der Aufrufer.
  return { skill: "", args: {}, freitext };
}

function artefaktAus(text: string): A2aArtifact {
  const parts: A2aPart[] = [{ kind: "text", text }];
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object") parts.push({ kind: "data", data: j });
  } catch {
    /* kein JSON */
  }
  return { artifactId: randomUUID(), name: "ergebnis", parts };
}

/** transactionId(s) aus dem Werkzeug-Ergebnis (Import, Recherche, Neuverarbeitung). */
function transaktionAus(text: string): string | null {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.transactionId === "string") return j.transactionId;
    const v = Array.isArray(j.vorgaenge) ? j.vorgaenge : [];
    for (const e of v) {
      const o = e as Record<string, unknown>;
      if (typeof o.transactionId === "string") return o.transactionId;
      if (typeof o.id === "string") return o.id;
    }
  } catch {
    /* kein JSON */
  }
  return null;
}

// ---- Ausfuehrung -----------------------------------------------------------------

interface Umfeld {
  app: OpenAPIHono;
  token: string;
  actorId: string;
  tenantId: string;
  schalter: McpSchalter;
  auth: Parameters<typeof avaKontext>[0];
}

function bekannteSkills(u: Umfeld): Set<string> {
  const s = new Set<string>(sichtbareTools(u.schalter).map((t) => t.name));
  s.add(KONTEXT_WERKZEUG);
  if (u.schalter.kopf && kopfWerkzeuge(u.actorId, u.schalter).some((w) => w.name === FRAGEN_SKILL)) s.add(FRAGEN_SKILL);
  return s;
}

/** Fuehrt die Absicht aus und bringt den Task in seinen (ersten) Endzustand. */
async function taskAusfuehren(u: Umfeld, z: TaskZeile, a: Absicht): Promise<TaskZeile> {
  const bekannt = bekannteSkills(u);
  let skill = a.skill;
  let args = a.args;
  if (!skill) {
    if (!a.freitext) {
      return (await taskZustand(getGatewayPool(), z.id, { zustand: "rejected", statusText: "Leere Nachricht: Skill als Datenteil {\"skill\": …} oder Text angeben." })) ?? z;
    }
    if (bekannt.has(FRAGEN_SKILL)) {
      skill = FRAGEN_SKILL;
      args = { frage: a.freitext };
    } else if (bekannt.has("firma_suchen")) {
      skill = "firma_suchen";
      args = { q: a.freitext.slice(0, 120), limit: 10 };
    } else {
      return (await taskZustand(getGatewayPool(), z.id, { zustand: "rejected", statusText: "Kein passender Skill freigeschaltet; die AVA des Nutzers ist nicht verbunden." })) ?? z;
    }
  }
  const pool = getGatewayPool();
  const start = Date.now();
  let erg: { text: string; isError?: boolean };
  try {
    if (skill === KONTEXT_WERKZEUG) erg = { text: await avaKontext(u.auth, u.schalter, 20_000) };
    else if (skill === FRAGEN_SKILL) erg = await kopfRelais.aufrufen(u.actorId, FRAGEN_SKILL, args);
    else erg = await fuehreAus(u.app, u.token, skill, args, "a2a");
  } catch (err) {
    erg = { text: err instanceof Error ? err.message : String(err), isError: true };
  }
  logger.info({ actorId: u.actorId, tenantId: u.tenantId, skill, ms: Date.now() - start, fehler: erg.isError === true, taskId: z.id }, "[a2a] skill");
  if (erg.isError) {
    return (await taskZustand(pool, z.id, { zustand: "failed", statusText: erg.text.slice(0, 2000), nachricht: agentNachricht(erg.text.slice(0, 2000), undefined, { taskId: z.id, contextId: z.contextId }) })) ?? z;
  }
  const artefakt = artefaktAus(erg.text);
  if (AUFTRAG_SKILLS.has(skill)) {
    const transactionId = transaktionAus(erg.text);
    const text = transactionId
      ? "Auftrag angenommen. Die Verarbeitung läuft, sobald die AVA des Nutzers läuft; der Task meldet sich über die Push-Adresse oder tasks/get."
      : "Angestoßen. Der Vorgang hängt an einer bestehenden Transaktion; Stand über auftrag_status.";
    const neu = await taskZustand(pool, z.id, {
      zustand: transactionId ? "working" : "completed",
      statusText: text,
      transactionId,
      ergebnis: [artefakt],
      nachricht: agentNachricht(text, undefined, { taskId: z.id, contextId: z.contextId }),
    });
    return neu ? await taskPruefen(pool, neu) : z;
  }
  return (await taskZustand(pool, z.id, { zustand: "completed", statusText: "Erledigt.", ergebnis: [artefakt], nachricht: agentNachricht(erg.text.slice(0, 4000), undefined, { taskId: z.id, contextId: z.contextId }) })) ?? z;
}

function nachrichtPruefen(roh: unknown): A2aMessage {
  if (!roh || typeof roh !== "object") throw new RpcFehler(FEHLER.params, "params.message fehlt.");
  const m = roh as Record<string, unknown>;
  const parts = Array.isArray(m.parts) ? (m.parts as A2aPart[]) : [];
  if (parts.length === 0) throw new RpcFehler(FEHLER.params, "message.parts fehlt.");
  for (const p of parts) {
    if (!p || typeof p !== "object") throw new RpcFehler(FEHLER.params, "Ungueltiger Teil in message.parts.");
    if (p.kind === "file") throw new RpcFehler(FEHLER.inhalt, "Dateien werden nicht entgegengenommen; Importe als Liste oder Base64 im Datenteil von import_anlegen.");
    if (p.kind !== "text" && p.kind !== "data") throw new RpcFehler(FEHLER.inhalt, `Unbekannte Teil-Art: ${String((p as { kind?: unknown }).kind)}`);
  }
  if (JSON.stringify(parts).length > MAX_EINGABE) throw new RpcFehler(FEHLER.params, "Nachricht zu gross.");
  return {
    kind: "message",
    role: "user",
    parts,
    messageId: typeof m.messageId === "string" && m.messageId ? m.messageId : randomUUID(),
    ...(typeof m.taskId === "string" ? { taskId: m.taskId } : {}),
    ...(typeof m.contextId === "string" ? { contextId: m.contextId } : {}),
    ...(m.metadata && typeof m.metadata === "object" ? { metadata: m.metadata as Record<string, unknown> } : {}),
  };
}

function pushAus(roh: unknown): { url: string; token?: string | null } | null {
  if (!roh || typeof roh !== "object") return null;
  const p = roh as Record<string, unknown>;
  const url = typeof p.url === "string" ? p.url.trim() : "";
  if (!url) throw new RpcFehler(FEHLER.params, "pushNotificationConfig.url fehlt.");
  if (!pushUrlErlaubt(url)) throw new RpcFehler(FEHLER.params, "pushNotificationConfig.url muss eine oeffentliche https-Adresse sein.");
  return { url, token: typeof p.token === "string" ? p.token.slice(0, 500) : null };
}

async function sendeNachricht(u: Umfeld, params: Record<string, unknown>): Promise<TaskZeile> {
  const nachricht = nachrichtPruefen(params.message);
  const konfig = (params.configuration ?? {}) as Record<string, unknown>;
  const push = pushAus(konfig.pushNotificationConfig);
  const pool = getGatewayPool();
  if (nachricht.taskId) {
    // Folge-Nachricht zu einem bestehenden Task: nur fuer offene Tasks sinnvoll; hier
    // gibt es keine Rueckfragen (input-required), also als neuer Task im selben Kontext.
    const alt = await taskLesen(pool, nachricht.taskId, u.actorId);
    if (!alt) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
    nachricht.contextId = alt.contextId;
  }
  const bekannt = bekannteSkills(u);
  const absicht = absichtErmitteln(nachricht, bekannt);
  const z = await taskAnlegen(pool, { tenantId: u.tenantId, actorId: u.actorId, skill: absicht.skill || (bekannt.has(FRAGEN_SKILL) ? FRAGEN_SKILL : "firma_suchen"), eingabe: nachricht, contextId: nachricht.contextId ?? null, push });
  return taskAusfuehren(u, z, absicht);
}

// ---- Router ------------------------------------------------------------------------

export function makeA2aRouter(app: OpenAPIHono): Hono {
  const r = new Hono();

  // Agentenkarte: oeffentlich, auf beiden Hosts (Fly-Host und mcp.ava.bi).
  const karte = (c: Context) => c.json(agentenkarte(c.req.header("host")));
  r.get("/.well-known/agent-card.json", karte);
  r.get("/.well-known/agent.json", karte);

  r.use("/a2a", mcpAuth);
  r.get("/a2a", (c) => c.json({ error: "method_not_allowed", message: "A2A-Endpunkt: JSON-RPC per POST; Agentenkarte unter /.well-known/agent-card.json." }, 405));
  r.post("/a2a", (c) => bearbeite(c));

  async function umfeld(c: Context): Promise<Umfeld> {
    const auth = c.get("auth");
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const schalter = await schalterFuer(auth.tenantId);
    return { app, token, actorId: auth.actorId, tenantId: auth.tenantId, schalter, auth };
  }

  async function bearbeite(c: Context) {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: FEHLER.parse, message: "Ungueltiges JSON" } }, 400);
    }
    const n = (payload ?? {}) as { id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
    const id = n.id ?? null;
    if (typeof n.method !== "string") return c.json({ jsonrpc: "2.0", id, error: { code: FEHLER.anfrage, message: "Ungueltige Anfrage" } }, 400);
    const u = await umfeld(c);
    const params = n.params ?? {};
    const antwort = (result: unknown) => c.json({ jsonrpc: "2.0", id, result });
    const fehler = (e: RpcFehler) => c.json({ jsonrpc: "2.0", id, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } });
    try {
      if (!u.schalter.aktiv || !u.schalter.a2a) {
        throw new RpcFehler(FEHLER.nichtUnterstuetzt, "Der A2A-Zugang ist fuer diese Organisation nicht freigeschaltet (Konsole → Organisation → MCP: A2A).");
      }
      const pool = getGatewayPool();
      switch (n.method) {
        case "message/send": {
          const z = await sendeNachricht(u, params);
          return antwort(alsTask(z));
        }
        case "message/stream": {
          // Kein echtes Zwischen-Streaming: die Antwort kommt als ein oder zwei
          // Ereignisse (Task, abschliessendes status-update) auf einem SSE-Strom.
          const z = await sendeNachricht(u, params);
          return streamSSE(c, async (stream) => {
            await stream.writeSSE({ data: JSON.stringify({ jsonrpc: "2.0", id, result: alsTask(z) }) });
            await stream.writeSSE({ data: JSON.stringify({ jsonrpc: "2.0", id, result: { kind: "status-update", taskId: z.id, contextId: z.contextId, status: alsTask(z).status, final: istTerminal(z.zustand) } }) });
          });
        }
        case "tasks/get": {
          const tid = String(params.id ?? "");
          const z = await taskLesen(pool, tid, u.actorId);
          if (!z) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
          const frisch = await taskPruefen(pool, z);
          const hl = typeof params.historyLength === "number" ? params.historyLength : undefined;
          return antwort(alsTask(frisch, hl));
        }
        case "tasks/cancel": {
          const tid = String(params.id ?? "");
          const z = await taskLesen(pool, tid, u.actorId);
          if (!z) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
          if (istTerminal(z.zustand)) throw new RpcFehler(FEHLER.nichtAbbrechbar, "Task ist bereits abgeschlossen.");
          // Die Transaktion selbst laeuft bei der AVA des Nutzers weiter; der Task
          // meldet sich nur nicht mehr.
          const neu = await taskZustand(pool, z.id, { zustand: "canceled", statusText: "Vom aufrufenden Agenten abgebrochen; eine angelegte Transaktion läuft bei AVA weiter." });
          return antwort(alsTask(neu ?? z));
        }
        case "tasks/pushNotificationConfig/set": {
          const tid = String(params.taskId ?? "");
          const push = pushAus(params.pushNotificationConfig);
          if (!push) throw new RpcFehler(FEHLER.params, "pushNotificationConfig fehlt.");
          const z = await pushKonfigSetzen(pool, tid, u.actorId, push);
          if (!z) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
          return antwort({ taskId: z.id, pushNotificationConfig: { url: z.pushUrl, ...(z.pushToken ? { token: z.pushToken } : {}) } });
        }
        case "tasks/pushNotificationConfig/get": {
          const tid = String(params.id ?? params.taskId ?? "");
          const z = await taskLesen(pool, tid, u.actorId);
          if (!z) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
          return antwort({ taskId: z.id, pushNotificationConfig: z.pushUrl ? { url: z.pushUrl, ...(z.pushToken ? { token: z.pushToken } : {}) } : null });
        }
        case "tasks/resubscribe": {
          const tid = String(params.id ?? "");
          const z = await taskLesen(pool, tid, u.actorId);
          if (!z) throw new RpcFehler(FEHLER.taskNichtGefunden, "Task nicht gefunden.");
          const frisch = await taskPruefen(pool, z);
          return streamSSE(c, async (stream) => {
            await stream.writeSSE({ data: JSON.stringify({ jsonrpc: "2.0", id, result: { kind: "status-update", taskId: frisch.id, contextId: frisch.contextId, status: alsTask(frisch).status, final: istTerminal(frisch.zustand) } }) });
          });
        }
        case "agent/getAuthenticatedExtendedCard":
          return antwort(agentenkarte(c.req.header("host")));
        default:
          throw new RpcFehler(FEHLER.methode, `Methode nicht unterstuetzt: ${n.method}`);
      }
    } catch (err) {
      if (err instanceof RpcFehler) return fehler(err);
      logger.error({ err: err instanceof Error ? err.message : String(err), method: n.method }, "[a2a] Fehler");
      return fehler(new RpcFehler(FEHLER.intern, "Interner Fehler"));
    }
  }
  return r;
}

export { istMcpHost };
