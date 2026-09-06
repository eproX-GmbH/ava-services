// Deep-Research-faehige OpenAI-Modelle (Responses-API mit web_search).
// Bewusst fester Satz statt Katalog: Deep Research ist OpenAI-exklusiv,
// und nur diese Modelle beherrschen den mehrstufigen Recherchelauf.
export const DEEP_RESEARCH_MODELS: ReadonlyArray<{ id: string; label: string; hinweis: string }> = [
  { id: "o4-mini-deep-research-2025-06-26", label: "o4-mini Deep Research", hinweis: "Standard — schneller, guenstiger (ca. 1–5 € je Firma)" },
  { id: "o3-deep-research-2025-06-26", label: "o3 Deep Research", hinweis: "gruendlicher, deutlich teurer und langsamer" },
];
export const DEFAULT_DEEP_RESEARCH_MODEL = DEEP_RESEARCH_MODELS[0]!.id;
/** Pseudo-Schluessel-ID: Research laeuft ueber den OpenAI-Schluessel der Organisation (Gateway-Proxy). */
export const RESEARCH_ORG_OPENAI_KEY_ID = "org:openai";
