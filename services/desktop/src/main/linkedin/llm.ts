// v0.1.357 — Gemeinsame LLM-Auflösung für den LinkedIn-Beobachter.
//
// Vorher hatten Signal-Extractor (extractor.ts) und Bild-Analyse
// (image-extractor.ts) je eine EIGENE `resolveActiveLlm`. Der Signal-
// Extractor bekam den Anthropic-Abo-Pfad (v0.1.326), der Bild-Extractor
// NICHT — Folge: „No LLM defined" bei der Bildanalyse für alle Abo-
// Nutzer. Und keiner von beiden kannte den ChatGPT-Abo-Pfad.
//
// Diese Datei vereinheitlicht beides: API-Key (alle Provider),
// Anthropic-Abo (OAuth-Bearer) UND ChatGPT-Abo (Sign in with ChatGPT). Beide
// Extractoren nutzen jetzt `resolveActiveLlm` + `buildLinkedInModel`.

import { createLLM } from "@ava/ai-provider";
import type { LanguageModel } from "ai";
import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore } from "../agent/providers/store";
import { createOpenAIPlanModel, getCachedPlanModelle, listePlanModelle, standardPlanModell } from "../agent/providers/openai-subscription-model";
import { nurRegisterVerarbeitung } from "../worker-modus";

export interface ResolvedLlm {
  provider:
    | "openai"
    | "anthropic"
    | "google"
    | "mistral"
    | "deepseek"
    | "xai"
    | "qwen"
    | "ollama";
  model: string;
  apiKey: string | null;
  baseURL?: string;
  /** Anthropic-Abo (Claude Pro/Max OAuth-Bearer). */
  anthropicSubscriptionToken?: string;
  /** ChatGPT-Abo (Sign in with ChatGPT, Plan-Nutzung). */
  openaiSubscriptionToken?: string;
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
  // Worker-Modus: LinkedIn-Auswertung ist Hintergrundarbeit, kein Modell.
  if (nurRegisterVerarbeitung()) return null;
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

  // ChatGPT-Abo: kein API-Key, Plan-Token gegen api.openai.com mit dem
  // gewaehlten Plan-Modell (sonst Standard des Kontos).
  if (kind === "openai" && (cfg.openaiAuthMode ?? "api-key") === "subscription") {
    const record = await store.getOpenAISubscriptionRecord();
    if (!record) return null;
    let modell = record.planModel ?? null;
    if (!modell) {
      const liste = getCachedPlanModelle(record.accessToken) ?? (await listePlanModelle(record.accessToken).catch(() => []));
      modell = standardPlanModell(liste);
    }
    if (!modell) return null;
    return {
      provider: "openai",
      model: modell,
      apiKey: null,
      openaiSubscriptionToken: record.accessToken,
    };
  }

  const key = await store.getKey(kind);
  if (!key) return null;
  return { provider: kind, model: status.model, apiKey: key };
}

/**
 * Baut aus einem ResolvedLlm das AI-SDK-Modell — mit korrektem Pfad für
 * beide Abos (ChatGPT-Abo geht über den Plan-Builder, Claude-Abo über
 * den OAuth-Bearer in createLLM).
 */
export function buildLinkedInModel(llm: ResolvedLlm): LanguageModel {
  if (llm.openaiSubscriptionToken) {
    return createOpenAIPlanModel({ model: llm.model, accessToken: llm.openaiSubscriptionToken });
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
