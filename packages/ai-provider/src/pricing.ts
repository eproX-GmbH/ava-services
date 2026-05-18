// v0.1.210 — Modell-Preise für den Verbrauchs-Tab.
//
// Eine separate Datei (statt Inline in `catalog.ts`), weil:
//   - Preise ändern sich häufiger als die Capabilities.
//   - CI-Drift-Check kann diese Datei einzeln vergleichen.
//   - Ollama steht im Katalog mit `costClass: "free"` — hier braucht
//     es gar keinen Eintrag.
//
// **Disclaimer**: Die Preise sind Schätzungen (Stand 2026-05). Tatsächliche
// Abrechnung beim Anbieter kann abweichen (Volumen-Rabatte, Tier-spezifische
// Preise, neu eingeführte Caching-Pfade …). Im UI wird das mit einem
// Hinweistext klargestellt.
//
// Lookup-Strategie: per Provider+Modell-Id. Anthropics Modelle haben
// Datums-Suffixe (`claude-sonnet-4-5-20250929`); wir matchen per Prefix.

import type { CatalogProvider } from "./catalog";

/** USD pro 1 Million Tokens. Cache-Felder optional — die meisten
 *  Provider haben kein dediziertes Prompt-Caching-Pricing. */
export interface ModelPricing {
  /** Provider-Schlüssel im Katalog. */
  provider: CatalogProvider;
  /** Match-Präfix für den Modell-Identifier. Längster Präfix gewinnt
   *  (so überschreibt `claude-opus-4` den generischen `claude-` Eintrag). */
  modelIdPrefix: string;
  /** USD pro 1 Mio. Input-Tokens (Standard-Pfad). */
  inputPerMTok: number;
  /** USD pro 1 Mio. Output-Tokens. */
  outputPerMTok: number;
  /** USD pro 1 Mio. Cache-Read-Tokens (Anthropic Prompt-Caching).
   *  Optional — wenn nicht gesetzt, zählen Cache-Reads wie reguläre
   *  Input-Tokens. */
  cacheReadPerMTok?: number;
  /** USD pro 1 Mio. Cache-Write-Tokens (5-min ephemeral). Optional. */
  cacheWritePerMTok?: number;
}

// Hand-curated. Stand 2026-05. Quellen:
//   - https://www.anthropic.com/pricing
//   - https://openai.com/api/pricing/
//   - https://ai.google.dev/pricing
//   - https://mistral.ai/technology/#pricing
//
// Reihenfolge ist egal — die Lookup-Funktion sortiert nach Präfix-Länge.
export const PRICING: readonly ModelPricing[] = Object.freeze([
  // ---- Anthropic ----
  // Caching-Tarife sind 0.1x Input (read) bzw. 1.25x Input (write) für die
  // Sonnet/Haiku-Familie, 0.1x Input bzw. 1.25x Input für Opus — Quelle
  // siehe Anthropic-Pricing-Page.
  {
    provider: "anthropic",
    modelIdPrefix: "claude-opus-4",
    inputPerMTok: 15,
    outputPerMTok: 75,
    cacheReadPerMTok: 1.5,
    cacheWritePerMTok: 18.75,
  },
  {
    provider: "anthropic",
    modelIdPrefix: "claude-sonnet-4",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  {
    provider: "anthropic",
    modelIdPrefix: "claude-haiku-4",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
  {
    provider: "anthropic",
    modelIdPrefix: "claude-3-5-sonnet",
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
  },
  {
    provider: "anthropic",
    modelIdPrefix: "claude-3-5-haiku",
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cacheReadPerMTok: 0.08,
    cacheWritePerMTok: 1,
  },

  // ---- OpenAI ----
  // OpenAI führt Prompt-Caching automatisch (kein separater
  // Schreib-Preis); Cache-Reads kosten 0.5x Input. Wir spiegeln das
  // als `cacheReadPerMTok` ohne Cache-Write.
  {
    provider: "openai",
    modelIdPrefix: "gpt-4o-mini",
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cacheReadPerMTok: 0.075,
  },
  {
    provider: "openai",
    modelIdPrefix: "gpt-4o",
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cacheReadPerMTok: 1.25,
  },
  {
    provider: "openai",
    modelIdPrefix: "gpt-5-mini",
    inputPerMTok: 0.25,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.125,
  },
  {
    provider: "openai",
    modelIdPrefix: "gpt-5",
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.625,
  },
  {
    provider: "openai",
    modelIdPrefix: "o4-mini",
    inputPerMTok: 1.1,
    outputPerMTok: 4.4,
    cacheReadPerMTok: 0.275,
  },

  // ---- Google ----
  // Google hat 2-Tier-Pricing (≤200k Tokens / >200k); wir nehmen den
  // unteren Tarif, weil der für interaktive Chat-Use-Cases relevant ist.
  // Caching: nur bei Gemini-2.5-Familie, separate Rate.
  {
    provider: "google",
    modelIdPrefix: "gemini-2.5-pro",
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.31,
  },
  {
    provider: "google",
    modelIdPrefix: "gemini-2.5-flash",
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cacheReadPerMTok: 0.075,
  },
  {
    provider: "google",
    modelIdPrefix: "gemini-2.0-flash",
    inputPerMTok: 0.1,
    outputPerMTok: 0.4,
  },

  // ---- Mistral ----
  {
    provider: "mistral",
    modelIdPrefix: "mistral-large",
    inputPerMTok: 2,
    outputPerMTok: 6,
  },
  {
    provider: "mistral",
    modelIdPrefix: "mistral-medium",
    inputPerMTok: 0.4,
    outputPerMTok: 2,
  },
  {
    provider: "mistral",
    modelIdPrefix: "mistral-small",
    inputPerMTok: 0.2,
    outputPerMTok: 0.6,
  },
]);

/** Längsten passenden Preis-Eintrag für ein Modell finden. Ergibt
 *  `null` zurück, wenn nichts matched (UI zeigt dann USD = NULL). */
export function findPricing(
  provider: string,
  modelId: string,
): ModelPricing | null {
  const candidates = PRICING.filter(
    (p) => p.provider === provider && modelId.startsWith(p.modelIdPrefix),
  );
  if (candidates.length === 0) return null;
  // Längster Präfix gewinnt — sonst würde `claude-` ein eingebautes
  // `claude-opus-4` überschreiben.
  return candidates.reduce((best, c) =>
    c.modelIdPrefix.length > best.modelIdPrefix.length ? c : best,
  );
}

/** USD-Schätzung für einen Call. Returns `null`, wenn das Modell nicht
 *  in der Preistabelle steht. */
export function estimateUsd(args: {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): number | null {
  const p = findPricing(args.provider, args.model);
  if (!p) return null;
  const M = 1_000_000;
  // Normale Input-Tokens (ohne Cache-Read, falls Caching aktiv ist).
  // `inputTokens` ist hier der NICHT-gecachete Anteil (Provider melden
  // das so getrennt). Cache-Read/Write zählen separat.
  let usd = (args.inputTokens / M) * p.inputPerMTok;
  usd += (args.outputTokens / M) * p.outputPerMTok;
  if (args.cacheReadTokens && p.cacheReadPerMTok !== undefined) {
    usd += (args.cacheReadTokens / M) * p.cacheReadPerMTok;
  } else if (args.cacheReadTokens) {
    // Provider ohne Cache-Pricing → Cache-Reads wie regulärer Input.
    usd += (args.cacheReadTokens / M) * p.inputPerMTok;
  }
  if (args.cacheWriteTokens && p.cacheWritePerMTok !== undefined) {
    usd += (args.cacheWriteTokens / M) * p.cacheWritePerMTok;
  } else if (args.cacheWriteTokens) {
    usd += (args.cacheWriteTokens / M) * p.inputPerMTok;
  }
  return usd;
}
