import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  ResearchFeaturesConfig,
  ResearchFeature,
  ResearchFeatureConfig,
  ResearchKeyMeta,
  ResearchProvider,
  ResearchTier,
} from "../../shared/types";
import { ProviderConfigStore } from "../agent/providers/store";

/**
 * v0.1.172 Settings Phase A+E — research-features persistence.
 *
 * Files under `app.getPath("userData")/research/`:
 *
 *   features.json
 *     {
 *       "expansionTenders": { "tier": "off|standard|deep", "provider": null|"openai"|"anthropic", "keyId": null|<id> },
 *       "jobPostings":      { ...same shape }
 *     }
 *     Plain JSON; atomic write.
 *
 *   keys/<uuid>.enc
 *     safeStorage.encryptString(plaintextKey) -- one per research-owned key.
 *
 *   keys/<uuid>.meta.json
 *     {
 *       "id": "<uuid>", "provider": "openai|anthropic", "label": "...",
 *       "createdAt": <epoch>, "lastUsedAt": null, "lastProbeOk": null,
 *       "lastProbeAt": null, "keyHint": "...aB9c"
 *     }
 *
 * keyId values inside features.json may also be the literal strings
 * `"global:openai"` or `"global:anthropic"` — those are pointer aliases
 * to the existing ProviderConfigStore keys (the "Allgemeine Modell-
 * Konfiguration" key from the chat-agent Settings). Selecting "Übernehmen
 * aus Allgemeiner Modell-Konfiguration" sets the keyId to one of those
 * sentinels, keeping the feature in sync with the chat-agent key.
 */

const FEATURES_FILENAME = "features.json";
const KEYS_DIRNAME = "keys";
const GLOBAL_OPENAI = "global:openai";
const GLOBAL_ANTHROPIC = "global:anthropic";

const VALID_TIERS: readonly ResearchTier[] = ["off", "standard", "deep"];
const VALID_PROVIDERS: readonly ResearchProvider[] = ["openai", "anthropic"];
const VALID_FEATURES: readonly ResearchFeature[] = ["expansionTenders", "jobPostings"];

const DEFAULT_FEATURE: ResearchFeatureConfig = { tier: "off", provider: null, keyId: null };
const DEFAULT_CONFIG: ResearchFeaturesConfig = {
  expansionTenders: { ...DEFAULT_FEATURE },
  jobPostings: { ...DEFAULT_FEATURE },
};

export type { ResearchFeaturesConfig, ResearchKeyMeta };

export interface ResearchFeaturesStoreEvents {
  configChanged: (cfg: ResearchFeaturesConfig) => void;
  keysChanged: (keys: ResearchKeyMeta[]) => void;
}

export declare interface ResearchFeaturesStore {
  on<E extends keyof ResearchFeaturesStoreEvents>(
    event: E,
    listener: ResearchFeaturesStoreEvents[E],
  ): this;
  emit<E extends keyof ResearchFeaturesStoreEvents>(
    event: E,
    ...args: Parameters<ResearchFeaturesStoreEvents[E]>
  ): boolean;
}

export class ResearchFeaturesStore extends EventEmitter {
  private static instance: ResearchFeaturesStore | null = null;
  private readonly dir: string;
  private readonly keysDir: string;
  private readonly configPath: string;
  private cached: ResearchFeaturesConfig;

  private constructor() {
    super();
    this.dir = join(app.getPath("userData"), "research");
    this.keysDir = join(this.dir, KEYS_DIRNAME);
    this.configPath = join(this.dir, FEATURES_FILENAME);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.keysDir)) mkdirSync(this.keysDir, { recursive: true });

    const fresh = !existsSync(this.configPath);
    this.cached = this.readConfigFromDisk();

    // Phase E migration: on first boot of this version, if there's no
    // features.json yet AND the chat-agent ProviderConfigStore has an
    // OpenAI key, default both features to tier=standard / provider=openai /
    // keyId="global:openai". Deep tier intentionally stays off so the
    // user has to opt in to the cost-warning modal explicitly.
    if (fresh) {
      const pcs = ProviderConfigStore.shared();
      if (pcs.hasKey("openai")) {
        const migrated: ResearchFeaturesConfig = {
          expansionTenders: { tier: "standard", provider: "openai", keyId: GLOBAL_OPENAI },
          jobPostings: { tier: "standard", provider: "openai", keyId: GLOBAL_OPENAI },
        };
        this.writeConfigAtomic(migrated);
        this.cached = migrated;
        console.info(
          "[research-store] Phase-E migration: openai key found in ProviderConfigStore, " +
            "both research features auto-enabled at tier=standard (deep stays off pending user opt-in).",
        );
      } else if (pcs.hasKey("anthropic")) {
        // Anthropic-only install: mirror behavior with the anthropic key.
        const migrated: ResearchFeaturesConfig = {
          expansionTenders: { tier: "standard", provider: "anthropic", keyId: GLOBAL_ANTHROPIC },
          jobPostings: { tier: "standard", provider: "anthropic", keyId: GLOBAL_ANTHROPIC },
        };
        this.writeConfigAtomic(migrated);
        this.cached = migrated;
        console.info(
          "[research-store] Phase-E migration: anthropic key found, both research features auto-enabled at tier=standard.",
        );
      }
    }
  }

  static shared(): ResearchFeaturesStore {
    if (!this.instance) this.instance = new ResearchFeaturesStore();
    return this.instance;
  }

  /** Test hook -- recreate singleton with a fresh store backing. Production code MUST NOT call this. */
  static __resetForTests(): void {
    this.instance = null;
  }

  // ---- Config --------------------------------------------------------------

  getConfig(): ResearchFeaturesConfig {
    return cloneConfig(this.cached);
  }

  /**
   * Patch a single feature's config. Validates the {tier, provider, keyId}
   * triple as a whole -- e.g. tier="standard" without a keyId is rejected
   * (renderer is expected to gate UI so this only triggers on bad IPC).
   */
  setFeatureConfig(feature: ResearchFeature, partial: Partial<ResearchFeatureConfig>): ResearchFeaturesConfig {
    if (!VALID_FEATURES.includes(feature)) {
      throw new Error(`unknown research feature: ${String(feature)}`);
    }
    const next: ResearchFeaturesConfig = cloneConfig(this.cached);
    const merged: ResearchFeatureConfig = { ...next[feature], ...partial };

    if (!VALID_TIERS.includes(merged.tier)) {
      throw new Error(`invalid tier "${String(merged.tier)}"`);
    }
    if (merged.tier === "off") {
      // Off normalizes -- forget provider/keyId so we don't leak orphan
      // references on re-enable.
      merged.provider = null;
      merged.keyId = null;
    } else {
      if (!merged.provider || !VALID_PROVIDERS.includes(merged.provider)) {
        throw new Error(`tier=${merged.tier} requires a valid provider (got "${merged.provider}")`);
      }
      if (!merged.keyId) {
        throw new Error(`tier=${merged.tier} requires a keyId`);
      }
      // Cross-check: keyId's provider must match feature.provider so we
      // don't accidentally pass an Anthropic key to OpenAI.
      const keyProvider = this.resolveKeyProvider(merged.keyId);
      if (keyProvider && keyProvider !== merged.provider) {
        throw new Error(
          `keyId "${merged.keyId}" is for provider="${keyProvider}" but feature requests provider="${merged.provider}"`,
        );
      }
    }

    next[feature] = merged;
    this.writeConfigAtomic(next);
    this.cached = next;
    this.emit("configChanged", cloneConfig(next));
    return cloneConfig(next);
  }

  // ---- Key registry --------------------------------------------------------

  listKeys(): ResearchKeyMeta[] {
    if (!existsSync(this.keysDir)) return [];
    const out: ResearchKeyMeta[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.keysDir);
    } catch {
      return [];
    }
    for (const f of entries) {
      if (!f.endsWith(".meta.json")) continue;
      try {
        const raw = readFileSync(join(this.keysDir, f), "utf8");
        const meta = JSON.parse(raw) as ResearchKeyMeta;
        // Sanity: ensure the .enc file actually exists; if not the meta is
        // orphan -- skip but don't auto-delete (deletion is a user choice).
        if (!existsSync(join(this.keysDir, `${meta.id}.enc`))) continue;
        out.push(meta);
      } catch (err) {
        console.warn(`[research-store] couldn't read key meta ${f}:`, err);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Create a new research-owned key. Returns the new keyId.
   * `provider` must match the key format (basic sanity, not crypto-strong).
   */
  createKey(opts: { provider: ResearchProvider; label: string; plaintext: string }): string {
    const { provider, label } = opts;
    const plaintext = opts.plaintext.trim();
    if (!plaintext) throw new Error("key plaintext is empty");
    if (!VALID_PROVIDERS.includes(provider)) {
      throw new Error(`invalid provider "${String(provider)}"`);
    }
    // Soft format check (does not crypto-validate the key, just catches
    // obvious paste errors like swapped providers).
    if (provider === "openai" && !plaintext.startsWith("sk-")) {
      console.warn("[research-store] OpenAI key doesn't start with 'sk-' -- may be invalid");
    }
    if (provider === "anthropic" && !plaintext.startsWith("sk-ant-api03-")) {
      console.warn(
        "[research-store] Anthropic key doesn't start with 'sk-ant-api03-' -- only API keys allowed (OAuth subscription tokens are ToS-restricted to Claude Code).",
      );
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn("[research-store] safeStorage unavailable -- falling back to basic cipher");
    }
    const id = randomUUID();
    const enc = safeStorage.encryptString(plaintext);
    const tail = plaintext.slice(-4);
    const meta: ResearchKeyMeta = {
      id,
      provider,
      label: label.trim() || `${provider} key`,
      createdAt: Date.now(),
      lastUsedAt: null,
      lastProbeOk: null,
      lastProbeAt: null,
      keyHint: `…${tail}`,
    };
    writeFileSync(join(this.keysDir, `${id}.enc`), enc, { mode: 0o600 });
    writeFileSync(join(this.keysDir, `${id}.meta.json`), JSON.stringify(meta, null, 2), {
      mode: 0o600,
    });
    this.emit("keysChanged", this.listKeys());
    return id;
  }

  /**
   * Delete a research-owned key. Returns the features that were detached
   * from it (their tier auto-resets to "off" so we don't leave a config
   * pointing at nonexistent keyId).
   */
  deleteKey(keyId: string): { detachedFeatures: ResearchFeature[] } {
    if (keyId === GLOBAL_OPENAI || keyId === GLOBAL_ANTHROPIC) {
      throw new Error("global:* keys are managed via the chat-agent settings, not deletable from here");
    }
    const enc = join(this.keysDir, `${keyId}.enc`);
    const meta = join(this.keysDir, `${keyId}.meta.json`);
    for (const p of [enc, meta]) {
      if (existsSync(p)) {
        try {
          unlinkSync(p);
        } catch (err) {
          console.warn(`[research-store] delete ${p} failed:`, err);
        }
      }
    }
    const detached: ResearchFeature[] = [];
    const next: ResearchFeaturesConfig = cloneConfig(this.cached);
    for (const f of VALID_FEATURES) {
      if (next[f].keyId === keyId) {
        next[f] = { tier: "off", provider: null, keyId: null };
        detached.push(f);
      }
    }
    if (detached.length > 0) {
      this.writeConfigAtomic(next);
      this.cached = next;
      this.emit("configChanged", cloneConfig(next));
    }
    this.emit("keysChanged", this.listKeys());
    return { detachedFeatures: detached };
  }

  /** Returns the features currently referencing keyId (incl. global:*). */
  featuresUsingKey(keyId: string): ResearchFeature[] {
    return VALID_FEATURES.filter((f) => this.cached[f].keyId === keyId);
  }

  // ---- Resolution (called by main from producer-supervisor) -----------------

  /**
   * Resolve a feature's config to (tier, provider, plaintext-key) ready to
   * pass as RESEARCH_*_TIER / _PROVIDER / _API_KEY env vars to the website
   * producer. Returns null if the feature is off or the key cannot be
   * decrypted.
   *
   * For `global:*` keyIds, defers to ProviderConfigStore.getKey(...).
   */
  async resolveFeature(feature: ResearchFeature): Promise<{
    tier: ResearchTier;
    provider: ResearchProvider;
    apiKey: string;
  } | null> {
    const cfg = this.cached[feature];
    if (cfg.tier === "off" || !cfg.provider || !cfg.keyId) return null;

    let plaintext: string | null = null;

    if (cfg.keyId === GLOBAL_OPENAI) {
      plaintext = await ProviderConfigStore.shared().getKey("openai");
    } else if (cfg.keyId === GLOBAL_ANTHROPIC) {
      plaintext = await ProviderConfigStore.shared().getKey("anthropic");
    } else {
      const path = join(this.keysDir, `${cfg.keyId}.enc`);
      if (!existsSync(path)) {
        console.warn(`[research-store] feature=${feature} keyId=${cfg.keyId} .enc missing`);
        return null;
      }
      try {
        const buf = readFileSync(path);
        plaintext = safeStorage.decryptString(buf);
      } catch (err) {
        console.warn(`[research-store] decrypt failed for keyId=${cfg.keyId}:`, err);
        return null;
      }
    }

    if (!plaintext) {
      console.warn(`[research-store] feature=${feature} resolved keyId=${cfg.keyId} to null`);
      return null;
    }

    this.markUsed(cfg.keyId);
    return { tier: cfg.tier, provider: cfg.provider, apiKey: plaintext };
  }

  // ---- Probe support (Phase G) ---------------------------------------------

  /**
   * Read the plaintext key behind a keyId. ONLY for use by the in-main
   * probe handler -- this must NEVER cross the IPC boundary to the
   * renderer. The handler does a 1-token round-trip against the
   * provider and reports ok/error, not the plaintext.
   */
  async __getPlaintextKeyForProbe(keyId: string): Promise<string | null> {
    if (keyId === GLOBAL_OPENAI) return ProviderConfigStore.shared().getKey("openai");
    if (keyId === GLOBAL_ANTHROPIC) return ProviderConfigStore.shared().getKey("anthropic");
    const path = join(this.keysDir, `${keyId}.enc`);
    if (!existsSync(path)) return null;
    try {
      return safeStorage.decryptString(readFileSync(path));
    } catch {
      return null;
    }
  }

  markProbeResult(keyId: string, ok: boolean): void {
    if (keyId === GLOBAL_OPENAI || keyId === GLOBAL_ANTHROPIC) return;
    const path = join(this.keysDir, `${keyId}.meta.json`);
    if (!existsSync(path)) return;
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as ResearchKeyMeta;
      meta.lastProbeOk = ok;
      meta.lastProbeAt = Date.now();
      writeFileSync(path, JSON.stringify(meta, null, 2), { mode: 0o600 });
      this.emit("keysChanged", this.listKeys());
    } catch (err) {
      console.warn(`[research-store] markProbeResult write failed for ${keyId}:`, err);
    }
  }

  // ---- Internals -----------------------------------------------------------

  private markUsed(keyId: string): void {
    if (keyId === GLOBAL_OPENAI || keyId === GLOBAL_ANTHROPIC) return;
    const path = join(this.keysDir, `${keyId}.meta.json`);
    if (!existsSync(path)) return;
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as ResearchKeyMeta;
      meta.lastUsedAt = Date.now();
      writeFileSync(path, JSON.stringify(meta, null, 2), { mode: 0o600 });
      // Don't emit keysChanged on every use -- too noisy, and the meta
      // is read fresh on next listKeys() anyway.
    } catch {
      /* non-fatal */
    }
  }

  private resolveKeyProvider(keyId: string): ResearchProvider | null {
    if (keyId === GLOBAL_OPENAI) return "openai";
    if (keyId === GLOBAL_ANTHROPIC) return "anthropic";
    const path = join(this.keysDir, `${keyId}.meta.json`);
    if (!existsSync(path)) return null;
    try {
      const meta = JSON.parse(readFileSync(path, "utf8")) as ResearchKeyMeta;
      return meta.provider;
    } catch {
      return null;
    }
  }

  private readConfigFromDisk(): ResearchFeaturesConfig {
    if (!existsSync(this.configPath)) return cloneConfig(DEFAULT_CONFIG);
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ResearchFeaturesConfig>;
      const out: ResearchFeaturesConfig = cloneConfig(DEFAULT_CONFIG);
      for (const f of VALID_FEATURES) {
        const v = parsed?.[f];
        if (!v || typeof v !== "object") continue;
        const tier = VALID_TIERS.includes(v.tier as ResearchTier) ? (v.tier as ResearchTier) : "off";
        const provider =
          v.provider && VALID_PROVIDERS.includes(v.provider as ResearchProvider)
            ? (v.provider as ResearchProvider)
            : null;
        const keyId = typeof v.keyId === "string" && v.keyId.length > 0 ? v.keyId : null;
        if (tier === "off" || !provider || !keyId) {
          out[f] = { tier: "off", provider: null, keyId: null };
        } else {
          out[f] = { tier, provider, keyId };
        }
      }
      return out;
    } catch (err) {
      console.warn("[research-store] failed to read features.json:", err);
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  private writeConfigAtomic(cfg: ResearchFeaturesConfig): void {
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    renameSync(tmp, this.configPath);
  }
}

function cloneConfig(cfg: ResearchFeaturesConfig): ResearchFeaturesConfig {
  return {
    expansionTenders: { ...cfg.expansionTenders },
    jobPostings: { ...cfg.jobPostings },
  };
}
