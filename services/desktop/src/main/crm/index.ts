// v0.1.54 — CRM connection manager (singleton).
//
// Glues together the on-disk token store + the loopback OAuth flow +
// status broadcasting to the renderer. Single instance for the whole
// app so the agent tool, Settings UI, and Phase 2/3 API tools all
// observe the same state.
//
// Lifecycle:
//   - constructor: zero-state. No I/O.
//   - getStatus(provider): synchronous read from the in-memory cache.
//   - hydrate(): async, loads all provider records from disk on
//     boot. Called once from main/index.ts during app.whenReady.
//   - connect(provider, opts): runs the OAuth flow, persists tokens,
//     emits "status" event for that provider.
//   - disconnect(provider): clears tokens, emits "status".
//   - getAccessToken(provider): returns a valid access token,
//     auto-refreshing if it's near expiry. Used by Phase 2/3 API
//     tools and by the agent's read tools.
//
// Status events fan out via the existing IPC pattern (see main/index.ts
// `crm:status:changed` channel). Renderer subscribes via preload.

import { EventEmitter } from "node:events";
import {
  CRM_PROVIDERS,
  type CrmProvider,
  type CrmStatus,
  type CrmTokens,
} from "./types";
import {
  loadTokens,
  saveTokens,
  clearTokens,
} from "./token-store";
import { runConnectFlow, runRefreshFlow } from "./oauth-flow";

/** Refresh ahead of expiry by this much so requests in flight don't
 *  trip a stale token. 60 s is plenty for any CRM round-trip. */
const REFRESH_LEAD_MS = 60_000;

interface InMemoryRecord {
  account: string;
  tokens: CrmTokens;
  lastRefreshedAt: string;
  lastError: string | null;
}

export interface CrmManagerOptions {
  /** JWT for gateway calls — same source the rest of the app uses. */
  getBearer: () => Promise<string | null>;
  /** Gateway base URL. */
  gatewayUrl: string;
}

export class CrmManager extends EventEmitter {
  private records: Map<CrmProvider, InMemoryRecord> = new Map();
  private inFlightConnects: Map<CrmProvider, Promise<void>> = new Map();
  private inFlightRefreshes: Map<CrmProvider, Promise<CrmTokens>> = new Map();

  constructor(private readonly opts: CrmManagerOptions) {
    super();
  }

  /** Boot-time read from disk. Idempotent — safe to call again
   *  after disconnect/reconnect. */
  async hydrate(): Promise<void> {
    for (const provider of CRM_PROVIDERS) {
      const rec = await loadTokens(provider);
      if (rec) {
        this.records.set(provider, {
          account: rec.account,
          tokens: rec.tokens,
          lastRefreshedAt: rec.lastRefreshedAt,
          lastError: null,
        });
      } else {
        this.records.delete(provider);
      }
    }
  }

  getStatus(provider: CrmProvider): CrmStatus {
    const rec = this.records.get(provider);
    return {
      provider,
      connected: !!rec,
      account: rec?.account ?? null,
      lastRefreshedAt: rec?.lastRefreshedAt ?? null,
      lastError: rec?.lastError ?? null,
    };
  }

  getAllStatuses(): CrmStatus[] {
    return CRM_PROVIDERS.map((p) => this.getStatus(p));
  }

  /** Run the interactive connect flow for a provider. Resolves when
   *  the OAuth dance is complete + tokens are persisted. Throws on
   *  user cancel, IdP error, or gateway exchange failure. */
  async connect(provider: CrmProvider, opts?: { orgUrl?: string }): Promise<void> {
    if (this.inFlightConnects.has(provider)) {
      return this.inFlightConnects.get(provider)!;
    }
    const promise = (async () => {
      const bearer = await this.opts.getBearer();
      if (!bearer) {
        throw new Error(
          "Anmeldung erforderlich, bevor ein CRM verbunden werden kann.",
        );
      }
      try {
        const { tokens, account } = await runConnectFlow({
          provider,
          bearer,
          gatewayUrl: this.opts.gatewayUrl,
          orgUrl: opts?.orgUrl,
        });
        await saveTokens(provider, account, tokens);
        this.records.set(provider, {
          account,
          tokens,
          lastRefreshedAt: new Date().toISOString(),
          lastError: null,
        });
        this.emit("status", this.getStatus(provider));
      } catch (err) {
        // Store the error message in-memory so the Settings card
        // can surface it. Don't persist a half-connected state.
        const msg = err instanceof Error ? err.message : String(err);
        const existing = this.records.get(provider);
        if (existing) {
          existing.lastError = msg;
          this.emit("status", this.getStatus(provider));
        } else {
          // Brief flash so the renderer sees the error, then fade.
          this.records.set(provider, {
            account: "",
            tokens: {} as CrmTokens,
            lastRefreshedAt: "",
            lastError: msg,
          });
          this.emit("status", this.getStatus(provider));
          this.records.delete(provider);
          this.emit("status", this.getStatus(provider));
        }
        throw err;
      }
    })().finally(() => {
      this.inFlightConnects.delete(provider);
    });
    this.inFlightConnects.set(provider, promise);
    return promise;
  }

  async disconnect(provider: CrmProvider): Promise<void> {
    await clearTokens(provider);
    this.records.delete(provider);
    this.emit("status", this.getStatus(provider));
  }

  /** Returns a token guaranteed valid for at least REFRESH_LEAD_MS.
   *  Handles refresh + persistence transparently; Phase 2/3 callers
   *  treat this as "give me a fresh bearer for the CRM API". */
  async getAccessToken(provider: CrmProvider): Promise<string | null> {
    const rec = this.records.get(provider);
    if (!rec) return null;
    if (rec.tokens.expiresAt - Date.now() > REFRESH_LEAD_MS) {
      return rec.tokens.accessToken;
    }
    if (!rec.tokens.refreshToken) {
      // No refresh capability — return the (possibly expired) token
      // and let the API call surface the failure. Caller can decide
      // to prompt re-connect.
      return rec.tokens.accessToken;
    }
    if (this.inFlightRefreshes.has(provider)) {
      const refreshed = await this.inFlightRefreshes.get(provider)!;
      return refreshed.accessToken;
    }
    const refreshPromise = (async () => {
      const bearer = await this.opts.getBearer();
      if (!bearer) {
        throw new Error("nicht angemeldet (für CRM-Refresh nötig)");
      }
      const tokens = await runRefreshFlow({
        provider,
        refreshToken: rec.tokens.refreshToken!,
        bearer,
        gatewayUrl: this.opts.gatewayUrl,
        orgUrl: rec.tokens.extra.orgUrl,
      });
      const lastRefreshedAt = new Date().toISOString();
      await saveTokens(provider, rec.account, tokens);
      this.records.set(provider, {
        ...rec,
        tokens,
        lastRefreshedAt,
        lastError: null,
      });
      this.emit("status", this.getStatus(provider));
      return tokens;
    })().finally(() => {
      this.inFlightRefreshes.delete(provider);
    });
    this.inFlightRefreshes.set(provider, refreshPromise);
    try {
      const tokens = await refreshPromise;
      return tokens.accessToken;
    } catch (err) {
      const existing = this.records.get(provider);
      if (existing) {
        existing.lastError = err instanceof Error ? err.message : String(err);
        this.emit("status", this.getStatus(provider));
      }
      return null;
    }
  }
}
