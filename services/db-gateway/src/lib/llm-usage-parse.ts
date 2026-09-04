// O4 — Token-Zaehler aus Anbieter-Antworten lesen (JSON und SSE).
//
//   openai chat:        usage.prompt_tokens / completion_tokens / prompt_tokens_details.cached_tokens
//   openai responses:   usage.input_tokens / output_tokens / input_tokens_details.cached_tokens
//   anthropic:          usage.input_tokens / output_tokens / cache_read_input_tokens
//                       (Stream: message_start.usage + message_delta.usage)
//   google:             usageMetadata.promptTokenCount / candidatesTokenCount / cachedContentTokenCount
//   mistral/deepseek/xai/qwen: OpenAI-Chat-Format

export interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  model: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fromObject(o: Record<string, unknown>): Partial<UsageCounts> | null {
  const usage = o["usage"];
  const meta = o["usageMetadata"];
  const model = typeof o["model"] === "string" ? (o["model"] as string) : null;
  if (usage && typeof usage === "object") {
    const u = usage as Record<string, unknown>;
    const ptd = u["prompt_tokens_details"] as Record<string, unknown> | undefined;
    const itd = u["input_tokens_details"] as Record<string, unknown> | undefined;
    const input = num(u["prompt_tokens"]) || num(u["input_tokens"]);
    const output = num(u["completion_tokens"]) || num(u["output_tokens"]);
    const cache = num(ptd?.["cached_tokens"]) || num(itd?.["cached_tokens"]) || num(u["cache_read_input_tokens"]);
    return { inputTokens: input, outputTokens: output, cacheReadTokens: cache, model };
  }
  if (meta && typeof meta === "object") {
    const m = meta as Record<string, unknown>;
    return {
      inputTokens: num(m["promptTokenCount"]),
      outputTokens: num(m["candidatesTokenCount"]),
      cacheReadTokens: num(m["cachedContentTokenCount"]),
      model: typeof o["modelVersion"] === "string" ? (o["modelVersion"] as string) : model,
    };
  }
  return null;
}

export function parseUsageFromJson(text: string): UsageCounts | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const u = fromObject(o);
    if (!u) return null;
    return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0, cacheReadTokens: u.cacheReadTokens ?? 0, model: u.model ?? null };
  } catch {
    return null;
  }
}

/** SSE-Text komplett auswerten: letzter usage-Block gewinnt; Anthropic
 *  summiert message_start (Input) und message_delta (Output). */
export function parseUsageFromSse(text: string): UsageCounts | null {
  const out: UsageCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, model: null };
  let gefunden = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = typeof o["type"] === "string" ? (o["type"] as string) : "";
    if (type === "message_start") {
      const msg = o["message"] as Record<string, unknown> | undefined;
      const u = msg ? fromObject(msg) : null;
      if (u) {
        out.inputTokens = u.inputTokens ?? 0;
        out.cacheReadTokens = u.cacheReadTokens ?? 0;
        out.model = u.model ?? out.model;
        gefunden = true;
      }
      continue;
    }
    if (type === "message_delta") {
      const u = fromObject(o);
      if (u) {
        out.outputTokens = u.outputTokens ?? out.outputTokens;
        gefunden = true;
      }
      continue;
    }
    // OpenAI-Responses-API: response.completed traegt response.usage
    const resp = o["response"] as Record<string, unknown> | undefined;
    const u = fromObject(o) ?? (resp ? fromObject(resp) : null);
    if (u && (u.inputTokens || u.outputTokens)) {
      out.inputTokens = u.inputTokens ?? out.inputTokens;
      out.outputTokens = u.outputTokens ?? out.outputTokens;
      out.cacheReadTokens = u.cacheReadTokens ?? out.cacheReadTokens;
      out.model = u.model ?? out.model;
      gefunden = true;
    } else if (u?.model && !out.model) {
      out.model = u.model;
    }
  }
  return gefunden ? out : null;
}

/** Sichtbaren Antworttext aus SSE ziehen (fuer Prompt-Audit, gekuerzt). */
export function extractTextFromSse(text: string, max = 200_000): string {
  const parts: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const o = JSON.parse(payload) as Record<string, unknown>;
      const delta = o["delta"] as Record<string, unknown> | undefined;
      if (typeof delta?.["text"] === "string") parts.push(delta["text"] as string);
      const choices = o["choices"] as Array<Record<string, unknown>> | undefined;
      const d = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
      if (typeof d?.["content"] === "string") parts.push(d["content"] as string);
      if (o["type"] === "response.output_text.delta" && typeof o["delta"] === "string") parts.push(o["delta"] as string);
    } catch {
      /* Fragment */
    }
    if (parts.join("").length > max) break;
  }
  return parts.join("").slice(0, max);
}
