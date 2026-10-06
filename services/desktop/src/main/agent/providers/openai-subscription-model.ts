// ChatGPT-Abo ueber „Sign in with ChatGPT“ mit Plan-Nutzung
// (docs/PLAN_SIGN_IN_WITH_CHATGPT.md). Desktop-lokaler Builder, bewusst
// NICHT im geteilten @ava/ai-provider-Paket (CI-Guard check-vendor-drift
// vergleicht dessen dist byte-genau mit den Producer-Kopien; die Producer
// brauchen den Abo-Pfad nicht).
//
// 2026-10-06: Der fruehere Codex-Umweg (chatgpt.com/backend-api/codex mit
// eigener Modellfamilie, Instructions-Limit und Codex-Headern) ist entfernt.
// Altbestand-Verbindungen ohne `flow: "plan"` raeumt der Store beim Lesen
// weg; der Nutzer meldet sich einmal neu an.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
// Node 20+ undici-fetch bevorzugen (Chromium-net-fetch hat im Hardened-
// Runtime macOS-Build den bekannten ECONNRESET-Bug bei gestreamten
// Responses). Probe beim Modul-Load, Fallback auf global fetch.
let preferredFetch: typeof fetch | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") preferredFetch = undici.fetch;
} catch {
  /* undici nicht auflösbar — global fetch */
}

// ---- Sign in with ChatGPT, Plan-Nutzung (docs/PLAN_SIGN_IN_WITH_CHATGPT.md) --
//
// Offizieller Weg: oeffentliche Responses API unter api.openai.com mit dem
// Access-Token des Nutzers. Pflicht: `store:false`, Streaming. Modelle kommen
// von GET /v1/models desselben Kontos — der Nutzer waehlt daraus selbst.
// Nicht ueber den Plan: chat/completions, embeddings, audio, realtime,
// deep research (dafuer weiter Schluessel oder lokale Modelle).

export const OPENAI_PLAN_BASE_URL = "https://api.openai.com/v1";

export interface PlanModell {
  id: string;
  label: string;
  istStandard: boolean;
}

const planModelleCache = new Map<string, { modelle: PlanModell[]; bis: number }>();
const PLAN_MODELLE_TTL_MS = 30 * 60_000;

/** Fuer das Konto freigegebene Modelle, Serverreihenfolge, 30 Minuten gecacht. */
export async function listePlanModelle(accessToken: string, baseFetch: typeof fetch = fetch): Promise<PlanModell[]> {
  const key = accessToken.slice(-24);
  const hit = planModelleCache.get(key);
  if (hit && hit.bis > Date.now()) return hit.modelle;
  const res = await baseFetch(`${OPENAI_PLAN_BASE_URL}/models`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`ChatGPT-Plan: Modellliste HTTP ${res.status}: ${text.slice(0, 300)}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
  const roh = Array.isArray(json.models) ? json.models : Array.isArray(json.data) ? json.data : [];
  const modelle: PlanModell[] = [];
  for (const m of roh) {
    const o = (m ?? {}) as Record<string, unknown>;
    const id = typeof o.slug === "string" ? o.slug : typeof o.id === "string" ? o.id : null;
    if (!id) continue;
    if (typeof o.visibility === "string" && o.visibility !== "list") continue;
    modelle.push({
      id,
      label: typeof o.display_name === "string" && o.display_name.length > 0 ? o.display_name : id,
      istStandard: o.is_default === true,
    });
  }
  planModelleCache.set(key, { modelle, bis: Date.now() + PLAN_MODELLE_TTL_MS });
  return modelle;
}

export function getCachedPlanModelle(accessToken: string | null | undefined): PlanModell[] | null {
  if (!accessToken) return null;
  return planModelleCache.get(accessToken.slice(-24))?.modelle ?? null;
}

/** Standard: is_default, sonst erstes der Liste. */
export function standardPlanModell(modelle: PlanModell[]): string | null {
  return modelle.find((m) => m.istStandard)?.id ?? modelle[0]?.id ?? null;
}

/** Fehlercodes der Plan-Nutzung in verstaendliche Saetze. */
export function planFehlerText(status: number, body: string): string | null {
  if (/subscription_sharing_usage_limit_exceeded/.test(body) || status === 429) {
    return "Dein ChatGPT-Plan hat sein Nutzungslimit fuer AVA erreicht. Limits verwaltest du unter chatgpt.com/settings/usage (Manage usage).";
  }
  if (/subscription_sharing_user_not_eligible/.test(body) || status === 403) {
    return "Dein ChatGPT-Konto darf den Plan hier nicht nutzen (kein Plus/Pro oder Freigabe fehlt). Pruefe chatgpt.com/settings/usage.";
  }
  if (/subscription_sharing_invalid_user/.test(body) || status === 401) {
    return "Die ChatGPT-Verbindung ist abgelaufen oder wurde in ChatGPT getrennt. Bitte in den Einstellungen neu anmelden.";
  }
  if (/subscription_sharing_usage_unavailable/.test(body) || status === 503) {
    return "Die Plan-Nutzung ist bei OpenAI gerade nicht verfuegbar. Gleich noch einmal versuchen.";
  }
  if (/subscription_sharing_unsupported_capability/.test(body)) {
    return "Diese Anfrage enthaelt etwas, das ueber den ChatGPT-Plan nicht erlaubt ist.";
  }
  return null;
}

function makePlanFetch(baseFetch: typeof fetch, accessToken: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const next: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(next.headers ?? {});
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${accessToken}`);
    next.headers = headers;
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/responses") && typeof next.body === "string") {
      try {
        const parsed = JSON.parse(next.body) as Record<string, unknown>;
        if (parsed.store !== false) parsed.store = false;
        next.body = JSON.stringify(parsed);
      } catch {
        /* Original-Body lassen */
      }
    }
    const res = await baseFetch(input, next);
    if (!res.ok && url.includes("/responses")) {
      try {
        const bodyText = await res.clone().text();
        // eslint-disable-next-line no-console
        console.error(`[chatgpt-plan] ${res.status} ${res.statusText}: ${bodyText.slice(0, 800)}`);
        const text = planFehlerText(res.status, bodyText);
        if (text) {
          // Verstaendlicher Fehler statt rohem JSON; der Body bleibt lesbar.
          return new Response(JSON.stringify({ error: { message: text, code: "chatgpt_plan" } }), {
            status: res.status,
            statusText: res.statusText,
            headers: { "content-type": "application/json" },
          });
        }
      } catch {
        /* body not readable */
      }
    }
    return res;
  }) as typeof fetch;
}

/** AI-SDK-Modell gegen die oeffentliche Responses API mit dem Plan-Token. */
export function createOpenAIPlanModel(args: { model: string; accessToken: string }): LanguageModel {
  const client = createOpenAI({
    apiKey: "oauth-placeholder",
    baseURL: OPENAI_PLAN_BASE_URL,
    fetch: makePlanFetch(preferredFetch ?? fetch, args.accessToken),
  });
  return client.responses(args.model);
}
