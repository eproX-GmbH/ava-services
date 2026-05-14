// v0.1.179 — shared cost estimator for the research features.
//
// Used by:
//   1. The Settings → Erweiterte Recherche-Funktionen panel
//      (`ResearchFeaturesSection`) — shows per-firma cost under each
//      feature card.
//   2. The Import-Confirm modal (UI Ingest) and the chat-tool
//      `import_excel` gate — both show the expected TOTAL cost for
//      an N-company batch so the user can decide whether to skip the
//      research features for that import.
//
// The numbers are deliberately rough ranges. Sources:
//   • openai/standard  — gpt-5-mini + web_search_preview, ~0.02 €/firma
//     (production observation, ~2k input + 0.5k output tokens per call)
//   • openai/deep      — o4-mini-deep-research-2025-06-26 + web_search,
//     1–5 €/firma (no production data yet; OpenAI's own docs cite
//     "complex multi-turn research" pricing in that band)
//   • anthropic/standard — claude-sonnet-4-6 + web_search, 0.08–0.15 €
//     (Phase 2a smoke-test calibrated, single-turn)
//   • anthropic/deep   — claude-opus-4-7 + web_search + extended
//     thinking, observed $0.28 on SAP SE, ~0.25–0.80 €/firma
//
// Update these constants together with the corresponding strings in
// ResearchFeaturesSection.tsx (look for `COST_PER_FIRMA` there too --
// kept in sync manually for now; the section uses a string-format
// label, this module uses raw numbers for arithmetic).

import type {
  ResearchFeature,
  ResearchFeaturesConfig,
  ResearchProvider,
  ResearchTier,
} from "./types";

export interface CostRange {
  min: number;
  max: number;
}

export const COST_PER_FIRMA: Record<
  ResearchProvider,
  Record<ResearchTier, CostRange>
> = {
  openai: {
    off: { min: 0, max: 0 },
    standard: { min: 0.02, max: 0.05 },
    deep: { min: 1.0, max: 5.0 },
  },
  anthropic: {
    off: { min: 0, max: 0 },
    standard: { min: 0.08, max: 0.15 },
    deep: { min: 0.25, max: 0.8 },
  },
};

export const FEATURE_LABEL: Record<ResearchFeature, string> = {
  expansionTenders: "Ausschreibungen, Expansion & Beschaffung",
  jobPostings: "Stellenanzeigen",
};

export interface ActiveFeatureInfo {
  feature: ResearchFeature;
  provider: ResearchProvider;
  tier: ResearchTier;
  perFirma: CostRange;
}

/**
 * Filter the config to features that will actually run (tier !== "off"
 * AND provider + keyId are set). Order is stable
 * [expansionTenders, jobPostings] so any UI listing reads the same
 * order as Settings.
 */
export function getActiveResearchFeatures(
  cfg: ResearchFeaturesConfig,
): ActiveFeatureInfo[] {
  const out: ActiveFeatureInfo[] = [];
  for (const f of ["expansionTenders", "jobPostings"] as const) {
    const c = cfg[f];
    if (c.tier === "off" || !c.provider || !c.keyId) continue;
    out.push({
      feature: f,
      provider: c.provider,
      tier: c.tier,
      perFirma: COST_PER_FIRMA[c.provider][c.tier],
    });
  }
  return out;
}

export interface ImportCostEstimate {
  perFeature: Array<ActiveFeatureInfo & { total: CostRange }>;
  total: CostRange;
}

/**
 * Multiply each active feature's per-firma range by the import row
 * count and sum across features. Returns null if no features are
 * active -- callers can use that to skip the confirmation modal
 * entirely.
 */
export function estimateImportCost(
  cfg: ResearchFeaturesConfig,
  companyCount: number,
): ImportCostEstimate | null {
  const active = getActiveResearchFeatures(cfg);
  if (active.length === 0) return null;
  const perFeature = active.map((a) => ({
    ...a,
    total: {
      min: a.perFirma.min * companyCount,
      max: a.perFirma.max * companyCount,
    },
  }));
  const total: CostRange = {
    min: perFeature.reduce((s, p) => s + p.total.min, 0),
    max: perFeature.reduce((s, p) => s + p.total.max, 0),
  };
  return { perFeature, total };
}

/**
 * Format a euro amount for German UI: "≈ 0,02 €", "≈ 1 – 5 €",
 * "≈ 371 – 1.685 €" -- range collapses to a single value when min
 * and max round to the same integer; otherwise shown with the wider
 * range. Numbers < 1 € keep two decimals (Cents matter at the per-
 * firma scale); ≥ 1 € round to integer for the totals view.
 */
export function formatEuroRange(range: CostRange, opts?: { perFirma?: boolean }): string {
  const perFirma = opts?.perFirma ?? false;
  const fmt = (n: number) => {
    if (perFirma || n < 1) {
      // Cents precision
      return n.toLocaleString("de-DE", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
    return Math.round(n).toLocaleString("de-DE");
  };
  const a = fmt(range.min);
  const b = fmt(range.max);
  if (a === b) return `≈ ${a} €`;
  return `≈ ${a} – ${b} €`;
}
