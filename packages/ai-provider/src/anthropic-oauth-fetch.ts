// Shared Anthropic-Subscription-OAuth fetch wrapper (v0.1.145).
//
// Anthropic's /v1/messages endpoint accepts two auth shapes:
//   1. `x-api-key: <key>` — classic API-Key path. Used by every backend
//      service and the desktop's chat path when the user pastes an API
//      key.
//   2. `Authorization: Bearer <token>` + `anthropic-beta: oauth-2025-04-20`
//      — subscription OAuth path. The token comes from Anthropic's
//      `claude setup-token` CLI; the request consumes the user's
//      Claude-Pro/Max-Abo quota instead of API credits.
//
// The subscription path has one extra quirk: the endpoint validates that
// the first system message contains the marker
//   "You are Claude Code, Anthropic's official CLI for Claude."
// Without it, /v1/messages returns an empty 400/403 that surfaces in the
// AI SDK as `Failed after 3 attempts. Last error: Error` (no body, no
// detail). Verified against opencode-anthropic-auth, ben-vargas's
// claude-code-action notes, and changjonathanc's anthropic-oauth-client
// reference implementations.
//
// This helper packages the bearer-injection + marker-prepending logic so
// BOTH call paths can share it:
//   - desktop main (`runtime.ts`'s opts-based `createLLM`)
//   - producer subprocess (`index.ts`'s env-based `getLLM`)
//
// The producer-side path reads the token from `ANTHROPIC_AUTH_TOKEN`
// (Anthropic's documented CI env var); the supervisor forwards it via
// `ProducerSupervisor.buildEnv()` when the user is in subscription mode.

/**
 * The exact string Anthropic's OAuth-authenticated /v1/messages endpoint
 * requires as the prefix of the first system message. Verified against
 * opencode-anthropic-auth + ben-vargas + changjonathanc references.
 */
export const CLAUDE_CODE_MARKER =
  "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Wrap a `fetch` so every outgoing request carries the Anthropic OAuth
 * bearer + the `anthropic-beta: oauth-2025-04-20` flag, with `x-api-key`
 * stripped. POSTs to `/v1/messages` additionally get
 * `CLAUDE_CODE_MARKER` prepended to the system message (string and
 * array forms handled; idempotent — never added twice).
 *
 * Returns a function with the same signature as the global `fetch`.
 */
export function makeAnthropicOAuthFetch(
  baseFetch: typeof fetch,
  subscriptionToken: string,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const next: RequestInit = { ...(init ?? {}) };
    const headers = new Headers(next.headers ?? {});
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${subscriptionToken}`);
    if (!headers.has("anthropic-beta")) {
      headers.set("anthropic-beta", "oauth-2025-04-20");
    }
    next.headers = headers;

    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.includes("/v1/messages") && typeof next.body === "string") {
      try {
        const parsed = JSON.parse(next.body) as {
          system?: string | Array<{ type: string; text: string }>;
          [k: string]: unknown;
        };
        if (typeof parsed.system === "string") {
          if (!parsed.system.startsWith(CLAUDE_CODE_MARKER)) {
            parsed.system = CLAUDE_CODE_MARKER + "\n\n" + parsed.system;
          }
        } else if (Array.isArray(parsed.system)) {
          const firstText = parsed.system[0]?.text;
          if (
            typeof firstText !== "string" ||
            !firstText.startsWith(CLAUDE_CODE_MARKER)
          ) {
            parsed.system.unshift({ type: "text", text: CLAUDE_CODE_MARKER });
          }
        } else {
          parsed.system = CLAUDE_CODE_MARKER;
        }
        next.body = JSON.stringify(parsed);
      } catch {
        /* body not JSON / not parseable — let the SDK handle it */
      }
    }

    return baseFetch(input, next);
  }) as typeof fetch;
}
