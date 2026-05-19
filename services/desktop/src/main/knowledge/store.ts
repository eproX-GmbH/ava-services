// v0.1.224 — KnowledgeProviderStore.
//
// Hält den Lebenszustand der Knowledge-Integrationen:
//   - Verbunden / nicht verbunden pro Provider
//   - Verschlüsselte Tokens via safeStorage (OS-Keychain)
//   - Cached Status (Display-Name, letzter Sync, letzter Fehler)
//
// Storage-Layout unter `<userData>/agent/knowledge/`:
//   - `status.json`           — Plain JSON: { providers: { notion: {…},
//                               obsidian: {…} } }
//   - `notion-token.enc`      — safeStorage-encrypted Token-Wert
//   - `obsidian-token.enc`    — dito
//
// Pattern angelehnt an `providers/store.ts` (Anthropic-Subscription-
// Token, OpenAI/Google/Mistral-Keys), wo dasselbe Muster funktioniert.
//
// Phase-1-Scope (v0.1.224): nur Storage + Status-Reading. Connect/
// Disconnect-Logik kommt mit dem konkreten Adapter in P2 (Notion).

import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import type {
  KnowledgeProviderKind,
  KnowledgeProviderStatus,
  KnowledgeProvidersSnapshot,
} from "../../shared/types";

const KINDS: readonly KnowledgeProviderKind[] = ["notion", "obsidian"];

interface OnDiskStatus {
  providers: Partial<
    Record<
      KnowledgeProviderKind,
      {
        connected: boolean;
        displayName: string | null;
        errorMessage: string | null;
        lastSyncAt: string | null;
      }
    >
  >;
}

const DEFAULT_STATUS: OnDiskStatus = { providers: {} };

export interface KnowledgeStoreEvents {
  /** Feuert nach jeder Status-Mutation (connect / disconnect / sync). */
  statusChanged: (kind: KnowledgeProviderKind) => void;
  /** Feuert wenn der Token-Wert sich ändert — z. B. damit ein
   *  laufender Adapter neu initialisieren kann. */
  tokenChanged: (kind: KnowledgeProviderKind) => void;
}

export declare interface KnowledgeProviderStore {
  on<E extends keyof KnowledgeStoreEvents>(
    event: E,
    listener: KnowledgeStoreEvents[E],
  ): this;
  emit<E extends keyof KnowledgeStoreEvents>(
    event: E,
    ...args: Parameters<KnowledgeStoreEvents[E]>
  ): boolean;
}

export class KnowledgeProviderStore extends EventEmitter {
  private static instance: KnowledgeProviderStore | null = null;
  private readonly dir: string;
  private readonly statusPath: string;
  private cached: OnDiskStatus;

  private constructor() {
    super();
    this.dir = join(app.getPath("userData"), "agent", "knowledge");
    this.statusPath = join(this.dir, "status.json");
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.cached = this.readStatusFromDisk();
  }

  static shared(): KnowledgeProviderStore {
    if (!this.instance) this.instance = new KnowledgeProviderStore();
    return this.instance;
  }

  // ---- Status-Snapshot ------------------------------------------------------

  snapshot(): KnowledgeProvidersSnapshot {
    return {
      providers: KINDS.map((k) => this.statusFor(k)),
      encryptionAvailable: this.isEncryptionAvailable(),
    };
  }

  statusFor(kind: KnowledgeProviderKind): KnowledgeProviderStatus {
    const onDisk = this.cached.providers[kind];
    return {
      kind,
      connected: onDisk?.connected ?? false,
      displayName: onDisk?.displayName ?? null,
      errorMessage: onDisk?.errorMessage ?? null,
      lastSyncAt: onDisk?.lastSyncAt ?? null,
    };
  }

  updateStatus(
    kind: KnowledgeProviderKind,
    patch: Partial<KnowledgeProviderStatus>,
  ): KnowledgeProviderStatus {
    const next: OnDiskStatus = {
      providers: { ...this.cached.providers },
    };
    const current = next.providers[kind] ?? {
      connected: false,
      displayName: null,
      errorMessage: null,
      lastSyncAt: null,
    };
    next.providers[kind] = {
      connected: patch.connected ?? current.connected,
      displayName:
        patch.displayName !== undefined
          ? patch.displayName
          : current.displayName,
      errorMessage:
        patch.errorMessage !== undefined
          ? patch.errorMessage
          : current.errorMessage,
      lastSyncAt:
        patch.lastSyncAt !== undefined ? patch.lastSyncAt : current.lastSyncAt,
    };
    this.writeStatusAtomic(next);
    this.cached = next;
    this.emit("statusChanged", kind);
    return this.statusFor(kind);
  }

  // ---- Token-Persistence (safeStorage) --------------------------------------

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /** Speichert den Plain-Token verschlüsselt. Wirft, wenn keine
   *  Encryption verfügbar ist (Linux ohne libsecret) — wir akzeptieren
   *  KEIN unverschlüsseltes Token-File für Knowledge-Integrationen.
   *  Cloud-Provider-Keys (OpenAI etc.) sind hier toleranter weil
   *  niedrigeres Risiko, aber Knowledge-Tokens öffnen ganze Workspaces. */
  setToken(kind: KnowledgeProviderKind, plaintext: string): void {
    const trimmed = plaintext.trim();
    if (trimmed.length === 0) {
      throw new Error(`Token für ${kind} ist leer.`);
    }
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        `OS-Schlüsselbund nicht verfügbar — Knowledge-Tokens werden nur ` +
          `verschlüsselt akzeptiert. Bitte über die System-Sicherheits-` +
          `Einstellungen aktivieren.`,
      );
    }
    const enc = safeStorage.encryptString(trimmed);
    writeFileSync(this.tokenPath(kind), enc, { mode: 0o600 });
    this.emit("tokenChanged", kind);
  }

  /** Liest den Plain-Token zurück. Null wenn nicht gespeichert oder
   *  die Decryption scheitert (Keychain rotiert / kaputt). */
  async getToken(kind: KnowledgeProviderKind): Promise<string | null> {
    const path = this.tokenPath(kind);
    if (!existsSync(path)) return null;
    try {
      const buf = readFileSync(path);
      if (!this.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn(
        `[knowledge-store] decrypt failed for ${kind}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Sync-Check „ist überhaupt was abgelegt?", ohne zu decrypten. */
  hasToken(kind: KnowledgeProviderKind): boolean {
    return existsSync(this.tokenPath(kind));
  }

  // ---- v0.1.235 — Obsidian-spezifische Credentials --------------------------
  //
  // Obsidian's Local-REST-API-Plugin braucht ZWEI Werte: API-Key
  // (Bearer-Token) und Base-URL (typisch http://127.0.0.1:27123). Wir
  // serialisieren beide als JSON in den encrypted Slot. Backward-compat
  // beim Lesen: ein reiner String-Token bekommt eine Default-Base-URL
  // (sollte aber nie auftreten, weil setObsidianCredentials immer
  // zusammen geschrieben wird).

  setObsidianCredentials(creds: {
    apiKey: string;
    baseUrl: string;
  }): void {
    const trimmedKey = creds.apiKey.trim();
    const trimmedUrl = creds.baseUrl.trim().replace(/\/+$/, "");
    if (trimmedKey.length === 0) {
      throw new Error("Obsidian-API-Key ist leer.");
    }
    if (!/^https?:\/\//i.test(trimmedUrl)) {
      throw new Error(
        "Obsidian Base-URL muss mit http:// oder https:// beginnen (z. B. http://127.0.0.1:27123).",
      );
    }
    if (!this.isEncryptionAvailable()) {
      throw new Error(
        "OS-Schlüsselbund nicht verfügbar — Obsidian-Credentials werden nur verschlüsselt akzeptiert.",
      );
    }
    const envelope = JSON.stringify({
      apiKey: trimmedKey,
      baseUrl: trimmedUrl,
    });
    const enc = safeStorage.encryptString(envelope);
    writeFileSync(this.tokenPath("obsidian"), enc, { mode: 0o600 });
    this.emit("tokenChanged", "obsidian");
  }

  async getObsidianCredentials(): Promise<{
    apiKey: string;
    baseUrl: string;
  } | null> {
    const path = this.tokenPath("obsidian");
    if (!existsSync(path)) return null;
    try {
      const buf = readFileSync(path);
      if (!this.isEncryptionAvailable()) return null;
      const raw = safeStorage.decryptString(buf);
      const parsed = JSON.parse(raw) as Partial<{
        apiKey: string;
        baseUrl: string;
      }>;
      if (
        typeof parsed.apiKey === "string" &&
        typeof parsed.baseUrl === "string"
      ) {
        return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
      }
      return null;
    } catch (err) {
      console.warn(
        "[knowledge-store] decrypt obsidian creds failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  clearToken(kind: KnowledgeProviderKind): void {
    const path = this.tokenPath(kind);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (err) {
        console.warn(
          `[knowledge-store] unlink token failed for ${kind}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    this.updateStatus(kind, {
      connected: false,
      displayName: null,
      errorMessage: null,
      lastSyncAt: null,
    });
    this.emit("tokenChanged", kind);
  }

  // ---- Internals ------------------------------------------------------------

  private tokenPath(kind: KnowledgeProviderKind): string {
    return join(this.dir, `${kind}-token.enc`);
  }

  private readStatusFromDisk(): OnDiskStatus {
    if (!existsSync(this.statusPath)) return DEFAULT_STATUS;
    try {
      const raw = readFileSync(this.statusPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        "providers" in parsed &&
        typeof (parsed as { providers: unknown }).providers === "object"
      ) {
        return parsed as OnDiskStatus;
      }
      return DEFAULT_STATUS;
    } catch {
      return DEFAULT_STATUS;
    }
  }

  private writeStatusAtomic(next: OnDiskStatus): void {
    const tmp = `${this.statusPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, this.statusPath);
  }
}
