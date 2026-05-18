import type { AnthropicTierInfo } from "../../../shared/types";

// v0.1.209 — Anthropic-Tier-Detektor.
//
// Anthropic gibt auf JEDER `/v1/messages`-Antwort die aktuellen
// Rate-Limit-Schnappschüsse als HTTP-Header zurück:
//
//   anthropic-ratelimit-input-tokens-limit:     30000
//   anthropic-ratelimit-output-tokens-limit:    8000
//   anthropic-ratelimit-requests-limit:         50
//
// Diese Header sind die einzige zuverlässige Quelle, um den Account-
// Tier des Nutzers zu bestimmen. `/v1/models` setzt sie nicht; daher
// machen wir nach erfolgreicher `/v1/models`-Auth-Probe einen
// minimalen `/v1/messages`-Call:
//
//   - 1 Output-Token max → ~0,00002 USD bei Haiku (vernachlässigbar)
//   - Trivialer Prompt ("ping") → ~3 Input-Token
//   - Wir verwerfen den Body; nur die Header interessieren uns
//
// Wenn der Call aus irgendeinem Grund scheitert (Modell nicht
// verfügbar, Netzwerk-Fehler, parser-Issue), geben wir `null` zurück
// statt zu werfen. Tier-Info ist nice-to-have, kein
// Validierungsblocker — der API-Key wird trotzdem gespeichert.

// Wir nutzen `undici.fetch` aus demselben Grund wie `validate-key.ts`:
// Electron-Chromium-fetch stolpert auf älteren macOS-Hardened-Runtime-
// Builds über bestimmte Intermediate-Certs.
let probeFetch: typeof fetch = fetch;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const undici = require("undici") as { fetch?: typeof fetch };
  if (typeof undici.fetch === "function") {
    probeFetch = undici.fetch;
  }
} catch {
  /* keep global fetch */
}

const PROBE_TIMEOUT_MS = 5_000;

/**
 * Klassifiziert ein TPM-Limit in Anthropics inoffizielle Tier-Stufen.
 *
 * Stand 2026-05 (Anthropic ändert die genauen Schwellen ohne
 * Ankündigung; Banner-Text muss generisch genug bleiben):
 *
 *   ≤ 50 000  → tier-1
 *   ≤ 100 000 → tier-2
 *   >  100 000 → tier-3+
 *
 * Banner-UX zeigt NUR bei tier-1 einen Warnhinweis — tier-2 und
 * tier-3+ gelten als ausreichend für typische AVA-Recherchen.
 */
export function classifyAnthropicTier(
  inputTokensPerMinute: number,
): AnthropicTierInfo["tierLabel"] {
  if (inputTokensPerMinute <= 50_000) return "tier-1";
  if (inputTokensPerMinute <= 100_000) return "tier-2";
  return "tier-3+";
}

/**
 * Versucht, die TPM/RPM-Limits eines Anthropic-API-Keys zu ermitteln.
 * Returns `null` bei jedem Fehler — der Caller behandelt fehlende
 * Tier-Info gracefully (kein Banner, kein Persist).
 */
export async function detectAnthropicTier(
  apiKey: string,
  externalSignal?: AbortSignal,
): Promise<AnthropicTierInfo | null> {
  const ctrl = new AbortController();
  // Wenn der externe Signal cancelt, propagieren wir das.
  const onAbort = (): void => ctrl.abort();
  if (externalSignal) {
    if (externalSignal.aborted) ctrl.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);

  try {
    // Wir nehmen Haiku — kleinstes, billigstes, immer auf allen Tiers
    // verfügbares Modell. Falls Haiku mal aus dem Katalog fällt, wirft
    // Anthropic ein 404; das fangen wir als "Tier unbekannt" ab.
    const res = await probeFetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: ctrl.signal,
    });

    // Headers sind auch bei 4xx/5xx gesetzt, solange Anthropic
    // tatsächlich geantwortet hat. Wir lesen sie unabhängig vom
    // Status-Code. Nur Netzwerk-Errors (kein `res`) blocken.
    const inputLimit = parseHeaderInt(
      res.headers.get("anthropic-ratelimit-input-tokens-limit"),
    );
    const outputLimit = parseHeaderInt(
      res.headers.get("anthropic-ratelimit-output-tokens-limit"),
    );
    const requestsLimit = parseHeaderInt(
      res.headers.get("anthropic-ratelimit-requests-limit"),
    );

    if (inputLimit == null) {
      // Keine Header → Tier kann nicht bestimmt werden.
      return null;
    }

    return {
      inputTokensPerMinute: inputLimit,
      outputTokensPerMinute: outputLimit ?? 0,
      requestsPerMinute: requestsLimit ?? 0,
      tierLabel: classifyAnthropicTier(inputLimit),
      detectedAt: Date.now(),
    };
  } catch {
    // Netzwerk-Error / Timeout / Abort → Tier unbekannt. Nicht
    // werfen, der Key-Speichern-Flow soll trotzdem durchlaufen.
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  }
}

function parseHeaderInt(raw: string | null): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
