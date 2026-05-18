# Anthropic-Tier-UX (v0.1.209)

> Status: Build · Ziel: v0.1.209
> Related: `validate-key.ts`, `ai-sdk-provider.ts`, `ApiKeyCard`, `FirstRunWizard`

## 1 — Problem

Nicht-technische Nutzer beschaffen sich mit großer Hürde einen Anthropic-API-Key, laden Guthaben auf, tragen den Key in AVA ein — und werden beim ersten ernsthaften Chat-Turn mit einer englischen 429-Fehlermeldung („30 000 input tokens per minute") begrüßt. Anthropic gibt Tier-1-Accounts standardmäßig nur 30 k Input-TPM, was AVAs Tool-Registry + Systemprompt schon im Erst-Request fast vollständig ausschöpft.

Das Onboarding wirkt damit kaputt — obwohl der Schlüssel korrekt ist und der Account funktioniert. Wir müssen den Schmerz vor unsere Tür holen und übersetzt + actionable präsentieren.

## 2 — Ziel

Drei Lieferungen in v0.1.209:

1. **Tier-Erkennung beim Key-Eintragen.** Wenn der Nutzer einen Anthropic-API-Key speichert, ermitteln wir die TPM-/RPM-Limits seines Accounts und zeigen direkt unter dem Eingabefeld einen freundlichen Hinweis — bei Tier 1 mit Deeplink zur richtigen Anthropic-Console-Seite und Erklärung des Upgrade-Pfads.
2. **Tier-Persistenz.** Letzten ermittelten Tier-Stand im ProviderStore halten, damit die UI auch ohne aktiven Probe-Call den Tier-Stand kennt (z. B. in der 429-Fehlermeldung).
3. **Bessere 429-Übersetzung.** Existierende `humanizeProviderError` aufrüsten: deutsche Fehlermeldung mit konkretem Tier-Hinweis, Wartezeit aus `retry-after`-Header, und Deeplink zur Anthropic-Console.

Ausdrücklich **nicht in v0.1.209** (Folge-Releases):
- TPM-Drossel im Mainprozess (Pacing) → v0.1.210.
- Automatischer Retry mit Backoff → v0.1.210 (braucht Orchestrator-Refactor).
- Onboarding-Wizard mit Screenshot-Erklärung → später, wenn 1+3 nicht ausreichen.

## 3 — Anthropic-Header-Quelle

Anthropic gibt auf `/v1/messages` (nicht aber zwingend auf `/v1/models`) Rate-Limit-Header zurück:

```
anthropic-ratelimit-input-tokens-limit:      30000
anthropic-ratelimit-input-tokens-remaining:  29980
anthropic-ratelimit-input-tokens-reset:      2026-05-18T13:42:00Z
anthropic-ratelimit-output-tokens-limit:     8000
anthropic-ratelimit-requests-limit:          50
```

Validierung mit `/v1/models` reicht uns also nicht. Wir machen einen winzigen Mini-Call gegen `/v1/messages` mit `max_tokens: 1` und einem trivialen Prompt. Kosten: ~0,00002 USD (Haiku). Akzeptabel als „Onboarding-Probe".

Tier-Klassifizierung anhand `input-tokens-limit`:
- ≤ 50 000 → **Tier 1** (warnen)
- ≤ 100 000 → **Tier 2** (ok, neutral)
- > 100 000 → **Tier 3+** (kein Hinweis nötig)

Werte sind grob — Anthropic ändert das. Banner-Text muss generisch genug bleiben.

## 4 — Architektur

```
                ┌─────────────────────────┐
  Renderer ──→  │ window.api.agent        │
                │   .validateApiKey(…)    │
                └────────────┬────────────┘
                             │ IPC
                             ▼
                ┌─────────────────────────┐
  Main process │ providers.validateApiKey│
                │   → validate-key.ts     │
                └────────────┬────────────┘
                             │
              ┌──────────────┴───────────────┐
              ▼                              ▼
  ┌─────────────────────┐         ┌─────────────────────┐
  │ probeAnthropic()    │  ok →   │ detectAnthropicTier │
  │ GET /v1/models      │  ──→    │ POST /v1/messages   │
  │                     │         │ max_tokens=1        │
  │                     │         │ reads RL-headers    │
  └─────────────────────┘         └─────────────────────┘
              │                              │
              └──────────────┬───────────────┘
                             ▼
                ┌─────────────────────────┐
                │ KeyValidation {         │
                │   ok: true,             │
                │   tierInfo?: {…}        │  ← neu
                │ }                       │
                └─────────────────────────┘
```

Bei `setApiKey()`: Nach erfolgreichem Save persistieren wir `tierInfo` im ProviderStore neben dem Key. Renderer fragt das via `getProviderConfig` ab (existiert schon).

## 5 — Typen (`shared/types.ts`)

```ts
/** v0.1.209 — TPM/RPM-Schnappschuss aus Anthropic-`/v1/messages`-Headern. */
export interface AnthropicTierInfo {
  inputTokensPerMinute: number;
  outputTokensPerMinute: number;
  requestsPerMinute: number;
  /** "tier-1" | "tier-2" | "tier-3+". Heuristisch aus inputTokensPerMinute. */
  tierLabel: "tier-1" | "tier-2" | "tier-3+";
  /** epoch ms — letzter Probe-Zeitpunkt. Banner zeigt Daten älter als
   *  24h als "veraltet" (ggf. Re-Probe vorschlagen). */
  detectedAt: number;
}

export type ApiKeyValidation =
  | { ok: true; tierInfo?: AnthropicTierInfo }   // tierInfo NUR Anthropic
  | { ok: false; reason: string };
```

`ProviderConfigBundle` bekommt:
```ts
anthropicTierInfo?: AnthropicTierInfo | null;
```

## 6 — Renderer-UI

### 6.1 Banner-Komponente (neu)

`services/desktop/src/renderer/src/components/AnthropicTierBanner.tsx`:

```tsx
export function AnthropicTierBanner({ tier }: { tier: AnthropicTierInfo }) {
  if (tier.tierLabel !== "tier-1") return null;
  return (
    <div className="tier-banner tier-banner--warn">
      <strong>Hinweis:</strong> Dein Anthropic-Account ist auf Tier 1
      ({tier.inputTokensPerMinute.toLocaleString("de-DE")} Input-Token/Min).
      Bei längeren Recherchen kann das knapp werden.
      <p>
        Tier 2 verdoppelt das Limit und schaltet sich automatisch frei,
        sobald 5 USD über die API verbraucht oder via Vorauszahlung
        eingezahlt wurden — kein Antrag nötig.
      </p>
      <a onClick={openConsole}>Anthropic-Console öffnen → Limits</a>
    </div>
  );
}
```

Wird unterhalb von `ApiKeyCard` für Anthropic eingehängt **und** in `ApiKeySubForm` (FirstRunWizard) nach erfolgreichem Validate.

### 6.2 ApiKeyCard-Anpassung

`save.mutationFn` ruft heute nur `setApiKey`. Wir erweitern auf:
1. Validate (für alle Provider, wie der Wizard).
2. Wenn ok → setApiKey + setProvider.
3. Im success-state das `tierInfo` aus dem cfg-Query ablesen und Banner rendern.

### 6.3 FirstRunWizard

`ApiKeySubForm` ruft schon `validateApiKey` auf. Wir konsumieren das `tierInfo` daraus und rendern das Banner — Nutzer sieht Tier 1 _direkt im Onboarding_, kann sofort entscheiden, ob er den Upgrade-Klick noch vor dem ersten Chat-Turn macht.

## 7 — Fehlermeldungs-Update (`ai-sdk-provider.ts`)

`humanizeProviderError` für Anthropic + 429 erweitern:

```ts
// Anthropic-spezifisch: Tier-Hinweis + Console-Link in den Fehlertext einbauen.
// Renderer rendert errorMessage als plain text — Link wird als URL erkennbar.
return (
  `Anthropic: Minutenlimit erreicht${limitDetail}. Bitte 30–60 Sekunden warten.\n\n` +
  `Tipp: Anthropic-Tier-2 verdoppelt das Limit und schaltet sich automatisch ` +
  `frei, sobald 5 USD verbraucht oder eingezahlt sind. Status prüfen: ` +
  `https://console.anthropic.com/settings/limits`
);
```

Plus: wenn der raw-Error eine `retry-after`-Sekundenzahl enthält (Anthropic packt das manchmal in den Body), surface den konkreten Wartewert.

## 8 — Code-Punkte (Implementierungsreihenfolge)

1. `shared/types.ts` — `AnthropicTierInfo`, `ApiKeyValidation`, `ProviderConfigBundle`.
2. `anthropic-tier.ts` (neu) — `detectAnthropicTier(apiKey, signal)`.
3. `validate-key.ts` — Anthropic-Probe ruft danach `detectAnthropicTier`, packt in Ergebnis.
4. `providers/store.ts` — `tierInfo` persistieren neben dem Key.
5. `providers/manager.ts` — `setApiKey` schreibt auch das `tierInfo`, `getProviderConfig` liest es.
6. IPC unverändert (das Ergebnis fließt durch).
7. `AnthropicTierBanner.tsx` (neu).
8. `Settings.tsx` (ApiKeyCard) — Banner einhängen.
9. `FirstRunWizard.tsx` — Banner einhängen.
10. `styles.css` — `.tier-banner` Stil.
11. `ai-sdk-provider.ts` — `humanizeProviderError` für Anthropic-429 mit Console-Link.
12. `package.json` → 0.1.209.
13. Commit + Tag + Push.

## 9 — Akzeptanzkriterien

- Nutzer trägt einen frischen Anthropic-Key (Tier 1) ein → Banner mit Console-Link erscheint **unterhalb** der Key-Karte.
- Nutzer trägt denselben Key im FirstRunWizard ein → Banner erscheint nach dem „Testen"-Klick, **vor** dem nächsten Schritt.
- 429 im laufenden Chat zeigt deutsche Meldung mit konkretem Wartehinweis und dem Console-Deeplink.
- Tier-Info bleibt nach App-Restart erhalten (im Provider-Store persistiert).
- Existing Validate-Pfade für OpenAI/Google/Mistral bleiben unverändert (`tierInfo` ist optional).

## 10 — Followup-Notizen für v0.1.210+

- TPM-Drossel im Mainprozess: Token-Counter über die letzten 60 s, drossle wenn nächster Call das Limit reißen würde.
- Auto-Retry mit Backoff: Orchestrator-seitig nach 429 einmal warten + retry. Aktuell Hard-Fail.
- Onboarding-Wizard mit Screenshots: nur falls 1+3 nicht reicht.
