// Sprachmodus — GPT Live (gpt-live-1) statt Realtime API (2026-09-25).
//
// GPT Live ist OpenAIs aktuelles Sprachmodell: eine Stimme, die Denken und
// Werkzeuge an ein Backend delegiert — bei uns an den Chat-Orchestrator
// ("client delegation"). Abrechnung je Sekunde (0,05 $/Min) statt je
// Audio-Token. Die Sitzung entsteht serverseitig: Der Renderer schickt sein
// SDP-Angebot, der Hauptprozess legt die Sitzung mit dem Schluessel an
// (eigener oder Organisation ueber den Gateway-Proxy) und gibt die SDP-
// Antwort zurueck. Der Schluessel verlaesst den Hauptprozess nie.

import { createHash } from "node:crypto";
import type { LlmProviderManager } from "../agent/providers/manager";
import type { SpracheStimme } from "../../shared/types";
import { liveInstruktionen } from "./instruktionen";

export const LIVE_MODELL = "gpt-live-1";

export interface LiveSitzung {
  sessionId: string;
  sdpAnswer: string;
  model: string;
}

export async function liveSitzungStarten(opts: {
  providers: LlmProviderManager;
  sdpOffer: string;
  stimme: SpracheStimme;
  nutzerName?: string | null;
  actorId?: string | null;
}): Promise<LiveSitzung> {
  const zugang = await opts.providers.openaiZugang();
  if (!zugang) throw new Error("Kein OpenAI-Schlüssel hinterlegt (weder eigener noch einer der Organisation).");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${zugang.apiKey}`,
    "x-ava-llm-channel": "sprache",
  };
  if (opts.actorId) headers["OpenAI-Safety-Identifier"] = createHash("sha256").update(opts.actorId).digest("hex").slice(0, 32);
  const body = {
    session: {
      model: LIVE_MODELL,
      instructions: liveInstruktionen({ nutzerName: opts.nutzerName ?? null }),
      audio: { output: { voice: opts.stimme } },
      delegation: { type: "client" },
    },
    transport: { type: "webrtc", sdp: opts.sdpOffer },
  };
  const res = await fetch(`${zugang.baseURL.replace(/\/+$/, "")}/live/sessions`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Live-Sitzung konnte nicht angelegt werden (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { session?: { id?: string }; transport?: { sdp?: string } };
  if (!json.transport?.sdp) throw new Error("Live-Sitzung ohne SDP-Antwort — Antwort von OpenAI unvollständig.");
  return { sessionId: json.session?.id ?? "", sdpAnswer: json.transport.sdp, model: LIVE_MODELL };
}
