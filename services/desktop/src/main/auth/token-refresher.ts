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
import { refreshAccessToken as refreshOpenAIAccessToken } from "./openai-oauth";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const REFRESH_LEAD_MS = 15 * 60 * 1000; // refresh when <15 min remain
const RETRY_BACKOFF_MS = 60 * 1000; // brief backoff after a transient fail

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
