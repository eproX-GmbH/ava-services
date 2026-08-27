import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type {
  ProviderCatalogEntry,
  ProviderConfigBundle,
} from "../../../shared/types";

// v0.1.422 — Hinweis, wenn die Hintergrund-Verarbeitung auf einem starken
// (teuren, langsamen) Modell läuft.
//
// Die Producer schicken tausende Textblöcke pro Firma durch das Modell —
// ein Jahresabschluss allein kann über 1.000 Abschnitte haben. Läuft das
// auf einem Frontier-/Reasoning-Modell, kostet ein einziger Durchlauf ein
// Vielfaches und dauert entsprechend. Ohne diesen Hinweis merkt man es
// erst an der Rechnung.
//
// Auslöser bewusst eng: nur wenn KEIN eigenes Producer-Modell gesetzt ist
// UND das aktive Modell wirklich schwer ist (Tier 4 oder Kostenklasse
// "high"). Ein Mittelklasse-Modell loest nichts aus.

export function ProducerModelBanner() {
  const cfg = useQuery<ProviderConfigBundle>({
    queryKey: ["agent", "providerConfig"],
    queryFn: () => window.api.agent.getProviderConfig(),
    staleTime: 60_000,
  });
  const models = useQuery<ProviderCatalogEntry[]>({
    queryKey: ["agent", "models"],
    queryFn: () => window.api.agent.listModels(),
    staleTime: 5 * 60_000,
  });

  if (!cfg.data || !models.data) return null;

  const kind = cfg.data.config.kind;
  // Eigenes Producer-Modell gesetzt → alles gut, nichts melden.
  const override = cfg.data.config.producerModels?.[kind];
  if (override && override.trim().length > 0) return null;

  const activeModelId = cfg.data.status.model ?? cfg.data.config.models[kind];
  if (!activeModelId) return null;

  const entry = models.data.find(
    (m) => m.provider === kind && m.id === activeModelId,
  );
  if (!entry) return null;

  const heavy = entry.tier >= 4 || entry.costClass === "high";
  if (!heavy) return null;

  return (
    <div className="producer-model-banner" role="status">
      <span className="producer-model-banner__icon" aria-hidden>
        💸
      </span>
      <p className="producer-model-banner__msg">
        Die Hintergrund-Verarbeitung läuft auf <strong>{entry.label}</strong> —
        einem starken Modell. Jahresabschlüsse haben oft über 1.000 Abschnitte,
        die einzeln analysiert werden; ein günstiges, schnelles Modell ist dafür
        meist die bessere Wahl.
      </p>
      <Link to="/settings/modelle#provider-section" className="producer-model-banner__cta">
        Modell wählen
      </Link>
    </div>
  );
}
