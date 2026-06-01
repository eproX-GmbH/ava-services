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
  /**
   * v0.1.179 — pre-import skip-mode snapshots. When the user picks
   * "Ohne Anreicherung" in the import confirmation, we snapshot the
   * current config, flip both features to off, run the import, and
   * restore the snapshot when the transaction completes. Keys are
   * either a transient `snap:<uuid>` (between snapshot creation and
   * transactionId attachment) or `tx:<transactionId>` (waiting for
   * the matching transaction to finish). Map lives only in memory;
   * if AVA crashes mid-import, the user's saved config stays at off
   * which is the fail-safe outcome (no surprise spending).
   */
  private pendingRestores: Map<string, ResearchFeaturesConfig> = new Map();

  private constructor() {
    super();
    this.dir = join(app.getPath("userData"), "research");
    this.keysDir = join(this.dir, KEYS_DIRNAME);
    this.configPath = join(this.dir, FEATURES_FILENAME);
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.keysDir)) mkdirSync(this.keysDir, { recursive: true });

    this.cached = this.readConfigFromDisk();

    // v0.1.356 — Backfill: existierende, klar vom Nutzer konfigurierte
    // Installs (mind. ein Feature != off) als „angefasst" markieren, damit
    // die Auto-Aktivierung unten sie NICHT überschreibt.
    if (!this.hasUserTouched() && this.anyFeatureEnabled()) {
      this.markUserTouched();
    }

    // v0.1.356 — Auto-Aktivierung robust gemacht. Vorher lief die Phase-E-
    // Migration NUR beim allerersten Boot (fresh) und nur wenn der Key zu
    // dem Zeitpunkt schon da war. Wer den OpenAI-Key später eintrug, blieb
    // für immer auf „off" hängen → Job-Postings + Deep-Research lieferten
    // still nichts (gemeldeter Bug). Jetzt: bei JEDEM Boot, solange der
    // Nutzer Research nicht explizit selbst konfiguriert hat, aus dem
    // vorhandenen globalen Key (OpenAI bevorzugt) beide Features auf
    // tier=standard schalten. Deep bleibt bewusst aus (Opt-in/Kosten).
    if (!this.hasUserTouched()) {
      this.autoEnableFromGlobalKeys();
    }
  }

  // ---- v0.1.356 — „user-touched"-Marker + Auto-Aktivierung ----------------
  //
  // Separate Marker-Datei statt eines Felds in features.json, damit die
  // bestehende ResearchFeaturesConfig-Form (und alle Consumer) unberührt
  // bleibt. Existiert die Datei, hat der Nutzer Research mindestens einmal
  // selbst gesetzt → wir aktivieren nichts mehr automatisch.

  private userTouchedPath(): string {
    return join(this.dir, "user-touched.flag");
  }

  private hasUserTouched(): boolean {
    return existsSync(this.userTouchedPath());
  }

  private markUserTouched(): void {
    try {
      writeFileSync(this.userTouchedPath(), String(Date.now()), { mode: 0o600 });
    } catch (err) {
      console.warn("[research-store] markUserTouched failed:", err);
    }
  }

  private anyFeatureEnabled(): boolean {
    return VALID_FEATURES.some((f) => this.cached[f].tier !== "off");
  }

  /**
   * Wenn der Nutzer Research nie selbst angefasst hat und ein globaler
   * OpenAI- (sonst Anthropic-) Key existiert: beide noch-„off"-Features
   * auf tier=standard mit dem globalen Key-Alias schalten. Idempotent;
   * gibt true zurück, wenn sich etwas geändert hat.
   */
  private autoEnableFromGlobalKeys(): boolean {
    const pcs = ProviderConfigStore.shared();
    let provider: ResearchProvider | null = null;
    let keyId: string | null = null;
    if (pcs.hasKey("openai")) {
      provider = "openai";
      keyId = GLOBAL_OPENAI;
    } else if (pcs.hasKey("anthropic")) {
      provider = "anthropic";
      keyId = GLOBAL_ANTHROPIC;
    }
    if (!provider || !keyId) return false;

    const next = cloneConfig(this.cached);
    let changed = false;
    for (const f of VALID_FEATURES) {
      if (next[f].tier === "off") {
        next[f] = { tier: "standard", provider, keyId };
        changed = true;
      }
    }
    if (!changed) return false;
    this.writeConfigAtomic(next);
    this.cached = next;
    this.emit("configChanged", cloneConfig(next));
    console.info(
      `[research-store] auto-enabled research features at tier=standard from global ${provider} key ` +
        `(deep stays off; user hasn't configured research explicitly).`,
    );
    return true;
  }

  /**
   * Öffentlicher Hook: wird aufgerufen, wenn ein Provider-Key gesetzt wird
   * (ProviderConfigStore "keyChanged"). Aktiviert Research nachträglich,
   * falls der Nutzer es nie selbst konfiguriert hat — behebt den „Key
   * später eingetragen → bleibt off"-Fall ohne Neustart.
   */
  maybeAutoEnableFromGlobalKeys(): void {
    if (this.hasUserTouched()) return;
    this.autoEnableFromGlobalKeys();
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
    // v0.1.356 — ab jetzt hat der Nutzer Research explizit konfiguriert →
    // keine automatische (Re-)Aktivierung mehr.
    this.markUserTouched();
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

  // ---- v0.1.179 — pre-import skip mode -------------------------------------

  /**
   * Snapshot the current per-feature config and flip both features
   * to `tier=off`. Returns a snapshot key the caller stores. The
   * supervisor's debounced restart will fire ~500ms later; the
   * caller is responsible for awaiting producer-ready before
   * starting the import (see `research:waitWebsiteReady` IPC).
   */
  beginSkipMode(): string {
    const key = `snap:${randomUUID()}`;
    this.pendingRestores.set(key, cloneConfig(this.cached));
    // Flip both features off in one atomic-feeling write. Two
    // setFeatureConfig calls each emit configChanged; the supervisor's
    // debounce coalesces them into one restart.
    if (this.cached.expansionTenders.tier !== "off") {
      this.setFeatureConfig("expansionTenders", { tier: "off" });
    }
    if (this.cached.jobPostings.tier !== "off") {
      this.setFeatureConfig("jobPostings", { tier: "off" });
    }
    console.info(
      `[research-store] beginSkipMode → ${key} (saved config, flipped to off)`,
    );
    return key;
  }

  /**
   * After `beginSkipMode` returns and the import POST returns a
   * transactionId, attach the snapshot to that transactionId so the
   * auto-restore on completion can find it.
   */
  attachSkipSnapshotToTransaction(snapshotKey: string, transactionId: string): boolean {
    const snap = this.pendingRestores.get(snapshotKey);
    if (!snap) {
      console.warn(`[research-store] attachSkipSnapshot: key ${snapshotKey} not found`);
      return false;
    }
    this.pendingRestores.delete(snapshotKey);
    this.pendingRestores.set(`tx:${transactionId}`, snap);
    console.info(
      `[research-store] attachSkipSnapshot ${snapshotKey} → tx:${transactionId}`,
    );
    return true;
  }

  /**
   * Restore the snapshot taken when a skip-mode import started.
   * Called from the renderer when the transaction stream reports
   * completion. Idempotent — repeated calls for the same tx-id are
   * no-ops.
   */
  endSkipModeForTransaction(transactionId: string): boolean {
    const key = `tx:${transactionId}`;
    const snap = this.pendingRestores.get(key);
    if (!snap) return false;
    this.pendingRestores.delete(key);
    // Restore each feature. setFeatureConfig validates so we can't
    // restore into an inconsistent state.
    for (const f of ["expansionTenders", "jobPostings"] as const) {
      const v = snap[f];
      if (v.tier === "off") {
        this.setFeatureConfig(f, { tier: "off" });
      } else if (v.provider && v.keyId) {
        this.setFeatureConfig(f, {
          tier: v.tier,
          provider: v.provider,
          keyId: v.keyId,
        });
      }
    }
    console.info(
      `[research-store] endSkipMode tx:${transactionId} (restored config)`,
    );
    return true;
  }

  /** True if there's a pending skip-mode for any transaction. UI uses
   *  this to lock out concurrent imports while a skip is in flight,
   *  avoiding the restore-the-wrong-config race. */
  hasPendingSkipMode(): boolean {
    return this.pendingRestores.size > 0;
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
