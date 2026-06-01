// v0.1.181 — Background OAuth refresh for the Anthropic In-App-Login.
//
// Problem this solves: the in-app OAuth flow (button "Mit Claude.ai
// verbinden") gives short-lived access tokens (typically 1-8 hours).
// Without an active refresh mechanism every producer that hits the
// Anthropic API after the token expires gets "Invalid authentication
// credentials" on every call and the entire import grinds to a halt
// until the user manually clicks "Neu verbinden". This refresher
// runs in the background and swaps the expired access_token for a
// fresh one via the stored refresh_token, well before it expires.
//
// Wiring:
//   - Started from main/index.ts after app.whenReady
//   - Reads/writes ProviderConfigStore's anthropic-subscription
//     record (now a JSON envelope incl. refresh_token + expiresAt)
//   - Calls auth/anthropic-oauth.refreshAccessToken on the schedule
//   - On successful refresh, the store fires
//     anthropicSubscriptionTokenChanged → the LlmProviderManager's
//     existing listener cycles the producer-supervisor with the
//     new env. Producers come back up with a fresh bearer.
//
// Failure modes + intentional non-retries:
//   - Refresh-Token rotation: some OAuth servers swap the
//     refresh_token on each refresh; the new one (if present in
//     the response) is persisted alongside the new access_token.
//   - Refresh-Token revoked / 401 from Anthropic: we DON'T retry.
//     The user has to re-authenticate. We log the failure +
//     emit a sentinel so the renderer can surface a "Sitzung
//     abgelaufen, bitte neu verbinden" toast (future v0.1.182+).
//   - Network error: silently retried on the next interval tick.
//
// We tune two intervals:
//   POLL_INTERVAL_MS    — how often the refresher wakes up to check
//   REFRESH_LEAD_MS     — how much time before expiry we trigger a
//                          refresh (must be > POLL_INTERVAL_MS so
//                          we don't miss the window)

import type { ProviderConfigStore } from "../agent/providers/store";
import { refreshAccessToken } from "./anthropic-oauth";
import { refreshAccessToken as refreshOpenAIAccessToken } from "./openai-oauth";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const REFRESH_LEAD_MS = 15 * 60 * 1000; // refresh when <15 min remain
const RETRY_BACKOFF_MS = 60 * 1000; // brief backoff after a transient fail

export class AnthropicTokenRefresher {
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  /** Last error reported by a refresh attempt; cleared on success.
   *  Renderer-facing IPC can surface this so the user knows refresh
   *  is broken before they kick off an import. */
  private lastError: string | null = null;
  /** When the last successful refresh ran (debug + telemetry). */
  private lastSuccessAt: number | null = null;

  constructor(private readonly store: ProviderConfigStore) {}

  /**
   * Start the periodic refresher. Idempotent — re-calling is a no-op
   * if already running.
   */
  start(): void {
    if (this.timer != null) return;
    // Run once on startup so a long-stale token gets a fresh access
    // token before the user kicks off an import. Then on interval.
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Public status snapshot for IPC / Settings UI. Renderer reads this
   * to show "Token läuft in X min ab" or "Refresh fehlgeschlagen — bitte
   * neu verbinden".
   */
  getStatus(): {
    hasToken: boolean;
    expiresAt: number;
    refreshableUntilNextLogin: boolean;
    lastError: string | null;
    lastSuccessAt: number | null;
  } {
    // Synchronous access not possible because getAnthropicSubscriptionRecord
    // is async; caller polls via IPC and we expose the cached-from-last-tick
    // snapshot. For v1 we just expose the lastError + lastSuccessAt fields;
    // the hasToken / expiresAt fields are surfaced via separate IPC that
    // reads the store directly.
    return {
      hasToken: false, // filled in by IPC handler synchronously
      expiresAt: 0,
      refreshableUntilNextLogin: false,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  /**
   * One iteration of the refresh loop. Public for tests / debug; the
   * timer triggers it automatically.
   */
  async tick(): Promise<void> {
    if (this.refreshInFlight) {
      // Another tick is still working. Skip; we'll catch up on the
      // next interval if needed.
      return;
    }
    this.refreshInFlight = true;
    try {
      const record = await this.store.getAnthropicSubscriptionRecord();
      if (!record) return; // no subscription token at all -> nothing to do
      // expiresAt === 0 means "non-refreshable" (legacy or
      // Advanced/manual-paste). Skip silently.
      if (!record.refreshToken || record.expiresAt === 0) return;

      const msUntilExpiry = record.expiresAt - Date.now();
      if (msUntilExpiry > REFRESH_LEAD_MS) return; // still fresh enough

      console.info(
        `[anthropic-refresh] tick: token expires in ${Math.round(msUntilExpiry / 1000)}s, refreshing now`,
      );

      try {
        const refreshed = await refreshAccessToken({
          refreshToken: record.refreshToken,
        });
        const newExpiresAt =
          refreshed.expiresIn != null
            ? Date.now() + refreshed.expiresIn * 1000
            : Date.now() + 60 * 60 * 1000; // assume 1h if server didn't say
        this.store.setAnthropicSubscriptionRecord({
          accessToken: refreshed.accessToken,
          // Some servers rotate refresh_tokens, some keep the same one.
          // Prefer the response's value when present; otherwise keep the
          // old one (so the next refresh still works).
          refreshToken: refreshed.refreshToken ?? record.refreshToken,
          expiresAt: newExpiresAt,
        });
        this.lastError = null;
        this.lastSuccessAt = Date.now();
        console.info(
          `[anthropic-refresh] refreshed OK, new expiry in ${Math.round((newExpiresAt - Date.now()) / 1000)}s`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as Error & { status?: number }).status;
        this.lastError = msg;
        if (status === 400 || status === 401) {
          // Refresh-Token revoked / expired. No point in retrying.
          // Leave the access_token in place (it might still be valid
          // for a short while) and let the user re-authenticate.
          console.warn(
            `[anthropic-refresh] refresh rejected (HTTP ${status}): ${msg}. ` +
              `User must re-connect via Settings → Anthropic → "Neu verbinden".`,
          );
        } else {
          // Transient error (network etc.) — try again on the next
          // tick. No exponential backoff yet; if this becomes a
          // problem in practice we can add one.
          console.warn(
            `[anthropic-refresh] refresh failed transiently: ${msg}. Will retry on next tick.`,
          );
          // Quick retry on transient errors so the user doesn't have
          // to wait the full 5min interval.
          setTimeout(() => {
            void this.tick();
          }, RETRY_BACKOFF_MS);
        }
      }
    } finally {
      this.refreshInFlight = false;
    }
  }

  /**
   * v0.1.192 — reactive on-demand refresh.
   *
   * `tick()` is conservative: it only refreshes when the access-token
   * is <15 min from expiry. That's right for the scheduled poll but
   * wrong when a producer just hit a 401 — by then the token is
   * already dead and waiting for the next scheduled tick is too late.
   * Call this when an LLM provider rejected our credentials and we
   * want to attempt recovery immediately.
   *
   * Returns a structured result so the caller can decide how to react:
   *   - "refreshed"          — new token landed; producers should cycle
   *                            to pick up the new env.
   *   - "no_refresh_token"   — legacy record (pre-v0.1.181) without a
   *                            refresh_token. Only recovery path is
   *                            the user re-doing the OAuth flow.
   *   - "revoked"            — refresh_token itself was rejected (400 /
   *                            401). User has to re-authenticate.
   *   - "transient"          — network / 5xx. Caller may retry; the
   *                            scheduled tick will also retry on its
   *                            own interval.
   *   - "no_record"          — no subscription token stored at all
   *                            (api-key user, or fully signed out).
   *                            Caller likely shouldn't have called us.
   */
  async refreshNow(): Promise<
    | { status: "refreshed" }
    | { status: "no_refresh_token" }
    | { status: "revoked"; error: string }
    | { status: "transient"; error: string }
    | { status: "no_record" }
  > {
    if (this.refreshInFlight) {
      // A scheduled tick is already running. Wait briefly so we don't
      // double-refresh, then fall through to a fresh check. The tick's
      // own conservative gate (<15 min remaining) means it might have
      // skipped — in that case we still want to force a refresh.
      await new Promise((r) => setTimeout(r, 250));
    }
    this.refreshInFlight = true;
    try {
      const record = await this.store.getAnthropicSubscriptionRecord();
      if (!record) return { status: "no_record" };
      if (!record.refreshToken) return { status: "no_refresh_token" };

      try {
        const refreshed = await refreshAccessToken({
          refreshToken: record.refreshToken,
        });
        const newExpiresAt =
          refreshed.expiresIn != null
            ? Date.now() + refreshed.expiresIn * 1000
            : Date.now() + 60 * 60 * 1000;
        this.store.setAnthropicSubscriptionRecord({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? record.refreshToken,
          expiresAt: newExpiresAt,
        });
        this.lastError = null;
        this.lastSuccessAt = Date.now();
        console.info(
          `[anthropic-refresh] forced refresh OK, new expiry in ${Math.round((newExpiresAt - Date.now()) / 1000)}s`,
        );
        return { status: "refreshed" };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as Error & { status?: number }).status;
        this.lastError = msg;
        if (status === 400 || status === 401) {
          console.warn(
            `[anthropic-refresh] forced refresh rejected (HTTP ${status}): ${msg}`,
          );
          return { status: "revoked", error: msg };
        }
        console.warn(
          `[anthropic-refresh] forced refresh transient failure: ${msg}`,
        );
        return { status: "transient", error: msg };
      }
    } finally {
      this.refreshInFlight = false;
    }
  }
}

/**
 * v0.1.353 — Pendant zu `AnthropicTokenRefresher` für den ChatGPT-Abo-
 * OAuth-Flow („Sign in with ChatGPT"). Hält das kurzlebige Codex-
 * Access-Token via gespeichertem refresh_token frisch. Account-ID
 * bleibt über Refreshs hinweg stabil (sie hängt am Konto, nicht am
 * Token), also tragen wir sie unverändert in den neuen Record.
 */
export class OpenAITokenRefresher {
  private timer: NodeJS.Timeout | null = null;
  private refreshInFlight = false;
  private lastError: string | null = null;
  private lastSuccessAt: number | null = null;

  constructor(private readonly store: ProviderConfigStore) {}

  start(): void {
    if (this.timer != null) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.refreshInFlight) return;
    this.refreshInFlight = true;
    try {
      const record = await this.store.getOpenAISubscriptionRecord();
      if (!record) return;
      if (!record.refreshToken || record.expiresAt === 0) return;
      const msUntilExpiry = record.expiresAt - Date.now();
      if (msUntilExpiry > REFRESH_LEAD_MS) return;

      console.info(
        `[openai-refresh] tick: token expires in ${Math.round(msUntilExpiry / 1000)}s, refreshing now`,
      );
      try {
        const refreshed = await refreshOpenAIAccessToken({
          refreshToken: record.refreshToken,
        });
        const newExpiresAt =
          refreshed.expiresIn != null
            ? Date.now() + refreshed.expiresIn * 1000
            : Date.now() + 60 * 60 * 1000;
        this.store.setOpenAISubscriptionRecord({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken ?? record.refreshToken,
          expiresAt: newExpiresAt,
          // Account-ID bevorzugt aus dem frischen Token, sonst die alte.
          accountId: refreshed.accountId ?? record.accountId,
        });
        this.lastError = null;
        this.lastSuccessAt = Date.now();
        console.info(
          `[openai-refresh] refreshed OK, new expiry in ${Math.round((newExpiresAt - Date.now()) / 1000)}s`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = (err as Error & { status?: number }).status;
        this.lastError = msg;
        if (status === 400 || status === 401) {
          console.warn(
            `[openai-refresh] refresh rejected (HTTP ${status}): ${msg}. User must re-connect via Settings → ChatGPT.`,
          );
        } else {
          console.warn(
            `[openai-refresh] refresh failed transiently: ${msg}. Will retry on next tick.`,
          );
          setTimeout(() => {
            void this.tick();
          }, RETRY_BACKOFF_MS);
        }
      }
    } finally {
      this.refreshInFlight = false;
    }
  }
}
