// v0.1.357 — Gemeinsame LLM-Auflösung für den LinkedIn-Beobachter.
//
// Vorher hatten Signal-Extractor (extractor.ts) und Bild-Analyse
// (image-extractor.ts) je eine EIGENE `resolveActiveLlm`. Der Signal-
// Extractor bekam den Anthropic-Abo-Pfad (v0.1.326), der Bild-Extractor
// NICHT — Folge: „No LLM defined" bei der Bildanalyse für alle Abo-
// Nutzer. Und keiner von beiden kannte den ChatGPT-Abo-Pfad.
//
// Diese Datei vereinheitlicht beides: API-Key (alle Provider),
// Anthropic-Abo (OAuth-Bearer) UND ChatGPT-Abo (Codex-OAuth). Beide
// Extractoren nutzen jetzt `resolveActiveLlm` + `buildLinkedInModel`.

import { createLLM } from "@ava/ai-provider";
import type { LanguageModel } from "ai";
import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore } from "../agent/providers/store";
import { createOpenAISubscriptionModel } from "../agent/providers/openai-subscription-model";

export interface ResolvedLlm {
  provider: "openai" | "anthropic" | "google" | "mistral" | "ollama";
  model: string;
  apiKey: string | null;
  baseURL?: string;
  /** Anthropic-Abo (Claude Pro/Max OAuth-Bearer). */
  anthropicSubscriptionToken?: string;
  /** ChatGPT-Abo (Codex-OAuth). */
  openaiSubscriptionToken?: string;
  openaiSubscriptionAccountId?: string;
}

/**
 * Löst das aktuell aktive LLM genauso auf wie der Chat-Agent — inkl.
 * beider Abo-Pfade. Gibt null zurück, wenn nichts konfiguriert/bereit
 * ist (kein Key + Ollama nicht bereit / Abo ohne Token).
 */
export async function resolveActiveLlm(
  providers: LlmProviderManager,
  store: ProviderConfigStore,
): Promise<ResolvedLlm | null> {
  const status = providers.getStatus();
  if (!status.ready || !status.model) return null;
  const kind = status.kind;

  if (kind === "ollama") {
    return { provider: "ollama", model: status.model, apiKey: null };
  }

  const cfg = store.getConfig();

  // Anthropic-Abo: kein API-Key, Auth via OAuth-Bearer.
  if (kind === "anthropic" && (cfg.anthropicAuthMode ?? "api-key") === "subscription") {
    const token = await store.getAnthropicSubscriptionToken();
    if (!token) return null;
    return {
      provider: "anthropic",
      model: status.model,
      apiKey: null,
      anthropicSubscriptionToken: token,
    };
  }

  // ChatGPT-Abo: kein API-Key, Auth via Codex-OAuth + Account-ID.
  if (kind === "openai" && (cfg.openaiAuthMode ?? "api-key") === "subscription") {
    const token = await store.getOpenAISubscriptionToken();
    if (!token) return null;
    const accountId = await store.getOpenAISubscriptionAccountId();
    return {
      provider: "openai",
      model: status.model,
      apiKey: null,
      openaiSubscriptionToken: token,
      ...(accountId ? { openaiSubscriptionAccountId: accountId } : {}),
    };
  }

  const key = await store.getKey(kind);
  if (!key) return null;
  return { provider: kind, model: status.model, apiKey: key };
}

/**
 * Baut aus einem ResolvedLlm das AI-SDK-Modell — mit korrektem Pfad für
 * beide Abos (ChatGPT-Abo geht über den Codex-Builder, Claude-Abo über
 * den OAuth-Bearer in createLLM).
 */
export function buildLinkedInModel(llm: ResolvedLlm): LanguageModel {
  if (llm.openaiSubscriptionToken) {
    return createOpenAISubscriptionModel({
      model: llm.model,
      accessToken: llm.openaiSubscriptionToken,
      ...(llm.openaiSubscriptionAccountId
        ? { accountId: llm.openaiSubscriptionAccountId }
        : {}),
    });
  }
  return createLLM({
    provider: llm.provider,
    model: llm.model,
    apiKey: llm.apiKey ?? undefined,
    baseURL: llm.baseURL,
    ...(llm.anthropicSubscriptionToken
      ? { anthropicSubscriptionToken: llm.anthropicSubscriptionToken }
      : {}),
  });
}
