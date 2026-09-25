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
import { SPRACHE_MODELL, SPRACHE_MODELL_RUECKFALL, spracheInstruktionen, spracheWerkzeuge } from "./instruktionen";

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
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${zugang.apiKey}`,
    "x-ava-llm-channel": "sprache",
  };
  if (opts.actorId) headers["OpenAI-Safety-Identifier"] = createHash("sha256").update(opts.actorId).digest("hex").slice(0, 32);
  // Erst das guenstige Mini; bei 400 (Modell/Stimme nicht verfuegbar) das grosse Modell.
  let letzterFehler: Error | null = null;
  for (const model of [SPRACHE_MODELL, SPRACHE_MODELL_RUECKFALL]) {
    try {
      return await praegen({ model, instructions, tools, stimme: opts.stimme, headers, baseURL: zugang.baseURL });
    } catch (err) {
      letzterFehler = err instanceof Error ? err : new Error(String(err));
      if (!/HTTP 400|HTTP 404/.test(letzterFehler.message)) throw letzterFehler;
    }
  }
  throw letzterFehler ?? new Error("Sitzung konnte nicht angelegt werden.");
}

async function praegen(a: { model: string; instructions: string; tools: Array<Record<string, unknown>>; stimme: SpracheStimme; headers: Record<string, string>; baseURL: string }): Promise<SpracheSitzung> {
  const { model, instructions, tools, headers } = a;
  const body = {
    session: {
      type: "realtime",
      model,
      instructions,
      tools,
      tool_choice: "auto",
      audio: {
        output: { voice: a.stimme },
        input: { turn_detection: { type: "semantic_vad", interrupt_response: true, create_response: true } },
      },
    },
  };
  const res = await fetch(`${a.baseURL.replace(/\/+$/, "")}/realtime/client_secrets`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Sitzung konnte nicht angelegt werden (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { value?: string; expires_at?: number };
  if (!json.value) throw new Error("Sitzung ohne Client-Schlüssel — Antwort von OpenAI unvollständig.");
  return { clientSecret: json.value, expiresAt: typeof json.expires_at === "number" ? json.expires_at : null, model, stimme: a.stimme, tools, instructions };
}
