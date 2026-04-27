import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type { LlmProviderKind } from "./types";

// Provider config persistence (Phase 8.j).
//
// Two files under `app.getPath("userData")/agent/`:
//
//   provider.json
//     {
//       "kind": "ollama" | "openai",
//       "ollamaModel": "qwen2.5:7b" | null,
//       "openaiModel": "gpt-4o-mini"
//     }
//     Plain JSON — nothing sensitive in here. Atomic write
//     (write-temp + rename) so a crash mid-write can't leave a 0-byte file.
//
//   openai.enc
//     Output of safeStorage.encryptString(apiKey). On macOS this is
//     Keychain-backed; Windows uses DPAPI; Linux falls back to
//     libsecret/kwallet or a basic obfuscation if neither is available.
//     `safeStorage.isEncryptionAvailable()` reports the strength —
//     callers should warn the user before storing on the basic path.
//
// The store is a singleton; orchestrator + tools both go through
// `ProviderConfigStore.shared()`.

export interface ProviderConfig {
  kind: LlmProviderKind;
  ollamaModel: string | null;
  openaiModel: string;
}

const DEFAULT_CONFIG: ProviderConfig = {
  kind: "ollama",
  ollamaModel: null, // null → fall back to REQUIRED_MODELS llm tag
  openaiModel: "gpt-4o-mini",
};

export interface ProviderConfigStoreEvents {
  configChanged: (cfg: ProviderConfig) => void;
  keyChanged: () => void;
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
  private readonly keyPath: string;
  private cached: ProviderConfig;

  private constructor() {
    super();
    this.dir = join(app.getPath("userData"), "agent");
    this.configPath = join(this.dir, "provider.json");
    this.keyPath = join(this.dir, "openai.enc");
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
    return { ...this.cached };
  }

  setConfig(partial: Partial<ProviderConfig>): ProviderConfig {
    const next: ProviderConfig = { ...this.cached, ...partial };
    if (next.kind !== "ollama" && next.kind !== "openai") {
      throw new Error(`unknown provider kind: ${String(next.kind)}`);
    }
    this.writeConfigAtomic(next);
    this.cached = next;
    this.emit("configChanged", { ...next });
    return { ...next };
  }

  // ---- Encrypted OpenAI key -------------------------------------------------

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

  hasOpenAiKey(): boolean {
    return existsSync(this.keyPath);
  }

  async getOpenAiKey(): Promise<string | null> {
    if (!existsSync(this.keyPath)) return null;
    try {
      const buf = readFileSync(this.keyPath);
      return safeStorage.decryptString(buf);
    } catch (err) {
      // Decrypt failure typically means the user re-installed the OS,
      // their keychain entry was wiped, or someone else's blob landed
      // on disk. Surface as missing rather than crashing — the
      // orchestrator will then prompt for a fresh key.
      console.warn("[provider-store] failed to decrypt openai key:", err);
      return null;
    }
  }

  setOpenAiKey(plaintext: string): void {
    const trimmed = plaintext.trim();
    if (!trimmed) throw new Error("openai key is empty");
    if (!safeStorage.isEncryptionAvailable()) {
      // Still proceed — Electron will use a basic cipher. We log so a
      // developer notices in the console; user-facing warning lives in
      // the Settings → Agent panel.
      console.warn(
        "[provider-store] safeStorage encryption not available — falling back to basic cipher",
      );
    }
    const enc = safeStorage.encryptString(trimmed);
    writeFileSync(this.keyPath, enc, { mode: 0o600 });
    this.emit("keyChanged");
  }

  clearOpenAiKey(): void {
    if (existsSync(this.keyPath)) {
      try {
        unlinkSync(this.keyPath);
      } catch (err) {
        console.warn("[provider-store] clearOpenAiKey unlink failed:", err);
      }
    }
    this.emit("keyChanged");
  }

  // ---- Disk I/O -------------------------------------------------------------

  private readConfigFromDisk(): ProviderConfig {
    if (!existsSync(this.configPath)) return { ...DEFAULT_CONFIG };
    try {
      const raw = readFileSync(this.configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProviderConfig>;
      return {
        kind:
          parsed.kind === "openai" ? "openai" : "ollama", // unknown → ollama
        ollamaModel:
          typeof parsed.ollamaModel === "string"
            ? parsed.ollamaModel
            : DEFAULT_CONFIG.ollamaModel,
        openaiModel:
          typeof parsed.openaiModel === "string" && parsed.openaiModel.length > 0
            ? parsed.openaiModel
            : DEFAULT_CONFIG.openaiModel,
      };
    } catch (err) {
      console.warn("[provider-store] failed to read provider.json:", err);
      return { ...DEFAULT_CONFIG };
    }
  }

  private writeConfigAtomic(cfg: ProviderConfig): void {
    const tmp = `${this.configPath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    // rename is atomic on POSIX; on Windows it falls back to an unlink+rename
    // sequence under the hood — still race-safe because we're the only writer.
    require("node:fs").renameSync(tmp, this.configPath);
  }
}
