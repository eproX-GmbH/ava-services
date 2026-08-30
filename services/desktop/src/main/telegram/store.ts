// v0.1.412 — Telegram-Kanal: Konfiguration + Bot-Token.
//
// Zwei getrennte Dateien in EINEM eigenen Top-Level-Verzeichnis
// `userData/telegram/`:
//
//   config.json     — unkritisch (chatId, enabled, Schwellwert, Bot-Name)
//   bot-token.enc   — der Bot-Token, verschlüsselt via safeStorage
//
// Warum ein eigenes Verzeichnis statt `agent/telegram.enc`: Der Werksreset
// (reset-store.ts) löscht `agent/` NICHT komplett, sondern nur eine
// Positivliste von Dateien — alles andere dort bleibt bewusst erhalten
// (LLM-Keys). Ein Token unter `agent/` würde den Reset also überleben.
// Als eigenes Top-Level-Verzeichnis wird `telegram/` sauber mitgelöscht
// (siehe reset-store.ts → topLevelTargets).

import { EventEmitter } from "node:events";
import { app, safeStorage } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { AlertSeverity, TelegramConfig } from "../../shared/types";

const DEFAULT_CONFIG: TelegramConfig = {
  enabled: false,
  chatId: null,
  botUsername: null,
  severityThreshold: "warn",
  respectQuietHours: true,
  inboundEnabled: false,
  inboundConfirmEnabled: false,
  autonomyLevel: "none",
  lastUpdateId: null,
};

function sanitiseAutonomy(v: unknown): TelegramConfig["autonomyLevel"] {
  return v === "additive" || v === "mutating" ? v : "none";
}

export interface TelegramStoreEvents {
  changed: (config: TelegramConfig) => void;
}

export declare interface TelegramStore {
  on<K extends keyof TelegramStoreEvents>(
    event: K,
    listener: TelegramStoreEvents[K],
  ): this;
  emit<K extends keyof TelegramStoreEvents>(
    event: K,
    ...args: Parameters<TelegramStoreEvents[K]>
  ): boolean;
}

export class TelegramStore extends EventEmitter {
  private cached: TelegramConfig;
  private tokenCache: string | null = null;

  constructor() {
    super();
    this.cached = this.readFromDisk();
  }

  // ---- Verzeichnis / Pfade -------------------------------------------------

  private dir(): string {
    return join(app.getPath("userData"), "telegram");
  }

  private configPath(): string {
    return join(this.dir(), "config.json");
  }

  private tokenPath(): string {
    return join(this.dir(), "bot-token.enc");
  }

  private ensureDir(): void {
    const d = this.dir();
    if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  // ---- Konfiguration -------------------------------------------------------

  getConfig(): TelegramConfig {
    return { ...this.cached };
  }

  setConfig(patch: Partial<TelegramConfig>): TelegramConfig {
    const next: TelegramConfig = { ...this.cached };
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
    if (patch.chatId !== undefined) {
      const v = typeof patch.chatId === "string" ? patch.chatId.trim() : "";
      next.chatId = v.length > 0 ? v : null;
    }
    if (patch.botUsername !== undefined) {
      const v =
        typeof patch.botUsername === "string" ? patch.botUsername.trim() : "";
      next.botUsername = v.length > 0 ? v : null;
    }
    if (patch.severityThreshold !== undefined) {
      next.severityThreshold = sanitiseSeverity(patch.severityThreshold);
    }
    if (patch.respectQuietHours !== undefined) {
      next.respectQuietHours = patch.respectQuietHours === true;
    }
    if (patch.inboundEnabled !== undefined) {
      next.inboundEnabled = patch.inboundEnabled === true;
    }
    if (patch.inboundConfirmEnabled !== undefined) {
      next.inboundConfirmEnabled = patch.inboundConfirmEnabled === true;
    }
    if (patch.autonomyLevel !== undefined) {
      next.autonomyLevel = sanitiseAutonomy(patch.autonomyLevel);
    }
    if (patch.lastUpdateId !== undefined) {
      next.lastUpdateId =
        typeof patch.lastUpdateId === "number" &&
        Number.isFinite(patch.lastUpdateId)
          ? Math.floor(patch.lastUpdateId)
          : null;
    }
    // Ohne Chat/Token gibt es auch nichts zu empfangen.
    if (next.inboundEnabled && (next.chatId === null || !this.hasToken())) {
      next.inboundEnabled = false;
    }
    // Rückfragen und Vollmacht setzen den Eingang voraus.
    if (!next.inboundEnabled) {
      next.inboundConfirmEnabled = false;
      next.autonomyLevel = "none";
    }
    // Ohne Token oder Chat-ID kann der Kanal nicht aktiv sein.
    if (next.enabled && (next.chatId === null || !this.hasToken())) {
      next.enabled = false;
    }
    this.writeAtomic(next);
    this.cached = next;
    this.emit("changed", { ...next });
    return { ...next };
  }

  private readFromDisk(): TelegramConfig {
    try {
      const raw = readFileSync(this.configPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<TelegramConfig>;
      return {
        enabled: parsed.enabled === true,
        chatId:
          typeof parsed.chatId === "string" && parsed.chatId.trim().length > 0
            ? parsed.chatId.trim()
            : null,
        botUsername:
          typeof parsed.botUsername === "string" &&
          parsed.botUsername.trim().length > 0
            ? parsed.botUsername.trim()
            : null,
        severityThreshold: sanitiseSeverity(parsed.severityThreshold),
        respectQuietHours: parsed.respectQuietHours !== false,
        inboundEnabled: parsed.inboundEnabled === true,
        inboundConfirmEnabled:
          parsed.inboundEnabled === true &&
          parsed.inboundConfirmEnabled === true,
        autonomyLevel:
          parsed.inboundEnabled === true
            ? sanitiseAutonomy(parsed.autonomyLevel)
            : "none",
        lastUpdateId:
          typeof parsed.lastUpdateId === "number" ? parsed.lastUpdateId : null,
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Atomar schreiben (temp + rename), damit ein Crash keine 0-Byte-Datei hinterlässt. */
  private writeAtomic(cfg: TelegramConfig): void {
    try {
      this.ensureDir();
      const tmp = `${this.configPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
      renameSync(tmp, this.configPath());
    } catch (err) {
      console.warn("[telegram] config write failed:", err);
    }
  }

  // ---- Bot-Token (verschlüsselt) ------------------------------------------

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  hasToken(): boolean {
    return this.tokenCache !== null || existsSync(this.tokenPath());
  }

  async saveToken(token: string): Promise<void> {
    const trimmed = token.trim();
    if (trimmed.length === 0) throw new Error("Bot-Token ist leer.");
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        "OS-Keychain nicht verfügbar — der Bot-Token kann nicht sicher gespeichert werden.",
      );
    }
    this.ensureDir();
    const enc = safeStorage.encryptString(trimmed);
    await fs.writeFile(this.tokenPath(), enc, { mode: 0o600 });
    this.tokenCache = trimmed;
  }

  async getToken(): Promise<string | null> {
    if (this.tokenCache) return this.tokenCache;
    try {
      const buf = await fs.readFile(this.tokenPath());
      if (!this.isEncryptionAvailable()) return null;
      const token = safeStorage.decryptString(buf);
      this.tokenCache = token;
      return token;
    } catch {
      return null;
    }
  }

  /** Token + Konfiguration vollständig entfernen („Trennen"). */
  async clear(): Promise<void> {
    this.tokenCache = null;
    await fs.unlink(this.tokenPath()).catch(() => undefined);
    const next: TelegramConfig = { ...DEFAULT_CONFIG };
    this.writeAtomic(next);
    this.cached = next;
    this.emit("changed", { ...next });
  }
}

function sanitiseSeverity(v: unknown): AlertSeverity {
  return v === "info" || v === "warn" || v === "urgent" ? v : "warn";
}
