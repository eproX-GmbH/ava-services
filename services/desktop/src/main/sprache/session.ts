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
  const basis = a.baseURL.replace(/\/+$/, "");
  const res = await fetch(`${basis}/realtime/client_secrets`, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // 2026-10-23 — 401/403 unterscheiden (Befund Patrick: "Der OpenAI-Schlüssel wurde
    // abgelehnt" ohne Hinweis, warum): Schluessel ungueltig oder nur ohne Recht fuer
    // Realtime (Projektschluessel mit eingeschraenkten Rechten, Organisation ohne Freigabe).
    if (res.status === 401 || res.status === 403) {
      const probe = await fetch(`${basis}/models`, { headers: { authorization: headers.authorization ?? "" } }).catch(() => null);
      if (probe?.ok) {
        throw new Error(
          `HTTP ${res.status}: Der OpenAI-Schlüssel ist gültig, darf aber keine Sprachsitzungen anlegen. Bei OpenAI unter Projekt → API-Schlüssel die Rechte des Schlüssels auf "Alle" stellen oder das Modell ${model} für das Projekt freigeben.`,
        );
      }
      throw new Error(`HTTP ${res.status}: Der OpenAI-Schlüssel wurde abgelehnt (ungültig, widerrufen oder abgelaufen). In den Einstellungen → KI-Zugänge einen gültigen Schlüssel hinterlegen.`);
    }
    throw new Error(`Sitzung konnte nicht angelegt werden (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { value?: string; expires_at?: number };
  if (!json.value) throw new Error("Sitzung ohne Client-Schlüssel — Antwort von OpenAI unvollständig.");
  return { clientSecret: json.value, expiresAt: typeof json.expires_at === "number" ? json.expires_at : null, model, stimme: a.stimme, tools, instructions };
}
