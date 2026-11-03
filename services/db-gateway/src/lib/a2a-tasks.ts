// docs/PLAN_MCP_OEFFNUNG.md §14 — A2A-Fassade: Tasks fremder Agenten.
//
// Ein Task ist die Einheit des Agent2Agent-Protokolls: ein fremder Agent
// (Copilot Studio, Azure AI Foundry, n8n …) schickt eine Nachricht, AVA
// fuehrt einen Skill aus (dieselben Werkzeuge wie ueber MCP) und meldet den
// Zustand. Lesende Skills sind sofort `completed`; auftragsartige Skills
// (Import, Recherche, Neuverarbeitung) legen eine Transaktion an und bleiben
// `working`, bis kein Schritt der Transaktion mehr offen ist. Dann wird die
// beim Task hinterlegte Webhook-Adresse benachrichtigt (Push, mit
// Wiederholung). Kein LLM in der Cloud: freier Text geht, wenn die AVA des
// Nutzers verbunden ist, ueber das Kopf-Relais an dessen eigenes Modell.

import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getGatewayPool } from "./producer-pools";
import { logger } from "./logger";

export type TaskZustand = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected";

export interface A2aPart {
  kind: "text" | "data" | "file";
  text?: string;
  data?: unknown;
  file?: unknown;
  metadata?: Record<string, unknown>;
}

export interface A2aMessage {
  kind: "message";
  role: "user" | "agent";
  parts: A2aPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface A2aArtifact {
  artifactId: string;
  name?: string;
  parts: A2aPart[];
}

export interface A2aTask {
  kind: "task";
  id: string;
  contextId: string;
  status: { state: TaskZustand; message?: A2aMessage; timestamp: string };
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
}

export interface TaskZeile {
  id: string;
  contextId: string;
  tenantId: string;
  actorId: string;
  skill: string;
  eingabe: A2aMessage;
  zustand: TaskZustand;
  statusText: string | null;
  transactionId: string | null;
  ergebnis: A2aArtifact[] | null;
  verlauf: A2aMessage[];
  pushUrl: string | null;
  pushToken: string | null;
  pushVersuche: number;
  pushNaechster: Date | null;
  pushErledigt: boolean;
  abgeschlossenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const TERMINAL = new Set<TaskZustand>(["completed", "canceled", "failed", "rejected"]);
/** Laenger als 7 Tage offen: die Transaktion wird nicht mehr verarbeitet (AVA des Nutzers lief nicht). */
const VERFALL_MS = 7 * 24 * 3_600_000;
/** Push-Wiederholung: 1, 5, 15, 60, 180 Minuten, dann aufgeben. */
const PUSH_ABSTAENDE_MIN = [1, 5, 15, 60, 180];
const MAX_VERLAUF = 20;

export function istTerminal(z: TaskZustand): boolean {
  return TERMINAL.has(z);
}

export function agentNachricht(text: string, data?: unknown, extra?: { taskId?: string; contextId?: string }): A2aMessage {
  const parts: A2aPart[] = [{ kind: "text", text }];
  if (data !== undefined) parts.push({ kind: "data", data });
  return { kind: "message", role: "agent", parts, messageId: randomUUID(), ...(extra?.taskId ? { taskId: extra.taskId } : {}), ...(extra?.contextId ? { contextId: extra.contextId } : {}) };
}

export function alsTask(z: TaskZeile, historyLength?: number): A2aTask {
  const status: A2aTask["status"] = { state: z.zustand, timestamp: z.updatedAt.toISOString() };
  if (z.statusText) status.message = agentNachricht(z.statusText, undefined, { taskId: z.id, contextId: z.contextId });
  const verlauf = [z.eingabe, ...z.verlauf];
  const history = historyLength === undefined ? verlauf : historyLength <= 0 ? [] : verlauf.slice(-historyLength);
  return {
    kind: "task",
    id: z.id,
    contextId: z.contextId,
    status,
    ...(z.ergebnis && z.ergebnis.length > 0 ? { artifacts: z.ergebnis } : {}),
    history,
    metadata: { skill: z.skill, ...(z.transactionId ? { transactionId: z.transactionId } : {}) },
  };
}

function zeile(r: Record<string, unknown>): TaskZeile {
  return {
    id: r.id as string,
    contextId: r.contextId as string,
    tenantId: r.tenantId as string,
    actorId: r.actorId as string,
    skill: r.skill as string,
    eingabe: r.eingabe as A2aMessage,
    zustand: r.zustand as TaskZustand,
    statusText: (r.statusText as string | null) ?? null,
    transactionId: (r.transactionId as string | null) ?? null,
    ergebnis: (r.ergebnis as A2aArtifact[] | null) ?? null,
    verlauf: (r.verlauf as A2aMessage[] | null) ?? [],
    pushUrl: (r.pushUrl as string | null) ?? null,
    pushToken: (r.pushToken as string | null) ?? null,
    pushVersuche: Number(r.pushVersuche ?? 0),
    pushNaechster: (r.pushNaechster as Date | null) ?? null,
    pushErledigt: r.pushErledigt === true,
    abgeschlossenAt: (r.abgeschlossenAt as Date | null) ?? null,
    createdAt: r.createdAt as Date,
    updatedAt: r.updatedAt as Date,
  };
}

export async function taskAnlegen(
  pool: pg.Pool,
  args: { tenantId: string; actorId: string; skill: string; eingabe: A2aMessage; contextId?: string | null; push?: { url: string; token?: string | null } | null },
): Promise<TaskZeile> {
  const id = randomUUID();
  const contextId = args.contextId?.trim() || randomUUID();
  const r = await pool.query(
    `INSERT INTO "A2aTask" ("id", "contextId", "tenantId", "actorId", "skill", "eingabe", "zustand", "pushUrl", "pushToken")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'submitted', $7, $8) RETURNING *`,
    [id, contextId, args.tenantId, args.actorId, args.skill, JSON.stringify({ ...args.eingabe, taskId: id, contextId }), args.push?.url ?? null, args.push?.token ?? null],
  );
  return zeile(r.rows[0] as Record<string, unknown>);
}

export async function taskLesen(pool: pg.Pool, id: string, actorId: string): Promise<TaskZeile | null> {
  const r = await pool.query(`SELECT * FROM "A2aTask" WHERE "id" = $1 AND "actorId" = $2`, [id, actorId]);
  return r.rows[0] ? zeile(r.rows[0] as Record<string, unknown>) : null;
}

/** Zustand setzen; terminale Zustaende setzen abgeschlossenAt und planen den Push. */
export async function taskZustand(
  pool: pg.Pool,
  id: string,
  patch: { zustand: TaskZustand; statusText?: string | null; transactionId?: string | null; ergebnis?: A2aArtifact[] | null; nachricht?: A2aMessage | null },
): Promise<TaskZeile | null> {
  const terminal = istTerminal(patch.zustand);
  const r = await pool.query(
    `UPDATE "A2aTask" SET
       "zustand" = $2,
       "statusText" = COALESCE($3, "statusText"),
       "transactionId" = COALESCE($4, "transactionId"),
       "ergebnis" = COALESCE($5::jsonb, "ergebnis"),
       "verlauf" = CASE WHEN $6::jsonb IS NULL THEN "verlauf" WHEN jsonb_array_length("verlauf") >= $8 THEN ("verlauf" - 0) || jsonb_build_array($6::jsonb) ELSE "verlauf" || jsonb_build_array($6::jsonb) END,
       "abgeschlossenAt" = CASE WHEN $7 THEN COALESCE("abgeschlossenAt", NOW()) ELSE "abgeschlossenAt" END,
       "pushNaechster" = CASE WHEN $7 AND "pushUrl" IS NOT NULL AND NOT "pushErledigt" THEN NOW() ELSE "pushNaechster" END,
       "updatedAt" = NOW()
     WHERE "id" = $1 RETURNING *`,
    [id, patch.zustand, patch.statusText ?? null, patch.transactionId ?? null, patch.ergebnis ? JSON.stringify(patch.ergebnis) : null, patch.nachricht ? JSON.stringify(patch.nachricht) : null, terminal, MAX_VERLAUF],
  );
  return r.rows[0] ? zeile(r.rows[0] as Record<string, unknown>) : null;
}

export async function pushKonfigSetzen(pool: pg.Pool, id: string, actorId: string, push: { url: string; token?: string | null }): Promise<TaskZeile | null> {
  const r = await pool.query(
    `UPDATE "A2aTask" SET "pushUrl" = $3, "pushToken" = $4, "pushErledigt" = false, "pushVersuche" = 0,
       "pushNaechster" = CASE WHEN "zustand" IN ('completed','canceled','failed','rejected') THEN NOW() ELSE NULL END, "updatedAt" = NOW()
     WHERE "id" = $1 AND "actorId" = $2 RETURNING *`,
    [id, actorId, push.url, push.token ?? null],
  );
  return r.rows[0] ? zeile(r.rows[0] as Record<string, unknown>) : null;
}

/** Webhook-Ziel pruefen: nur https, keine lokalen oder privaten Adressen (SSRF). */
export function pushUrlErlaubt(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number) as [number, number];
    if (a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return false;
  }
  if (h.includes(":") || h === "[::1]") return false;
  return true;
}

// ---- Fortschritt auftragsartiger Tasks ---------------------------------------

/** Stand der Transaktion aus EntityProgress (wie /v1/transactions/{id}/fortschritt, ohne Auth-Kontext). */
async function transaktionsStand(pool: pg.Pool, transactionId: string): Promise<{ firmen: number; offen: number; fehlgeschlagen: number; abgeschlossen: number; fehler: Array<{ companyId: string; producer: string; meldung: string }> }> {
  const res = await pool.query<{ companyId: string; producer: string; state: string; errorMessage: string | null }>(
    `SELECT "companyId", producer, state, "errorMessage" FROM "EntityProgress" WHERE "transactionId" = $1`,
    [transactionId],
  );
  const jeFirma = new Map<string, Map<string, { state: string; errorMessage: string | null }>>();
  for (const r of res.rows) {
    const m = jeFirma.get(r.companyId) ?? new Map();
    m.set(r.producer, { state: r.state, errorMessage: r.errorMessage });
    jeFirma.set(r.companyId, m);
  }
  let offen = 0;
  let fehlgeschlagen = 0;
  let abgeschlossen = 0;
  const fehler: Array<{ companyId: string; producer: string; meldung: string }> = [];
  for (const [companyId, m] of jeFirma) {
    const web = m.get("website");
    const webOhne = !!web && (web.state === "failed" || web.state === "skipped");
    for (const [producer, z] of m) {
      let st = z.state;
      if ((producer === "company-profile" || producer === "company-contact") && st === "pending" && webOhne) st = "skipped";
      if (st === "failed") {
        fehlgeschlagen++;
        if (fehler.length < 10) fehler.push({ companyId, producer, meldung: (z.errorMessage ?? "Fehler").slice(0, 200) });
      } else if (st === "completed" || st === "skipped") abgeschlossen++;
      else offen++;
    }
  }
  return { firmen: jeFirma.size, offen, fehlgeschlagen, abgeschlossen, fehler };
}

/** Prueft einen offenen Task und schliesst ihn ab, wenn die Transaktion durch ist. Liefert den aktuellen Stand. */
export async function taskPruefen(pool: pg.Pool, z: TaskZeile): Promise<TaskZeile> {
  if (istTerminal(z.zustand) || !z.transactionId) return z;
  const st = await transaktionsStand(pool, z.transactionId);
  const alter = Date.now() - z.createdAt.getTime();
  if (st.firmen > 0 && st.offen === 0) {
    const text = st.fehlgeschlagen > 0
      ? `Vorgang beendet: ${st.firmen} Firmen, ${st.abgeschlossen} Schritte abgeschlossen, ${st.fehlgeschlagen} fehlgeschlagen.`
      : `Vorgang abgeschlossen: ${st.firmen} Firmen, ${st.abgeschlossen} Schritte.`;
    const ergebnis: A2aArtifact[] = [{ artifactId: randomUUID(), name: "fortschritt", parts: [{ kind: "text", text }, { kind: "data", data: { transactionId: z.transactionId, ...st } }] }];
    return (await taskZustand(pool, z.id, { zustand: "completed", statusText: text, ergebnis, nachricht: agentNachricht(text, undefined, { taskId: z.id, contextId: z.contextId }) })) ?? z;
  }
  if (alter > VERFALL_MS) {
    const text = st.firmen === 0
      ? "Der Vorgang wurde innerhalb von 7 Tagen nicht verarbeitet: Die AVA des Nutzers (Desktop-App oder Server) lief nicht."
      : `Der Vorgang ist nach 7 Tagen nicht fertig (${st.offen} Schritte offen).`;
    return (await taskZustand(pool, z.id, { zustand: "failed", statusText: text, nachricht: agentNachricht(text, undefined, { taskId: z.id, contextId: z.contextId }) })) ?? z;
  }
  if (z.zustand === "submitted" && st.firmen > 0) {
    return (await taskZustand(pool, z.id, { zustand: "working", statusText: `In Arbeit: ${st.abgeschlossen} von ${st.abgeschlossen + st.offen + st.fehlgeschlagen} Schritten.` })) ?? z;
  }
  return z;
}

// ---- Push ------------------------------------------------------------------

async function pushSenden(pool: pg.Pool, z: TaskZeile): Promise<void> {
  if (!z.pushUrl) return;
  const versuch = z.pushVersuche + 1;
  let ok = false;
  let grund = "";
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(z.pushUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...(z.pushToken ? { "X-A2A-Notification-Token": z.pushToken } : {}) },
        body: JSON.stringify(alsTask(z, 0)),
        signal: ctrl.signal,
        redirect: "error",
      });
      ok = res.ok;
      grund = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    grund = err instanceof Error ? err.message : String(err);
  }
  const abstand = PUSH_ABSTAENDE_MIN[versuch - 1];
  const naechster = ok || abstand === undefined ? null : new Date(Date.now() + abstand * 60_000);
  await pool.query(
    `UPDATE "A2aTask" SET "pushVersuche" = $2, "pushErledigt" = $3, "pushNaechster" = $4, "updatedAt" = NOW() WHERE "id" = $1`,
    [z.id, versuch, ok || abstand === undefined, naechster],
  );
  logger[ok ? "info" : "warn"]({ taskId: z.id, versuch, grund, aufgegeben: !ok && abstand === undefined }, "[a2a] Push");
}

/** Takt: offene Tasks pruefen, faellige Pushs senden. */
export async function a2aTakt(pool: pg.Pool = getGatewayPool()): Promise<void> {
  const offen = await pool.query(`SELECT * FROM "A2aTask" WHERE "zustand" IN ('submitted','working') AND "transactionId" IS NOT NULL ORDER BY "createdAt" LIMIT 200`);
  for (const r of offen.rows) {
    try {
      await taskPruefen(pool, zeile(r as Record<string, unknown>));
    } catch (err) {
      logger.warn({ taskId: (r as { id: string }).id, err: err instanceof Error ? err.message : String(err) }, "[a2a] Pruefung fehlgeschlagen");
    }
  }
  const faellig = await pool.query(`SELECT * FROM "A2aTask" WHERE "pushErledigt" = false AND "pushUrl" IS NOT NULL AND "pushNaechster" IS NOT NULL AND "pushNaechster" <= NOW() ORDER BY "pushNaechster" LIMIT 100`);
  for (const r of faellig.rows) await pushSenden(pool, zeile(r as Record<string, unknown>));
}

export function startA2aTakt(): void {
  if (process.env.A2A_TAKT_DISABLED === "1") return;
  const tick = () => void a2aTakt().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[a2a] Takt fehlgeschlagen"));
  setTimeout(tick, 90_000).unref?.();
  setInterval(tick, 60_000).unref?.();
  logger.info("[a2a] Takt geplant (jede Minute)");
}
