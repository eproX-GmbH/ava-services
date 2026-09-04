// O4 — Modell-Preise fuer das Metering (USD je 1 Mio. Tokens).
// Kopie von packages/ai-provider/src/pricing.ts (das Paket ist nicht als
// Gateway-Dependency veroeffentlicht). Bei Aenderungen beide pflegen.
// Schaetzwerte, Stand 2026-05.

interface ModelPricing {
  provider: string;
  modelIdPrefix: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok?: number;
}

const PRICING: readonly ModelPricing[] = [
  { provider: "anthropic", modelIdPrefix: "claude-opus-4", inputPerMTok: 15, outputPerMTok: 75, cacheReadPerMTok: 1.5 },
  { provider: "anthropic", modelIdPrefix: "claude-sonnet-4", inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  { provider: "anthropic", modelIdPrefix: "claude-haiku-4", inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
  { provider: "anthropic", modelIdPrefix: "claude-3-5-sonnet", inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  { provider: "anthropic", modelIdPrefix: "claude-3-5-haiku", inputPerMTok: 0.8, outputPerMTok: 4, cacheReadPerMTok: 0.08 },
  { provider: "openai", modelIdPrefix: "gpt-4o-mini", inputPerMTok: 0.15, outputPerMTok: 0.6, cacheReadPerMTok: 0.075 },
  { provider: "openai", modelIdPrefix: "gpt-4o", inputPerMTok: 2.5, outputPerMTok: 10, cacheReadPerMTok: 1.25 },
  { provider: "openai", modelIdPrefix: "gpt-5-mini", inputPerMTok: 0.25, outputPerMTok: 2, cacheReadPerMTok: 0.125 },
  { provider: "openai", modelIdPrefix: "gpt-5", inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.625 },
  { provider: "openai", modelIdPrefix: "o4-mini", inputPerMTok: 1.1, outputPerMTok: 4.4, cacheReadPerMTok: 0.275 },
  { provider: "google", modelIdPrefix: "gemini-2.5-pro", inputPerMTok: 1.25, outputPerMTok: 10, cacheReadPerMTok: 0.31 },
  { provider: "google", modelIdPrefix: "gemini-2.5-flash", inputPerMTok: 0.3, outputPerMTok: 2.5, cacheReadPerMTok: 0.075 },
  { provider: "google", modelIdPrefix: "gemini-2.0-flash", inputPerMTok: 0.1, outputPerMTok: 0.4 },
  { provider: "mistral", modelIdPrefix: "mistral-large", inputPerMTok: 2, outputPerMTok: 6 },
  { provider: "mistral", modelIdPrefix: "mistral-medium", inputPerMTok: 0.4, outputPerMTok: 2 },
  { provider: "mistral", modelIdPrefix: "mistral-small", inputPerMTok: 0.2, outputPerMTok: 0.6 },
];

export function findPricing(provider: string, modelId: string): ModelPricing | null {
  const c = PRICING.filter((p) => p.provider === provider && modelId.startsWith(p.modelIdPrefix));
  if (c.length === 0) return null;
  return c.reduce((b, x) => (x.modelIdPrefix.length > b.modelIdPrefix.length ? x : b));
}

/** Kosten in Mikro-USD (1e-6 USD); null, wenn das Modell unbekannt ist. */
export function estimateMicroUsd(args: {
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
}): number | null {
  if (!args.model) return null;
  const p = findPricing(args.provider, args.model);
  if (!p) return null;
  const M = 1_000_000;
  const cache = args.cacheReadTokens ?? 0;
  let usd = ((args.inputTokens - cache) / M) * p.inputPerMTok;
  usd += (args.outputTokens / M) * p.outputPerMTok;
  usd += (cache / M) * (p.cacheReadPerMTok ?? p.inputPerMTok);
  return Math.max(0, Math.round(usd * 1_000_000));
}
