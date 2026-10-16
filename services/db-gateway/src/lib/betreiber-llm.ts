// Serverseitige LLM-Aufrufe ueber die Betreiber-Spur (OPERATOR_OPENAI_API_KEY,
// OPERATOR_POOL_MODEL). Jeder Aufruf landet als LlmUsage kind=betreiber mit `quelle`,
// damit Kosten je Zweck (z. B. "vorab:<laufId>") exakt zuordenbar sind.

import type { ZodTypeAny, output as ZodOutput } from "zod";
import { loadEnv } from "./env";
import { getGatewayPool } from "./producer-pools";
import { estimateMicroUsd } from "./llm-pricing";
import { logger } from "./logger";

const OPENAI = "https://api.openai.com/v1/chat/completions";

export function betreiberVerfuegbar(): boolean {
  return Boolean(loadEnv().OPERATOR_OPENAI_API_KEY);
}

export type JsonErgebnis<T> = { ok: true; wert: T } | { ok: false; grund: string };

function jsonObjekt(raw: string): unknown {
  const t = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try { return JSON.parse(t.slice(a, b + 1)); } catch { /* unten */ }
    }
    return null;
  }
}

/** JSON-Antwort des Betreiber-Modells, mit zod validiert; ein Wiederholungsversuch. */
export async function betreiberJson<S extends ZodTypeAny>(args: { system: string; user: string; schema: S; quelle: string; tenantId?: string; actorId?: string; maxTokens?: number; timeoutMs?: number }): Promise<JsonErgebnis<ZodOutput<S>>> {
  const env = loadEnv();
  const key = env.OPERATOR_OPENAI_API_KEY;
  if (!key) return { ok: false, grund: "Betreiber-Modell nicht konfiguriert (OPERATOR_OPENAI_API_KEY)" };
  const modell = env.OPERATOR_POOL_MODEL;
  let grund = "unbekannt";
  for (let versuch = 0; versuch < 2; versuch++) {
    const start = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), args.timeoutMs ?? 90_000);
      const res = await fetch(OPENAI, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: modell,
          messages: [{ role: "system", content: args.system }, { role: "user", content: args.user }],
          response_format: { type: "json_object" },
          max_completion_tokens: args.maxTokens ?? 2000,
        }),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      const text = await res.text();
      let usage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | undefined;
      let inhalt = "";
      try {
        const j = JSON.parse(text) as { usage?: typeof usage; choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
        usage = j.usage;
        inhalt = j.choices?.[0]?.message?.content ?? "";
        if (j.error?.message) grund = j.error.message.slice(0, 200);
      } catch {
        grund = `Antwort nicht lesbar (${res.status})`;
      }
      const input = usage?.prompt_tokens ?? 0;
      const output = usage?.completion_tokens ?? 0;
      const cache = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      void getGatewayPool().query(
        `INSERT INTO "LlmUsage" ("id", "tenantId", "actorId", "kind", "model", "inputTokens", "outputTokens", "cacheReadTokens", "costMicroUsd", "status", "latencyMs", "streamed", "channel", "quelle")
         VALUES ($1, $2, $3, 'betreiber', $4, $5, $6, $7, $8, $9, $10, false, 'background', $11)`,
        [`lu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`, args.tenantId ?? process.env.OPERATOR_TENANT_ID ?? "betreiber", args.actorId ?? "betreiber", modell, input, output, cache,
          estimateMicroUsd({ provider: "openai", model: modell, inputTokens: input, outputTokens: output, cacheReadTokens: cache }), res.status, Date.now() - start, args.quelle.slice(0, 80)],
      ).catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[betreiber-llm] LlmUsage insert failed"));
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 2000 * (versuch + 1))); continue; }
        return { ok: false, grund };
      }
      const obj = jsonObjekt(inhalt);
      if (!obj) { grund = "Antwort war kein JSON"; continue; }
      const parsed = args.schema.safeParse(obj);
      if (!parsed.success) { grund = `Antwort passt nicht zum Schema: ${parsed.error.issues[0]?.message ?? "?"}`; continue; }
      return { ok: true, wert: parsed.data as ZodOutput<S> };
    } catch (err) {
      grund = err instanceof Error ? err.message.slice(0, 160) : String(err);
    }
  }
  return { ok: false, grund };
}
