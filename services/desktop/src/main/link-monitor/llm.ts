// LM3 — kleine LLM-Helfer für Extractor + Diff.
//
// Spiegelt das Vorgehen aus agent/watch-executor.ts: über den
// LlmProviderManager streamen, Text einsammeln, JSON-Objekt robust
// herausparsen. Bewusst lokal gehalten (kein Tool-/Orchestrator-Kontext)
// — der Link-Monitor läuft im Hintergrund ohne Konversation.

import type { AgentMessage } from "../../shared/types";
import type { LlmProviderManager } from "../agent/providers";

/** Streamt eine Chat-Antwort komplett ein und gibt den Text zurück.
 *  Eigener Timeout; ein externes Signal wird mitberücksichtigt. */
export async function streamToText(
  providers: LlmProviderManager,
  messages: AgentMessage[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 45_000);
  const onAbort = (): void => ctrl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let buf = "";
  try {
    const stream = providers.streamChat({ messages, signal: ctrl.signal });
    for await (const frame of stream) {
      if (frame.contentDelta) buf += frame.contentDelta;
      if (frame.done) break;
      if (frame.errorMessage) throw new Error(frame.errorMessage);
    }
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
  return buf;
}

/** Baut die zwei Standard-Nachrichten (system + user). */
export function buildMessages(
  system: string,
  user: string,
  tag: string,
): AgentMessage[] {
  const stamp = Date.now();
  return [
    { id: `lm-${tag}-sys`, role: "system", content: system, createdAt: stamp },
    { id: `lm-${tag}-usr`, role: "user", content: user, createdAt: stamp },
  ];
}

/** Robustes Herausparsen eines JSON-Objekts aus einer Modell-Antwort
 *  (toleriert ```json-Fences + umgebenden Fließtext). Kopie aus
 *  watch-executor.ts. */
export function parseJsonObject(text: string): unknown {
  if (!text) return null;
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = fenceRe.exec(text);
  const candidate = m ? m[1]! : text;
  try {
    const parsed = JSON.parse(candidate.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
