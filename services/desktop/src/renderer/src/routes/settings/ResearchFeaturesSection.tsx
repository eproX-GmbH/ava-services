import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ResearchFeature,
  ResearchFeatureConfig,
  ResearchKeyMeta,
  ResearchProvider,
  ResearchSettingsBundle,
  ResearchTier,
} from "../../../../shared/types";

// v0.1.172 — Settings → Erweiterte Recherche-Funktionen.
//
// Per-feature config for the website producer's two cloud-LLM enrichment
// pipelines. See main/research/store.ts for the persistence layout and
// main/index.ts for the IPC surface.
//
// Strict-tier model (no cascade): deep means deep, never the standard
// model as a cheap pre-pass. The cost gap between standard and deep is
// roughly 10x (Anthropic) to 50x (OpenAI), so the switch to deep is
// gated by a confirm-modal with the per-provider cost range.

const FEATURE_META: Record<
  ResearchFeature,
  { title: string; subtitle: string }
> = {
  expansionTenders: {
    title: "Ausschreibungen, Expansion & Beschaffung",
    subtitle:
      "Findet öffentliche Tender, Expansionsankündigungen und Beschaffungsmeldungen zu einer Firma.",
  },
  jobPostings: {
    title: "Stellenanzeigen",
    subtitle:
      "Findet aktuelle Job-Angebote auf Karriereseite, LinkedIn, StepStone, Indeed etc.",
  },
};

const TIER_LABEL: Record<ResearchTier, string> = {
  off: "Aus",
  standard: "Standard",
  deep: "Deep Research",
};

// Cost rough estimates per firma -- shown under the tier choice as user
// guidance. Range, not precision; calibrated from real production runs
// (May 2026: SAP-Opus-Deep = $0.28, factor ~3× under my initial estimate
// because prompt-caching kicks in after the first call of a session).
const COST_PER_FIRMA: Record<ResearchProvider, Record<ResearchTier, string>> = {
  openai: { off: "0 €", standard: "~0,02 €", deep: "1–5 €" },
  anthropic: { off: "0 €", standard: "~0,10 €", deep: "0,25–0,80 €" },
};

const MODEL_LABEL: Record<ResearchProvider, Record<ResearchTier, string>> = {
  openai: {
    off: "—",
    standard: "gpt-5-mini + web_search_preview",
    deep: "o4-mini-deep-research-2025-06-26 + web_search",
  },
  anthropic: {
    off: "—",
    standard: "claude-sonnet-4-6 + web_search",
    deep: "claude-opus-4-7 + web_search + extended thinking",
  },
};

export function ResearchFeaturesSection() {
  const qc = useQueryClient();
  const { data: bundle } = useQuery({
    queryKey: ["research", "bundle"],
    queryFn: () => window.api.research.getBundle(),
  });

  // Live-sync: main pushes bundleChanged on any mutation.
  useEffect(() => {
    const dispose = window.api.research.onBundleChanged((next) => {
      qc.setQueryData(["research", "bundle"], next);
    });
    return () => {
      dispose();
    };
  }, [qc]);

  const [costModal, setCostModal] = useState<{
    feature: ResearchFeature;
    provider: ResearchProvider;
  } | null>(null);
  const [createKeyOpen, setCreateKeyOpen] = useState<ResearchProvider | null>(null);

  if (!bundle) {
    return (
      <section className="provider-section" id="research-features">
        <h2>Erweiterte Recherche-Funktionen</h2>
        <p className="muted small">Lädt…</p>
      </section>
    );
  }

  return (
    <section className="provider-section" id="research-features">
      <h2>Erweiterte Recherche-Funktionen</h2>
      <p className="muted small" style={{ marginTop: 4, marginBottom: 16 }}>
        Aktiviert zusätzliche LLM-gestützte Anreicherung pro Firma. Standard
        ist kostengünstig (~0,02–0,15 € je Firma), Deep Research dagegen
        gründlicher, aber spürbar teurer. Beide nutzen API-Keys, die du
        beim jeweiligen Anbieter selbst hinterlegst — AVA fakturiert
        nichts darüber.
        {!bundle.encryptionAvailable && (
          <span style={{ display: "block", color: "#b48800", marginTop: 8 }}>
            ⚠ Verschlüsselter Schlüssel-Speicher ist auf diesem System nicht
            verfügbar. Schlüssel werden mit Basic-Cipher gesichert (auf
            macOS / Windows entspricht das normalerweise dem Default; nur
            bei minimal-installierten Linux-Systemen ein Hinweis).
          </span>
        )}
      </p>

      {bundle.config.expansionTenders.tier === "off" &&
        bundle.config.jobPostings.tier === "off" && (
          <p
            className="muted small"
            style={{
              marginBottom: 16,
              padding: "8px 12px",
              background: "rgba(180,136,0,0.08)",
              borderLeft: "3px solid #b48800",
              borderRadius: 4,
            }}
          >
            Beide Funktionen sind aktuell <strong>deaktiviert</strong> — dann
            liefern „Stellenanzeigen" und „Deep Research" pro Firma keine
            Ergebnisse. Stell sie unten auf <strong>Standard</strong> (mit
            deinem hinterlegten Schlüssel), um sie zu nutzen.
          </p>
        )}

      {(["expansionTenders", "jobPostings"] as ResearchFeature[]).map(
        (feature) => (
          <FeatureCard
            key={feature}
            feature={feature}
            bundle={bundle}
            onRequestDeep={(provider) => setCostModal({ feature, provider })}
            onCreateKey={(provider) => setCreateKeyOpen(provider)}
          />
        ),
      )}

      {costModal && (
        <CostConfirmModal
          feature={costModal.feature}
          provider={costModal.provider}
          onCancel={() => setCostModal(null)}
          onConfirm={async () => {
            const featureCfg = bundle.config[costModal.feature];
            // Auto-pick the first available key for this provider if the
            // feature didn't have one yet; otherwise keep the current one.
            const keyId =
              featureCfg.keyId ??
              defaultKeyIdFor(bundle, costModal.provider);
            if (!keyId) {
              alert(
                `Kein ${costModal.provider}-Schlüssel hinterlegt. Bitte erst einen Schlüssel anlegen.`,
              );
              return;
            }
            await window.api.research.setFeatureConfig({
              feature: costModal.feature,
              partial: { tier: "deep", provider: costModal.provider, keyId },
            });
            setCostModal(null);
          }}
        />
      )}

      {createKeyOpen && (
        <CreateKeyModal
          provider={createKeyOpen}
          onClose={() => setCreateKeyOpen(null)}
        />
      )}
    </section>
  );
}

// ---- FeatureCard ----------------------------------------------------------

function FeatureCard({
  feature,
  bundle,
  onRequestDeep,
  onCreateKey,
}: {
  feature: ResearchFeature;
  bundle: ResearchSettingsBundle;
  onRequestDeep: (provider: ResearchProvider) => void;
  onCreateKey: (provider: ResearchProvider) => void;
}) {
  const cfg = bundle.config[feature];
  const meta = FEATURE_META[feature];
  const setConfig = useSetFeatureConfig();

  const onTierClick = (tier: ResearchTier) => {
    if (tier === cfg.tier) return;
    if (tier === "off") {
      void setConfig.mutateAsync({ feature, partial: { tier: "off" } });
      return;
    }
    const provider: ResearchProvider = cfg.provider ?? "openai";
    if (tier === "deep") {
      // Gate behind cost modal.
      onRequestDeep(provider);
      return;
    }
    // Standard: switch directly (cheap enough that no confirm is needed).
    const keyId = cfg.keyId ?? defaultKeyIdFor(bundle, provider);
    if (!keyId) {
      // No key for this provider yet. Open the create-key modal; user can
      // re-pick standard after saving the key.
      onCreateKey(provider);
      return;
    }
    void setConfig.mutateAsync({
      feature,
      partial: { tier: "standard", provider, keyId },
    });
  };

  const onProviderChange = (provider: ResearchProvider) => {
    if (provider === cfg.provider) return;
    const keyId = defaultKeyIdFor(bundle, provider);
    if (!keyId) {
      onCreateKey(provider);
      return;
    }
    void setConfig.mutateAsync({
      feature,
      partial: { tier: cfg.tier, provider, keyId },
    });
  };

  const onKeyChange = (keyId: string) => {
    if (keyId === cfg.keyId) return;
    void setConfig.mutateAsync({ feature, partial: { keyId } });
  };

  return (
    <div className="research-feature-card">
      <div>
        <h4 className="research-feature-card__title">{meta.title}</h4>
        <p className="research-feature-card__subtitle">{meta.subtitle}</p>
      </div>

      <div className="research-feature-card__row">
        <span className="research-feature-card__label">Modus</span>
        {(["off", "standard", "deep"] as ResearchTier[]).map((tier) => (
          <label key={tier} className="research-feature-card__tier-choice">
            <input
              type="radio"
              name={`tier-${feature}`}
              checked={cfg.tier === tier}
              onChange={() => onTierClick(tier)}
            />
            <span>{TIER_LABEL[tier]}</span>
          </label>
        ))}
      </div>

      {cfg.tier !== "off" && cfg.provider && (
        <>
          <div className="research-feature-card__row">
            <span className="research-feature-card__label">Anbieter</span>
            <select
              value={cfg.provider}
              onChange={(e) => onProviderChange(e.target.value as ResearchProvider)}
            >
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
            </select>
            <span className="research-feature-card__model-hint">
              Modell: {MODEL_LABEL[cfg.provider][cfg.tier]}
            </span>
          </div>

          <KeyPicker
            feature={feature}
            cfg={cfg}
            bundle={bundle}
            onChange={onKeyChange}
            onCreateKey={() => onCreateKey(cfg.provider!)}
          />

          <p className="research-feature-card__cost">
            Geschätzte Kosten:{" "}
            <strong>{COST_PER_FIRMA[cfg.provider][cfg.tier]} je Firma</strong>{" "}
            (wird direkt deinem{" "}
            {cfg.provider === "openai" ? "OpenAI" : "Anthropic"}-Konto belastet).
          </p>
        </>
      )}
    </div>
  );
}

// ---- KeyPicker ------------------------------------------------------------

function KeyPicker({
  feature,
  cfg,
  bundle,
  onChange,
  onCreateKey,
}: {
  feature: ResearchFeature;
  cfg: ResearchFeatureConfig;
  bundle: ResearchSettingsBundle;
  onChange: (keyId: string) => void;
  onCreateKey: () => void;
}) {
  if (!cfg.provider) return null;
  const provider = cfg.provider;

  const availableKeys = useMemo(() => {
    const out: Array<{ id: string; label: string; hint?: string }> = [];
    if (provider === "openai" && bundle.globals.openai) {
      out.push({
        id: "global:openai",
        label: "Allgemeine Modell-Konfiguration",
      });
    }
    if (provider === "anthropic" && bundle.globals.anthropic) {
      out.push({
        id: "global:anthropic",
        label: "Allgemeine Modell-Konfiguration",
      });
    }
    for (const k of bundle.keys) {
      if (k.provider !== provider) continue;
      out.push({ id: k.id, label: k.label, hint: k.keyHint });
    }
    return out;
  }, [bundle, provider]);

  const sharingNote = useSharingNote(bundle, cfg.keyId);
  const probe = useProbeKey();

  return (
    <div className="research-feature-card__row">
      <span className="research-feature-card__label">Schlüssel</span>
      <select
        value={cfg.keyId ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ minWidth: 280 }}
      >
        {availableKeys.length === 0 && (
          <option value="">— kein {provider}-Schlüssel hinterlegt —</option>
        )}
        {availableKeys.map((k) => (
          <option key={k.id} value={k.id}>
            {k.label}
            {k.hint ? ` (${k.hint})` : ""}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="link"
        onClick={onCreateKey}
        title="Eigenen Key für dieses Feature anlegen"
      >
        + neuer Schlüssel
      </button>
      {cfg.keyId && (
        <button
          type="button"
          onClick={() => probe.mutate(cfg.keyId!)}
          disabled={probe.isPending}
          title="Probe-Call gegen den Anbieter, um zu prüfen ob der Schlüssel funktioniert."
        >
          {probe.isPending
            ? "Testet…"
            : probe.data?.ok === true
              ? `✓ ${probe.data.latencyMs}ms`
              : probe.data?.ok === false
                ? "✗ Fehler"
                : "Test"}
        </button>
      )}
      {probe.data?.ok === false && (
        <span className="error small">{probe.data.error}</span>
      )}
      {sharingNote && (
        <p className="research-feature-card__sharing">{sharingNote}</p>
      )}
    </div>
  );
}

function useSharingNote(
  bundle: ResearchSettingsBundle,
  keyId: string | null,
): string | null {
  if (!keyId) return null;
  const otherFeatures = (
    ["expansionTenders", "jobPostings"] as ResearchFeature[]
  ).filter((f) => bundle.config[f].keyId === keyId);
  if (otherFeatures.length <= 1) return null;
  const others = otherFeatures.filter(
    (f) => f !== otherFeatures[0],
  );
  if (keyId === "global:openai" || keyId === "global:anthropic") {
    return `Dieser Schlüssel wird auch von „Allgemeine Modell-Konfiguration" verwaltet — Änderungen dort wirken sich hier aus.`;
  }
  if (others.length > 0) {
    return `Dieser Schlüssel wird auch von „${others.map((f) => FEATURE_META[f].title).join(", ")}" verwendet.`;
  }
  return null;
}

// ---- Cost-Warning Modal ---------------------------------------------------

function CostConfirmModal({
  feature,
  provider,
  onCancel,
  onConfirm,
}: {
  feature: ResearchFeature;
  provider: ResearchProvider;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const costRange = COST_PER_FIRMA[provider].deep;
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-color, #fff)",
          padding: 24,
          borderRadius: 8,
          maxWidth: 480,
          boxShadow: "0 4px 24px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>Achtung: hohe API-Kosten</h3>
        <p>
          Deep Research ist ein aufwendiger, mehrstufiger Recherche-Prozess.
          Bei {provider === "openai" ? "OpenAI" : "Anthropic"} können pro
          analysierter Firma <strong>{costRange}</strong> an API-Gebühren
          anfallen.
        </p>
        <p className="muted small">
          Diese Kosten werden direkt deinem{" "}
          {provider === "openai" ? "OpenAI" : "Anthropic"}-Konto belastet,
          nicht von AVA übernommen. Für {FEATURE_META[feature].title}: einmal
          ausgelöst pro Firma, im Hintergrund.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onCancel}>
            Abbrechen
          </button>
          <button type="button" onClick={onConfirm} style={{ fontWeight: 600 }}>
            Ich verstehe, aktivieren
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Create-Key Modal -----------------------------------------------------

function CreateKeyModal({
  provider,
  onClose,
}: {
  provider: ResearchProvider;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [plaintext, setPlaintext] = useState("");
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () =>
      window.api.research.createKey({ provider, label, plaintext }),
    onSuccess: (res) => {
      qc.setQueryData(["research", "bundle"], res.bundle);
      onClose();
    },
  });

  const expectedPrefix = provider === "openai" ? "sk-" : "sk-ant-api03-";
  const formatHint = provider === "openai"
    ? "OpenAI-Keys beginnen mit „sk-"
    : "Nur API-Keys (sk-ant-api03-…). OAuth-Subscription-Tokens sind aus rechtlichen Gründen nicht erlaubt — siehe Anthropic ToS.";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg-color, #fff)",
          padding: 24,
          borderRadius: 8,
          maxWidth: 520,
          minWidth: 400,
          boxShadow: "0 4px 24px rgba(0,0,0,0.2)",
        }}
      >
        <h3 style={{ marginTop: 0 }}>
          Neuen {provider === "openai" ? "OpenAI" : "Anthropic"}-Schlüssel
          hinterlegen
        </h3>
        <p className="muted small">{formatHint}</p>
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <label>
            <span className="api-key-label">Bezeichnung</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="z.B. Mein Production-Key"
              style={{ width: "100%" }}
            />
          </label>
          <label>
            <span className="api-key-label">Schlüssel</span>
            <input
              type="password"
              value={plaintext}
              onChange={(e) => setPlaintext(e.target.value)}
              placeholder={`${expectedPrefix}…`}
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%" }}
            />
          </label>
        </div>
        {create.error && (
          <p className="error small">{(create.error as Error).message}</p>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" onClick={onClose}>
            Abbrechen
          </button>
          <button
            type="button"
            onClick={() => create.mutate()}
            disabled={!plaintext.trim() || create.isPending}
            style={{ fontWeight: 600 }}
          >
            {create.isPending ? "Speichert…" : "Speichern"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Helpers --------------------------------------------------------------

function defaultKeyIdFor(
  bundle: ResearchSettingsBundle,
  provider: ResearchProvider,
): string | null {
  // Prefer the "Allgemeine Modell-Konfiguration"-Key (shared by reference)
  // if available -- it's the most likely source the user wants. Falls
  // back to the first matching research-owned key.
  if (provider === "openai" && bundle.globals.openai) return "global:openai";
  if (provider === "anthropic" && bundle.globals.anthropic) return "global:anthropic";
  const own = bundle.keys.find((k) => k.provider === provider);
  return own?.id ?? null;
}

function useSetFeatureConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      feature: ResearchFeature;
      partial: {
        tier?: ResearchTier;
        provider?: ResearchProvider | null;
        keyId?: string | null;
      };
    }) => window.api.research.setFeatureConfig(args),
    onSuccess: (bundle) => qc.setQueryData(["research", "bundle"], bundle),
  });
}

function useProbeKey() {
  return useMutation({
    mutationFn: (keyId: string) => window.api.research.probeKey(keyId),
  });
}
