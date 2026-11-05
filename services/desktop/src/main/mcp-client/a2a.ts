// Agent-zu-Agent (A2A) als Client (docs/PLAN_CLOSE_MCP.md, C2): AVA gibt einem
// fremden Agenten Auftraege. Agentenkarte unter /.well-known/agent-card.json
// (oder agent.json), JSON-RPC `message/send` und `tasks/get` wie bei unserer
// eigenen A2A-Fassade im Gateway (routes/a2a.ts). Zugang ueber dieselben
// Kopfzeilen wie bei MCP-Diensten.

export interface A2aSkill {
  id: string;
  name: string;
  description?: string;
  examples?: string[];
}

export interface A2aAgentenkarte {
  name: string;
  description: string;
  /** JSON-RPC-Endpunkt. */
  url: string;
  version?: string;
  skills: A2aSkill[];
}

interface A2aPart {
  kind?: string;
  type?: string;
  text?: string;
  data?: unknown;
}

interface A2aTask {
  id: string;
  contextId?: string;
  status?: { state?: string; message?: { parts?: A2aPart[] } };
  artifacts?: Array<{ name?: string; parts?: A2aPart[] }>;
}

export interface A2aAuftragErgebnis {
  taskId: string;
  zustand: string;
  abgeschlossen: boolean;
  text: string;
  daten: unknown[];
}

const TERMINAL = new Set(["completed", "failed", "canceled", "cancelled", "rejected"]);
const ZEITLIMIT_MS = 20_000;

async function holeJson<T>(url: string, init: RequestInit, was: string): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ZEITLIMIT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`${was}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

/** Agentenkarte laden: Adresse der Karte direkt oder Basisadresse des Agenten. */
export async function agentenkarteLaden(adresse: string, headers: Record<string, string>): Promise<A2aAgentenkarte> {
  const u = new URL(adresse);
  const kandidaten: string[] = [];
  if (/\.json$/i.test(u.pathname)) kandidaten.push(u.toString());
  else {
    const basis = u.toString().replace(/\/+$/, "");
    kandidaten.push(`${basis}/.well-known/agent-card.json`, `${basis}/.well-known/agent.json`, `${u.origin}/.well-known/agent-card.json`, `${u.origin}/.well-known/agent.json`);
  }
  let letzter: unknown = null;
  for (const k of [...new Set(kandidaten)]) {
    try {
      const karte = await holeJson<Record<string, unknown>>(k, { headers: { accept: "application/json", ...headers } }, "Agentenkarte");
      const name = typeof karte.name === "string" ? karte.name : "";
      const url = typeof karte.url === "string" ? karte.url : "";
      if (!name || !url) throw new Error("Agentenkarte ohne name/url");
      const skillsRoh = Array.isArray(karte.skills) ? (karte.skills as Array<Record<string, unknown>>) : [];
      return {
        name,
        description: typeof karte.description === "string" ? karte.description : "",
        url,
        version: typeof karte.version === "string" ? karte.version : undefined,
        skills: skillsRoh
          .filter((s) => typeof s.id === "string")
          .map((s) => ({ id: String(s.id), name: typeof s.name === "string" ? s.name : String(s.id), description: typeof s.description === "string" ? s.description : undefined, examples: Array.isArray(s.examples) ? (s.examples as unknown[]).filter((x): x is string => typeof x === "string") : undefined })),
      };
    } catch (err) {
      letzter = err;
    }
  }
  throw new Error(`Keine Agentenkarte gefunden (${letzter instanceof Error ? letzter.message : String(letzter)})`);
}

let rpcZaehler = 0;

async function rpc<T>(endpunkt: string, headers: Record<string, string>, method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const id = ++rpcZaehler;
  const res = await fetch(endpunkt, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`Agent antwortet ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const body = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
  if (body.error) throw new Error(`Agent meldet Fehler${body.error.code !== undefined ? ` ${body.error.code}` : ""}: ${body.error.message ?? "ohne Text"}`);
  if (body.result === undefined) throw new Error("Agent antwortet ohne Ergebnis.");
  return body.result;
}

function textAus(parts: A2aPart[] | undefined): string {
  return (parts ?? []).filter((p) => (p.kind ?? p.type) === "text" && typeof p.text === "string").map((p) => p.text as string).join("\n");
}

function ergebnisAus(task: A2aTask): A2aAuftragErgebnis {
  const zustand = task.status?.state ?? "unknown";
  const texte: string[] = [];
  const daten: unknown[] = [];
  for (const a of task.artifacts ?? []) {
    const t = textAus(a.parts);
    if (t) texte.push(a.name ? `${a.name}:\n${t}` : t);
    for (const p of a.parts ?? []) if ((p.kind ?? p.type) === "data" && p.data !== undefined) daten.push(p.data);
  }
  const statusText = textAus(task.status?.message?.parts);
  if (statusText && texte.length === 0) texte.push(statusText);
  return { taskId: task.id, zustand, abgeschlossen: TERMINAL.has(zustand), text: texte.join("\n\n"), daten };
}

function neueNachrichtId(): string {
  return `ava-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Auftrag senden und bis zu `wartenMs` auf den Abschluss warten (tasks/get alle 3 s). */
export async function auftragSenden(
  karte: A2aAgentenkarte,
  headers: Record<string, string>,
  text: string,
  opts: { wartenMs?: number; signal?: AbortSignal } = {},
): Promise<A2aAuftragErgebnis> {
  const task = await rpc<A2aTask>(karte.url, headers, "message/send", { message: { role: "user", kind: "message", messageId: neueNachrichtId(), parts: [{ kind: "text", text }] } }, opts.signal);
  let aktuell = ergebnisAus(task);
  const ende = Date.now() + (opts.wartenMs ?? 120_000);
  while (!aktuell.abgeschlossen && Date.now() < ende) {
    if (opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 3_000));
    const t = await rpc<A2aTask>(karte.url, headers, "tasks/get", { id: aktuell.taskId }, opts.signal).catch(() => null);
    if (t) aktuell = ergebnisAus(t);
  }
  return aktuell;
}

export async function auftragStatus(karte: A2aAgentenkarte, headers: Record<string, string>, taskId: string, signal?: AbortSignal): Promise<A2aAuftragErgebnis> {
  const t = await rpc<A2aTask>(karte.url, headers, "tasks/get", { id: taskId }, signal);
  return ergebnisAus(t);
}
