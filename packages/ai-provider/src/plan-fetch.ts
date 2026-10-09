// ChatGPT-Abo (Plan-Flow von „Sign in with ChatGPT") fuer Producer
// (docs/PLAN_CHATGPT_ABO_UEBERALL.md, E1–E3, E5).
//
// Der Kindprozess bekommt KEINEN Token in die Umgebung, sondern die Adresse
// eines Loopback-Endpunkts des Desktop-Mains (OPENAI_PLAN_TOKEN_URL) samt
// Geheimnis (OPENAI_PLAN_TOKEN_SECRET). Der Fetch-Wrapper holt den Access-
// Token je Anfrage (60 s gecacht, bei 401 sofort neu), setzt den Bearer,
// erzwingt `store:false`, entfernt Felder, die der Plan verbietet, und
// behandelt ein erschoepftes Kontingent als Pause (Rueckstau), nicht als
// Fehler der Firma.
//
// Regeln aus der OpenAI-Doku (gelesen 2026-10-09): nur /v1/responses und
// /v1/models, stream:true + store:false Pflicht, keine system-Nachrichten
// (developer stattdessen), background/previous_response_id/temperature/
// max_output_tokens/… weglassen; 429 kann auch mitten im Stream kommen.

export const OPENAI_PLAN_BASE_URL = "https://api.openai.com/v1";

/** Felder, die der Plan-Flow im Responses-Body nicht akzeptiert. */
const VERBOTENE_FELDER = [
  "background",
  "previous_response_id",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
] as const;

const TOKEN_CACHE_MS = 60_000;
/** Wartestufen bei erschoepftem Kontingent (Sekunden), danach Fehler. */
const LIMIT_WARTEN_S = [30, 60, 120, 300, 600, 600];

export interface PlanToken {
  accessToken: string;
  /** Im Abo gewaehltes Modell (Slug), falls bekannt. */
  model?: string;
}

export type PlanTokenQuelle = () => Promise<PlanToken | null>;

/** Plan-Flow fuer Producer aktiv? (Desktop setzt die URL nur, wenn Abo verbunden und erlaubt.) */
export function planAktiv(): boolean {
  return Boolean(process.env.OPENAI_PLAN_TOKEN_URL && process.env.OPENAI_PLAN_TOKEN_SECRET);
}

/** Token-Quelle aus der Umgebung (Loopback-Endpunkt des Desktop-Mains). */
export function planTokenQuelleAusUmgebung(baseFetch: typeof fetch = globalThis.fetch): PlanTokenQuelle | null {
  const url = process.env.OPENAI_PLAN_TOKEN_URL;
  const secret = process.env.OPENAI_PLAN_TOKEN_SECRET;
  if (!url || !secret) return null;
  let cache: { token: PlanToken; bis: number } | null = null;
  const quelle: PlanTokenQuelle & { verwerfen?: () => void } = async () => {
    if (cache && cache.bis > Date.now()) return cache.token;
    const res = await baseFetch(url, { headers: { "x-ava-plan-secret": secret, accept: "application/json" } });
    if (res.status === 404) {
      cache = null;
      return null;
    }
    if (!res.ok) throw new Error(`ChatGPT-Plan: Token-Endpunkt antwortet ${res.status}`);
    const json = (await res.json()) as { accessToken?: unknown; model?: unknown };
    if (typeof json.accessToken !== "string" || json.accessToken.length === 0) return null;
    const token: PlanToken = { accessToken: json.accessToken, ...(typeof json.model === "string" && json.model ? { model: json.model } : {}) };
    cache = { token, bis: Date.now() + TOKEN_CACHE_MS };
    return token;
  };
  quelle.verwerfen = () => {
    cache = null;
  };
  return quelle;
}

/** Verstaendlicher Fehlertext fuer die Plan-Fehlercodes, sonst null. */
export function planFehlerText(status: number, body: string): string | null {
  if (/subscription_sharing_invalid_user/.test(body) || status === 401) {
    return "ChatGPT-Abo: Die Anmeldung ist abgelaufen. Bitte in den Einstellungen erneut mit ChatGPT anmelden.";
  }
  if (/subscription_sharing_user_not_eligible/.test(body)) {
    return "ChatGPT-Abo: Das Konto kann sein Abo nicht teilen (nur Plus und Pro) oder die Freigabe fehlt.";
  }
  if (/subscription_sharing_usage_limit_exceeded/.test(body)) {
    return "ChatGPT-Abo: Das Nutzungslimit fuer AVA ist erschoepft (ChatGPT → Settings → Usage).";
  }
  if (/subscription_sharing_usage_unavailable/.test(body)) {
    return "ChatGPT-Abo: Die Plan-Nutzung ist vorueberggehend nicht verfuegbar.";
  }
  if (/subscription_sharing_unsupported_capability/.test(body)) {
    return "ChatGPT-Abo: Diese Anfrage enthaelt etwas, das ueber den Plan nicht erlaubt ist.";
  }
  return null;
}

function istKontingentFehler(status: number, body: string): boolean {
  return (
    (status === 429 && /subscription_sharing_usage_limit_exceeded/.test(body)) ||
    (status === 503 && /subscription_sharing_usage_unavailable/.test(body)) ||
    status === 429
  );
}

function urlVon(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** Body fuer /responses an die Plan-Regeln anpassen. */
export function bereinigeResponsesBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    parsed.store = false;
    for (const k of VERBOTENE_FELDER) delete parsed[k];
    // Explizite system-Nachrichten lehnt der Plan ab; developer ist das Pendant.
    if (Array.isArray(parsed.input)) {
      parsed.input = (parsed.input as unknown[]).map((item) => {
        if (item && typeof item === "object" && (item as { role?: unknown }).role === "system") {
          return { ...(item as Record<string, unknown>), role: "developer" };
        }
        return item;
      });
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

export interface PlanFetchOptions {
  /** Wird bei jeder Wartepause wegen Kontingent aufgerufen (Log, Status). */
  onLimit?: (info: { versuch: number; warteSekunden: number; status: number }) => void;
  /** Fuer Tests: eigene Wartefunktion. */
  schlafen?: (ms: number) => Promise<void>;
  /** Fuer Tests: Wartestufen. */
  wartestufenS?: readonly number[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * `fetch`, der jede Anfrage mit dem Plan-Token versieht. 401 (Token
 * abgelaufen) → Token verwerfen, einmal neu holen, wiederholen. 429/503
 * wegen Kontingent → in Stufen warten und wiederholen (Rueckstau), erst
 * nach der letzten Stufe scheitern.
 */
export function makePlanFetch(baseFetch: typeof fetch, quelle: PlanTokenQuelle, opts: PlanFetchOptions = {}): typeof fetch {
  const schlafen = opts.schlafen ?? sleep;
  const stufen = opts.wartestufenS ?? LIMIT_WARTEN_S;
  const verwerfen = (quelle as PlanTokenQuelle & { verwerfen?: () => void }).verwerfen;
  const planFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = urlVon(input);
    const istResponses = url.includes("/responses");
    let tokenNeuGeholt = false;
    let limitVersuch = 0;
    for (;;) {
      const token = await quelle();
      if (!token) throw new Error("ChatGPT-Abo: Keine Verbindung (Token fehlt). Bitte in den Einstellungen mit ChatGPT anmelden.");
      const next: RequestInit = { ...(init ?? {}) };
      const headers = new Headers(next.headers ?? {});
      headers.delete("x-api-key");
      headers.set("authorization", `Bearer ${token.accessToken}`);
      next.headers = headers;
      if (istResponses && typeof next.body === "string") next.body = bereinigeResponsesBody(next.body);
      const res = await baseFetch(input, next);
      if (res.ok) return res;
      const body = await res.clone().text().catch(() => "");
      if (res.status === 401 && !tokenNeuGeholt) {
        tokenNeuGeholt = true;
        verwerfen?.();
        continue;
      }
      if (istKontingentFehler(res.status, body) && limitVersuch < stufen.length) {
        const warteS = stufen[limitVersuch]!;
        limitVersuch++;
        opts.onLimit?.({ versuch: limitVersuch, warteSekunden: warteS, status: res.status });
        // eslint-disable-next-line no-console
        console.warn(`[chatgpt-plan] limit status=${res.status} versuch=${limitVersuch} warte=${warteS}s`);
        await schlafen(warteS * 1000);
        continue;
      }
      const text = planFehlerText(res.status, body);
      if (text) {
        // eslint-disable-next-line no-console
        console.error(`[chatgpt-plan] ${res.status}: ${body.slice(0, 400)}`);
        return new Response(JSON.stringify({ error: { message: text, code: "chatgpt_plan" } }), {
          status: res.status,
          statusText: res.statusText,
          headers: { "content-type": "application/json" },
        });
      }
      return res;
    }
  };
  return planFetch as typeof fetch;
}
