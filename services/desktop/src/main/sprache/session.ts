// Sprachmodus — ephemeren Client-Schluessel praegen (docs/PLAN_SPRACHMODUS.md, S0).
//
// Der Standardschluessel verlaesst nie den Hauptprozess. Eigener Schluessel →
// direkt api.openai.com; Organisationsschluessel → Gateway-Proxy
// (/v1/llm/openai/…), der Proxy setzt den Schluessel ein. Der Renderer
// bekommt nur den kurzlebigen Client-Schluessel und verbindet sich damit
// per WebRTC direkt mit OpenAI.

import { createHash } from "node:crypto";
import type { LlmProviderManager } from "../agent/providers/manager";
import type { SpracheSitzung, SpracheStimme } from "../../shared/types";
import { SPRACHE_MODELL, spracheInstruktionen, spracheWerkzeuge } from "./instruktionen";

export async function praegeSitzung(opts: {
  providers: LlmProviderManager;
  stimme: SpracheStimme;
  nutzerName?: string | null;
  actorId?: string | null;
}): Promise<SpracheSitzung> {
  const zugang = await opts.providers.openaiZugang();
  if (!zugang) throw new Error("Kein OpenAI-Schlüssel hinterlegt (weder eigener noch einer der Organisation).");
  const instructions = spracheInstruktionen({ nutzerName: opts.nutzerName ?? null });
  const tools = spracheWerkzeuge();
  const body = {
    session: {
      type: "realtime",
      model: SPRACHE_MODELL,
      instructions,
      tools,
      tool_choice: "auto",
      audio: {
        output: { voice: opts.stimme },
        input: { turn_detection: { type: "semantic_vad", interrupt_response: true, create_response: true } },
      },
    },
  };
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${zugang.apiKey}`,
    "x-ava-llm-channel": "sprache",
  };
  if (opts.actorId) headers["OpenAI-Safety-Identifier"] = createHash("sha256").update(opts.actorId).digest("hex").slice(0, 32);
  const res = await fetch(`${zugang.baseURL.replace(/\/+$/, "")}/realtime/client_secrets`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sitzung konnte nicht angelegt werden (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { value?: string; expires_at?: number };
  if (!json.value) throw new Error("Sitzung ohne Client-Schlüssel — Antwort von OpenAI unvollständig.");
  return { clientSecret: json.value, expiresAt: typeof json.expires_at === "number" ? json.expires_at : null, model: SPRACHE_MODELL, stimme: opts.stimme, tools, instructions };
}
