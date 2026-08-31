// WL2 — Anbieter-Key + Konfiguration der Personen-Watchlist (BYOK, W1).
//
// Muster telegram/store.ts: Konfiguration als Klartext-JSON, der Key
// verschluesselt via safeStorage (OS-Schluesselbund). Beides unter
// userData/linkedin/ — damit wischen Kill-Switch UND Werksreset alles
// mit (W7). Der Key wird NIE ueber die IPC-Grenze gespiegelt; der
// Renderer sieht nur hasKey.

import { app, safeStorage } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { APIFY_DEFAULT_ACTORS } from "./providers/apify";

export interface WatchlistConfig {
  /** Automatik an? (Opt-in, Default AUS.) */
  enabled: boolean;
  /** Anbieter — vorerst nur "apify" (W4). */
  providerId: "apify";
  /** Actor-Overrides (leer = harvestapi-Defaults). */
  reactionsActorId: string;
  commentsActorId: string;
  /** Pruef-Intervall: 24 = taeglich, 168 = woechentlich. */
  intervalHours: 24 | 168;
  /** Item-Budget je Profil und Lauf (Kosten-Kontrolle, Nutzer zahlt). */
  maxItemsPerProfile: number;
  lastRunAt: string | null;
  lastOutcome: string | null;
}

const DEFAULT_CONFIG: WatchlistConfig = {
  enabled: false,
  providerId: "apify",
  reactionsActorId: APIFY_DEFAULT_ACTORS.reactionsActorId,
  commentsActorId: APIFY_DEFAULT_ACTORS.commentsActorId,
  intervalHours: 24,
  maxItemsPerProfile: 10,
  lastRunAt: null,
  lastOutcome: null,
};

export class WatchlistKeyStore {
  private readonly dir: string;
  private configCache: WatchlistConfig | null = null;
  private keyCache: string | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "linkedin");
  }

  private configPath(): string {
    return join(this.dir, "watchlist-config.json");
  }
  private keyPath(): string {
    return join(this.dir, "watchlist-key.enc");
  }

  getConfig(): WatchlistConfig {
    if (this.configCache) return { ...this.configCache };
    try {
      if (existsSync(this.configPath())) {
        const p = JSON.parse(
          readFileSync(this.configPath(), "utf8"),
        ) as Partial<WatchlistConfig>;
        this.configCache = {
          enabled: p.enabled === true,
          providerId: "apify",
          reactionsActorId:
            typeof p.reactionsActorId === "string" && p.reactionsActorId.trim()
              ? p.reactionsActorId.trim()
              : DEFAULT_CONFIG.reactionsActorId,
          commentsActorId:
            typeof p.commentsActorId === "string"
              ? p.commentsActorId.trim()
              : DEFAULT_CONFIG.commentsActorId,
          intervalHours: p.intervalHours === 168 ? 168 : 24,
          maxItemsPerProfile:
            typeof p.maxItemsPerProfile === "number" &&
            Number.isFinite(p.maxItemsPerProfile)
              ? Math.min(100, Math.max(1, Math.floor(p.maxItemsPerProfile)))
              : DEFAULT_CONFIG.maxItemsPerProfile,
          lastRunAt: typeof p.lastRunAt === "string" ? p.lastRunAt : null,
          lastOutcome: typeof p.lastOutcome === "string" ? p.lastOutcome : null,
        };
        return { ...this.configCache };
      }
    } catch {
      /* korrupt → Defaults */
    }
    this.configCache = { ...DEFAULT_CONFIG };
    return { ...this.configCache };
  }

  setConfig(patch: Partial<WatchlistConfig>): WatchlistConfig {
    const next = { ...this.getConfig(), ...patch, providerId: "apify" as const };
    // Ohne Key keine Automatik.
    if (next.enabled && !this.hasKey()) next.enabled = false;
    try {
      mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.configPath()}.tmp`;
      writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
      renameSync(tmp, this.configPath());
    } catch (err) {
      console.warn("[watchlist] config persist failed:", err);
    }
    this.configCache = next;
    return { ...next };
  }

  hasKey(): boolean {
    return this.keyCache !== null || existsSync(this.keyPath());
  }

  setKey(key: string): { ok: boolean; error?: string } {
    const trimmed = key.trim();
    if (trimmed.length < 10) return { ok: false, error: "Token zu kurz." };
    if (!safeStorage.isEncryptionAvailable()) {
      return {
        ok: false,
        error: "System-Schluesselbund nicht verfuegbar — Token kann nicht sicher gespeichert werden.",
      };
    }
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.keyPath(), safeStorage.encryptString(trimmed), {
        mode: 0o600,
      });
      this.keyCache = trimmed;
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Nur main-seitig aufrufen — NIE ueber IPC spiegeln. */
  getKey(): string | null {
    if (this.keyCache) return this.keyCache;
    try {
      if (!existsSync(this.keyPath())) return null;
      this.keyCache = safeStorage.decryptString(readFileSync(this.keyPath()));
      return this.keyCache;
    } catch (err) {
      console.warn("[watchlist] key decrypt failed:", err);
      return null;
    }
  }

  clearKey(): void {
    this.keyCache = null;
    try {
      rmSync(this.keyPath(), { force: true });
    } catch {
      /* best-effort */
    }
    // Automatik ohne Key abschalten.
    this.setConfig({ enabled: false });
  }
}
