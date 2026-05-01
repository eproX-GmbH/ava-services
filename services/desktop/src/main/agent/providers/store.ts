import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  HostedProviderKind,
  LlmProviderKind,
  ProviderConfig,
} from "../../../shared/types";

// Provider config persistence (Phase 8.j, expanded in 8.k1).
//
// Files under `app.getPath("userData")/agent/`:
//
//   provider.json
//     {
//       "kind": "ollama" | "openai" | "anthropic" | "google" | "mistral",
//       "models": {
//         "ollama":    "llama3.2:3b" | "",
//         "openai":    "gpt-4o-mini",
//         "anthropic": "claude-sonnet-4-6",
//         "google":    "gemini-2.5-pro",
//         "mistral":   "mistral-large-latest"
//       }
//     }
//     Plain JSON — nothing sensitive in here. Atomic write
//     (write-temp + rename) so a crash mid-write can't leave a 0-byte file.
//     An empty string means "use catalog recommendation"; populated
//     value is what the user picked in the picker.
//
//   <provider>.enc  (one each for openai, anthropic, google, mistral)
//     Output of safeStorage.encryptString(apiKey). On macOS this is
//     Keychain-backed; Windows uses DPAPI; Linux falls back to
//     libsecret/kwallet or a basic obfuscation if neither is available.
//     `safeStorage.isEncryptionAvailable()` reports the strength —
//     callers should warn the user before storing on the basic path.
//
// Ollama is keyless (talks to localhost only) so it has no .enc file.
//
// Backward-compat note: 8.j shipped with `openai.enc` already. New
// installs will simply create the additional .enc files as the user
// adds keys. Old installs keep their existing openai.enc — the file
// name is unchanged.

const HOSTED_KINDS: readonly HostedProviderKind[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
];

const ALL_KINDS: readonly LlmProviderKind[] = [
  "ollama",
  "openai",
  "anthropic",
  "google",
  "mistral",
];

/**
 * Default config: Ollama active, all model fields empty (recommendation
 * from the shared catalog kicks in). Renderer never sees this — `manager`
 * resolves "" to the catalog default before reporting.
 */
const DEFAULT_CONFIG: ProviderConfig = {
  kind: "ollama",
  models: {
    ollama: "",
    openai: "",
    anthropic: "",
    google: "",
    mistral: "",
  },
};

export type { ProviderConfig };

export interface ProviderConfigStoreEvents {
  configChanged: (cfg: ProviderConfig) => void;
  /** Fires for any provider's key being set/cleared. Listener can re-check via `hasKey`. */
  keyChanged: (kind: HostedProviderKind) => void;
}

export declare interface ProviderConfigStore {
  on<E extends keyof ProviderConfigStoreEvents>(
    event: E,
    listener: ProviderConfigStoreEvents[E],
  ): this;
  emit<E extends keyof ProviderConfigStoreEvents>(
    event: E,
    ...args: Parameters<ProviderConfigStoreEvents[E]>
  ): boolean;
}

export class ProviderConfigStore extends EventEmitter {
  private static instance: ProviderConfigStore | null = null;
  private readonly dir: string;
  private readonly configPath: string;
  private cached: ProviderConfig;

  private constructor() {
    super();
    this.dir = join(app.getPath("userData"), "agent");
    this.configPath = join(this.dir, "provider.json");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.cached = this.readConfigFromDisk();
  }

  static shared(): ProviderConfigStore {
    if (!this.instance) this.instance = new ProviderConfigStore();
    return this.instance;
  }

  // ---- Provider config ------------------------------------------------------

  getConfig(): ProviderConfig {
    return cloneConfig(this.cached);
  }

  /**
   * Patch one or more fields and persist atomically. `models` is
   * shallow-merged so callers can update a single provider's model
   * without re-supplying the rest.
   */
  setConfig(partial: {
    kind?: LlmProviderKind;
    models?: Partial<Record<LlmProviderKind, string>>;
  }): ProviderConfig {
    const next: ProviderConfig = cloneConfig(this.cached);
    if (partial.kind) {
      if (!ALL_KINDS.includes(partial.kind)) {
        throw new Error(`unknown provider kind: ${String(partial.kind)}`);
      }
      next.kind = partial.kind;
    }
    if (partial.models) {
      for (const [k, v] of Object.entries(partial.models)) {
        if (!ALL_KINDS.includes(k as LlmProviderKind)) continue;
        next.models[k as LlmProviderKind] = v ?? "";
      }
    }
    this.writeConfigAtomic(next);
    this.cached = next;
    this.emit("configChanged", cloneConfig(next));
    return cloneConfig(next);
  }

  // ---- Encrypted API keys ---------------------------------------------------

  /**
   * Whether the OS-level encrypted store is usable. False on Linux without
   * libsecret/kwallet — UI should warn but still allow saving (Electron
   * falls back to a basic cipher tied to the user account).
   */
  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  hasKey(kind: HostedProviderKind): boolean {
    return existsSync(this.keyPath(kind));
  }

  /**
   * Map of all hosted-provider key presence flags. Convenient for the
   * IPC bundle so the renderer doesn't fan out four sequential calls.
   */
  hasAllKeys(): Record<LlmProviderKind, boolean> {
    return {
      ollama: true, // no key needed
      openai: this.hasKey("openai"),
      anthropic: this.hasKey("anthropic"),
      google: this.hasKey("google"),
      mistral: this.hasKey("mistral"),
    };
  }

  /**
   * Decrypt and return the key for `kind`, or null if the file is
   * missing or undecryptable. Async so callers don't synchronously hold
   * plaintext key material — each turn re-reads.
   *
   * Self-healing on decrypt failure: we unlink the broken `.enc` file
   * and fire `keyChanged`. Without this, `hasKey()` would keep
   * reporting true for an unreadable blob (e.g. keychain access
   * denied in unsigned dev runs, OS keychain rotated, app reinstalled
   * over a previous version), the status badge would stay "ready",
   * and every chat turn would throw "API key is unreadable" forever.
   * Removing the file flips the badge to "not set" so the user gets
   * the normal "enter your key" affordance instead of a stuck loop.
   */
  async getKey(kind: HostedProviderKind): Promise<string | null> {
    const path = this.keyPath(kind);
    if (!existsSync(path)) return null;
    try {
      const buf = readFileSync(path);
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn(
        `[provider-store] failed to decrypt ${kind} key — removing broken blob:`,
        err,
      );
      try {
        unlinkSync(path);
      } catch (unlinkErr) {
        console.warn(
          `[provider-store] could not unlink broken ${kind}.enc:`,
          unlinkErr,
        );
      }
      // Notify subscribers so the manager re-emits status with
      // `hasKey:false` and the renderer redraws the picker.
      this.emit("keyChanged", kind);
      return null;
    }
  }

  setKey(kind: HostedProviderKind, plaintext: string): void {
    const trimmed = plaintext.trim();
    if (!trimmed) throw new Error(`${kind} key is empty`);
    if (!safeStorage.isEncryptionAvailable()) {
      // Still proceed — Electron will use a basic cipher. We log so a
      // developer notices in the console; user-facing warning lives in
      // the Settings → Agent panel.
      console.warn(
        `[provider-store] safeStorage encryption not available — falling back to basic cipher (${kind})`,
      );
    }
    const enc = safeStorage.encryptString(trimmed);
    writeFileSync(this.keyPath(kind), enc, { mode: 0o600 });
    this.emit("keyChanged", kind);
  }

  clearKey(kind: HostedProviderKind): void {
    const path = this.keyPath(kind);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        console.warn(`[provider-store] clearKey unlink failed (${kind}):`, err);
      }
    }
    this.emit("keyChanged", kind);
  }

  /** All hosted providers we track, in stable order — for fan-out loops. */
  hostedKinds(): readonly HostedProviderKind[] {
    return HOSTED_KINDS;
  }

  // ---- Disk I/O -------------------------------------------------------------

  private keyPath(kind: HostedProviderKind): string {
    return join(this.dir, `${kind}.enc`);
  }

  private readConfigFromDisk(): ProviderConfig {
    if (!existsSync(this.configPath)) return cloneConfig(DEFAULT_CONFIG);
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProviderConfig> & {
        // 8.j legacy fields — read once, then dropped on next write.
        ollamaModel?: string | null;
        openaiModel?: string;
      };
      const kind: LlmProviderKind = ALL_KINDS.includes(
        parsed.kind as LlmProviderKind,
      )
        ? (parsed.kind as LlmProviderKind)
        : "ollama";

      const models = cloneConfig(DEFAULT_CONFIG).models;
      // 8.j → 8.k1 forward-compat: pull the legacy single-key fields into
      // the new map so an upgrade doesn't lose the user's prior choice.
      if (typeof parsed.ollamaModel === "string") {
        models.ollama = parsed.ollamaModel;
      }
      if (typeof parsed.openaiModel === "string") {
        models.openai = parsed.openaiModel;
      }
      // 8.k1 native shape: takes precedence over legacy.
      if (parsed.models && typeof parsed.models === "object") {
        for (const k of ALL_KINDS) {
          const v = parsed.models[k];
          if (typeof v === "string") models[k] = v;
        }
      }
      return { kind, models };
    } catch (err) {
      console.warn("[provider-store] failed to read provider.json:", err);
      return cloneConfig(DEFAULT_CONFIG);
    }
  }

  private writeConfigAtomic(cfg: ProviderConfig): void {
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    // rename is atomic on POSIX; on Windows it falls back to an unlink+rename
    // sequence under the hood — still race-safe because we're the only writer.
    renameSync(tmp, this.configPath);
  }
}

function cloneConfig(cfg: ProviderConfig): ProviderConfig {
  return { kind: cfg.kind, models: { ...cfg.models } };
}
