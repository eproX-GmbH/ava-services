// v0.1.622 (Operator 2026-09-09): Workflows per Chat anlegen/aendern nur mit
// einem Chat-Modell der Stufe S (docs/MODEL_TIERS.md). Schwaechere Modelle
// liefern beim Bauen von Graphen, Expressions und Parametern zu oft
// unvollstaendige oder erfundene Konfiguration. Der Editor bleibt frei;
// Starten, Freigaben, Vorlagen und Lesen ebenfalls.

import { tierForModel } from "@ava/ai-provider";

export const S_TIER = 4;

export interface ModellstufenBefund {
  erlaubt: boolean;
  tier: number | null;
  provider: string;
  model: string | null;
  /** Meldung fuer Agent/Nutzer, wenn nicht erlaubt. */
  meldung: string | null;
}

export function pruefeModellstufe(provider: string, model: string | null): ModellstufenBefund {
  const tier = model ? tierForModel(provider, model) : null;
  if (tier !== null && tier >= S_TIER) return { erlaubt: true, tier, provider, model, meldung: null };
  const stufe = tier === null ? "unbekannte Stufe" : `Stufe ${["", "C", "B", "A", "S"][tier] ?? tier}`;
  return {
    erlaubt: false,
    tier,
    provider,
    model,
    meldung:
      `Workflows anlegen oder aendern per Chat ist blockiert: Dafuer ist ein Chat-Modell der Stufe S noetig (z. B. Claude Opus/Fable, GPT-5.6 Sol/Terra, GPT-5.5), ` +
      `aktuell laeuft ${model ?? "kein Modell"} (${provider}, ${stufe}). Bitte in den Einstellungen ein staerkeres Modell waehlen — oder den Workflow im Editor unter Vorgaenge → Workflows von Hand anlegen. ` +
      `Starten, Freigaben und Vorlagen funktionieren mit jedem Modell.`,
  };
}
