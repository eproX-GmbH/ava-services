# Token-Verbrauchs-Tab in Einstellungen

> Status: Plan (v0.1.208+1)
> Author: Joyce (Anfrage) · Implementation TBD
> Related: `PLANS_chart_skill.md`, `audit-store.ts` (storage pattern), `ai-sdk-provider.ts` (capture hook)

## 1 — Motivation

Nutzer können in AVA zwischen LLM-Anbietern und Modellen wechseln (Settings → Modelle), und im Hintergrund laufen LLM-getriebene Producer-Stages (profile, contact, evaluation, publications, website). Aktuell hat der Nutzer **keinen Einblick**, wie sich diese Auswahl auf den Token-Verbrauch auswirkt:

- Im Chat ist sichtbar, dass Tokens verbraucht werden, aber nicht wie viele.
- Producer-Stages laufen autonom — der Nutzer sieht nur den Status, nicht den Verbrauch.
- Bei Anthropic mit Pro/Max-Abo (OAuth) entstehen keine API-Kosten, aber Quota wird verbraucht — auch das ist intransparent.
- Beim Wechsel z.B. von `claude-sonnet-4` auf `claude-opus-4` ändert sich die $/MTok-Rate um Faktor 5; Nutzer braucht eine Entscheidungsgrundlage.

**Ziel**: Ein „Verbrauch"-Tab in den Einstellungen, der den (ungefähren) täglichen Token-Verbrauch graphisch zeigt, aufgeschlüsselt nach Modell und Quelle (Chat vs. Producer-X).

## 2 — Design-Prinzipien

Dieselben Prinzipien wie beim Audit-Trail (v0.1.200):

- **Lokal & privat**: Daten landen in einer eigenen PGlite-DB im UserData-Verzeichnis. Kein Upload zu Fly. (Token-Counts könnten verraten, wie aktiv ein Tenant ist — geht den Operator nichts an.)
- **Best-effort, nicht abrechnungsrelevant**: Die Zahlen sind „ungefähr" (wie vom Nutzer formuliert). Kein Abrechnungsanspruch.
- **Lieber zu viel als zu wenig protokollieren**: Wir schreiben pro Call eine Zeile; aggregieren erst beim Lesen. Reicht für viele tausend Calls/Tag bei Sub-MB-DB-Wachstum.
- **Wiederverwendung**: Storage-Pattern aus `audit-store.ts` klonen. Renderer-seitig Chart-Komponente aus `ChatChart.tsx` wiederverwenden (oder erweitern für stacked bars).
- **Fail-open**: Wenn die Erfassung scheitert (z.B. unbekanntes Provider-Antwortformat), darf das LLM-Call nicht failen. Logger schluckt Fehler, Mainprozess läuft weiter.

## 3 — Datenmodell

### 3.1 Eine Zeile pro LLM-Call

`usage_log`-Tabelle (PGlite, im Main-Process):

```sql
CREATE TABLE usage_log (
  id              TEXT PRIMARY KEY,           -- uuid
  timestamp       TIMESTAMPTZ NOT NULL,
  provider        TEXT NOT NULL,              -- "anthropic" | "openai" | "google" | "mistral" | "ollama"
  model           TEXT NOT NULL,              -- z.B. "claude-sonnet-4-20250514"
  source          TEXT NOT NULL,              -- "chat" | "producer:profile" | "producer:website" | "watch" | "alert-judge"
  conversation_id TEXT,                       -- optional, nur bei source=chat
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
  estimated_usd   REAL,                       -- NULL bei Anthropic-OAuth-Subscription (kein API-Preis)
  metadata        JSONB                       -- Frei für Provider-spezifisches (rate-limit headers, finish_reason, …)
);
CREATE INDEX usage_log_timestamp_idx ON usage_log (timestamp DESC);
CREATE INDEX usage_log_provider_model_idx ON usage_log (provider, model);
CREATE INDEX usage_log_source_idx ON usage_log (source);
```

### 3.2 TypeScript-Typen

`shared/types.ts`:

```ts
export type UsageSource =
  | { kind: "chat"; conversationId: string }
  | { kind: "producer"; name: string }      // "profile" | "contact" | "website" | …
  | { kind: "watch" }
  | { kind: "alert-judge" }
  | { kind: "other"; label: string };

export interface UsageEvent {
  id: string;
  timestamp: number;                         // epoch ms
  provider: LlmProviderKind;
  model: string;
  source: UsageSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number | null;
  metadata?: Record<string, unknown>;
}

export interface UsageDailyBucket {
  day: string;                                // "YYYY-MM-DD" (UTC)
  byModel: Array<{
    provider: LlmProviderKind;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsd: number | null;
    calls: number;
  }>;
  bySource: Array<{
    source: string;                           // serialized UsageSource
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedUsd: number | null;
    calls: number;
  }>;
}
```

## 4 — Preise (Kosten-Schätzung)

`packages/ai-provider/src/catalog.ts` um Preise pro Modell erweitern:

```ts
export interface ModelPricing {
  inputPerMTok: number;        // USD pro 1 Mio. Input-Token
  outputPerMTok: number;
  cacheReadPerMTok?: number;   // Anthropic prompt-caching read
  cacheWritePerMTok?: number;  // Anthropic prompt-caching write (5min ephemeral)
}
```

Quellen (Stand 2026-05):
- Anthropic: <https://www.anthropic.com/pricing>
- OpenAI: <https://openai.com/api/pricing/>
- Google: <https://ai.google.dev/pricing>
- Mistral: <https://mistral.ai/technology/#pricing>
- Ollama: $0

**Sonderfall Anthropic-OAuth-Subscription**: Wenn der Provider die OAuth-Token-Quelle benutzt (Claude Pro/Max), ist `estimated_usd = NULL`. Im UI als „Im Abo enthalten" rendern; Tokens trotzdem zeigen, weil Quota im Abo limitiert ist.

Preise sind Schätzungen, jährlich nachpflegen. Im UI Hinweistext: „Preise Stand 2026-05; tatsächliche Anbieter-Abrechnung kann abweichen".

## 5 — Capture-Punkte

### 5.1 Desktop-Hauptprozess (Chat-Loop)

`services/desktop/src/main/agent/providers/ai-sdk-provider.ts`:

- Im `streamText`-Loop bei `case "finish"` haben wir `(part as any).totalUsage` (AI-SDK v5). Daraus `inputTokens`, `outputTokens`, ggf. `cacheReadInputTokens`, `cacheCreationInputTokens` (Anthropic-spezifisch).
- Sofort danach `usageStore.record({ provider, model, source: { kind: "chat", conversationId }, ... })`.
- Provider+Model kennt die AISdkProvider-Instanz schon (`this.kind`, `this.model`). `conversationId` muss durchgereicht werden — heute kennt der Provider den nicht. Lösung: `chatComplete()` bekommt einen zusätzlichen `usageContext`-Parameter, den der Orchestrator (`orchestrator.ts`) setzt.

### 5.2 Producer-Subprozesse

Producer laufen außerhalb des Mainprozesses. Sie schreiben Audit-Marker auf stdout (`__AVA_AUDIT__<json>__/AVA_AUDIT__`, v0.1.201). Genau dasselbe Pattern für Usage:

- Konvention: `__AVA_USAGE__<json>__/AVA_USAGE__` pro LLM-Call.
- `producer-supervisor.ts` bekommt `detectUsageMarker()` analog zu `detectAuditMarker()`.
- Marker-Inhalt: `{ provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, source: "producer:<name>" }` (source wird im Supervisor injiziert basierend auf welcher Producer das emittiert hat).
- Im `@ava/ai-provider` (gevendor't in jedem Producer-Submodul): `createLLM()` wrappt das zurückgegebene LanguageModel so, dass nach jedem Call der Marker emittiert wird. Genau eine Code-Stelle → vendor-drift-CI fängt Inkonsistenzen.

### 5.3 OAuth-Subscription-Pfad

`packages/ai-provider/src/anthropic-oauth-fetch.ts` macht den `/v1/messages`-Call selbst (nicht via AI SDK). Hier explizit aus dem Response-JSON `usage.input_tokens`/`usage.output_tokens`/`usage.cache_*_input_tokens` extrahieren und emittieren.

## 6 — Persistence-Layer (`usage-store.ts`)

Analog `audit-store.ts`:

- `services/desktop/src/main/usage/usage-store.ts`
- Klasse `UsageStore` mit:
  - `record(input: Omit<UsageEvent, "id" | "timestamp">): Promise<void>`
  - `list(query: UsageListQuery): Promise<UsageEvent[]>` — Pagination wie AuditStore
  - `daily(rangeDays: number): Promise<UsageDailyBucket[]>` — Aggregation via SQL `date_trunc('day', timestamp)` + `GROUP BY day, model`
  - `purgeOlderThan(days: number): Promise<number>` — Retention
- Eigenes PGlite-File: `userData/usage.db`.
- Boot-time-Schema-Migration (idempotent).

## 7 — IPC

`main/index.ts`:
- `ipcMain.handle("usage:daily", (_, days: number) => usageStore.daily(days))`
- `ipcMain.handle("usage:list", (_, query: UsageListQuery) => usageStore.list(query))`
- `ipcMain.handle("usage:purgeAll", () => usageStore.purgeAll())`

`preload/index.ts`: 1:1 Bridge.

## 8 — UI

### 8.1 Tab-Registrierung

`Settings.tsx` → `SETTINGS_TABS` erweitern:

```ts
export const SETTINGS_TABS = [
  { id: "konto",        label: "Konto" },
  { id: "modelle",      label: "Modelle" },
  { id: "verbrauch",    label: "Verbrauch" },   // <-- neu, zwischen Modelle und Datenquellen
  { id: "datenquellen", label: "Datenquellen" },
  { id: "skills",       label: "Skills" },
  { id: "verlauf",      label: "Verlauf" },
  { id: "system",       label: "System" },
] as const;
```

### 8.2 Komponente `VerbrauchTab.tsx`

`services/desktop/src/renderer/src/routes/settings/VerbrauchTab.tsx`:

- **Zeitraum-Selector**: 7 Tage (Default) / 30 Tage / 90 Tage.
- **Einheits-Toggle**: Tokens / USD.
- **Hauptdiagramm**: Gestapeltes Balkendiagramm (1 Balken pro Tag), gestapelt nach Modell. Hover-Tooltip zeigt Modell-Breakdown.
- **Sekundärdiagramm**: Donut/Pie „Verbrauch nach Quelle" (Chat vs. Producer-X) für den gewählten Zeitraum.
- **Tabelle**: Top-N-Modelle dieser Periode mit Input/Output/Cache-Read/Cache-Write/Calls/USD-Summe.
- **Anthropic-OAuth-Hinweisbanner**: Wenn ≥1 Eintrag mit `estimatedUsd = NULL` im Zeitraum: „Anmeldung über Claude-Abo — Tokens zählen gegen dein Abo-Quota, keine API-Kosten."
- **Letzter Datenpunkt**: Klein darunter, wann das letzte LLM-Call protokolliert wurde (Sanity-Check für „kommen überhaupt Daten an?").

### 8.3 Stacked-Bar-Renderer

`ChatChart.tsx` unterstützt heute keine Stacks. Zwei Optionen:

- (a) `chart-spec`-Schema um `stacked: boolean` erweitern und `ChatChart` darum erweitern. Dann auch für Agent-emittierte Charts verfügbar.
- (b) Inline-SVG in `VerbrauchTab.tsx`, weil nur dieser eine Use-Case Stacking braucht.

**Empfehlung**: (a) — kleine Erweiterung in `chart-spec.ts` (`stacked?: boolean`, default false) + `renderBar()`-Pfad in `ChatChart.tsx` für stacked, +nebenbei Agent kann selbst stacked Charts emittieren. Aufwand ~2h, langfristiger Wert höher.

## 9 — Phasen (Workstreams)

### P1 — Storage + Capture im Mainprozess (1 Tag)
- [ ] `usage-store.ts` (PGlite-Klasse, Schema, record/daily/list)
- [ ] `shared/types.ts`: UsageEvent, UsageSource, UsageDailyBucket
- [ ] `catalog.ts`: ModelPricing-Map (initial: Top-10-Modelle, Rest fallback NULL)
- [ ] `ai-sdk-provider.ts`: Usage aus `finish`-Frame extrahieren, an Store weiterreichen
- [ ] `orchestrator.ts`: `conversationId` als UsageContext durchreichen
- [ ] IPC: `usage:daily`, `usage:list`, `usage:purgeAll`
- [ ] **Akzeptanzkriterium**: nach einer Chat-Session steht im Settings-Tab (sobald gebaut) eine plausible Zahl

### P2 — UI (1 Tag)
- [ ] `chart-spec.ts`: `stacked?: boolean`
- [ ] `ChatChart.tsx`: stacked-bar-Pfad
- [ ] `VerbrauchTab.tsx`: 7/30/90-Selector, Hauptdiagramm, Source-Donut, Top-Modelle-Tabelle, OAuth-Banner
- [ ] `Settings.tsx`: Tab-Registrierung + Routing
- [ ] CSS in `styles.css` (Selector-Pillen, Tabelle, Donut)
- [ ] **Akzeptanzkriterium**: Sichtbar im Build, zeigt echte Daten aus Chat-Calls

### P3 — Producer-Capture (1 Tag, sequentiell nach P1)
- [ ] `packages/ai-provider/src/runtime.ts`: createLLM-Wrapper, der nach jedem Call einen `__AVA_USAGE__`-Marker auf stdout schreibt
- [ ] Vendor-Sync in alle Producer-Submodule (`scripts/vendor-ai-provider.mjs`) + Drift-Check (analog Audit-Marker)
- [ ] `producer-supervisor.ts`: `detectUsageMarker()` und an `usageStore.record()` weiterreichen
- [ ] OAuth-Subscription-Pfad in `anthropic-oauth-fetch.ts`: usage aus Response-JSON
- [ ] **Akzeptanzkriterium**: Nach einem End-to-end Producer-Run erscheinen Producer-Calls im Tab mit `source: "producer:<name>"`

### P4 — Retention + Robustheit (0.5 Tage)
- [ ] Boot-time `purgeOlderThan(180)` — 6 Monate reichen für „täglich" anzeigen
- [ ] In Settings: „Verbrauchsdaten löschen"-Button (analog Audit-Tab)
- [ ] Größenlimit-Schutz: wenn `usage.db > 100MB`, oldest-first beim Boot purgen
- [ ] **Akzeptanzkriterium**: Disk-Wachstum bleibt unter 50MB/Jahr bei normalem Use

### P5 — Optional / Followups
- [ ] CSV-Export pro Zeitraum (für Steuerberatung)
- [ ] Drill-down: Klick auf einen Tag → Liste aller Calls dieses Tages
- [ ] Preis-Tabelle in einer eigenen kleinen Settings-Sektion sichtbar machen („Welche Modelle kosten was?")
- [ ] Topbar-Pill bei „auffälligem" Verbrauch (z.B. >5x Median letzter 7 Tage)

## 10 — Offene Entscheidungen (User-Input nötig)

1. **Token vs. USD im Default-View**: Welche Einheit ist Default? Vorschlag: USD (das ist das, was Nutzer interessiert). User-Toggle bleibt.
2. **Retention**: 6 Monate ok, oder lieber 12? Plattendruck ist gering.
3. **Producer-Capture Reihenfolge**: P3 erst nach P1+P2 (= Tab existiert und zeigt Chat-only), oder parallel? Vorschlag: erst P1+P2 liefern (Tab existiert, zeigt was), dann P3 als Aufstockung — so kommt früher Wert.
4. **Stacked-bar in ChatChart vs. eigene Komponente**: 9.3 (a) (mit Schema-Erweiterung) oder (b) (lokale Inline-Komponente)?
5. **Anthropic-OAuth-Quota**: Können wir aus dem Response-Header rauslesen, wie viel vom Abo-Quota noch übrig ist? Wenn ja: zusätzliche „Im Abo verbleibend"-Anzeige. Wenn nein: stille Annahme.

## 11 — Risiken

- **Token-Counts in AI-SDK-`finish`-Frame nicht immer befüllt**: bei Stream-Abbrüchen kann `totalUsage` fehlen. Mitigation: Wenn fehlt, NULL eintragen statt 0 (sonst täuscht der Tab Genauigkeit vor).
- **Producer-stdout-Marker können bei sehr hochfrequenten Calls (Embedder!) den Supervisor fluten**: Embedder-Calls sind möglicherweise hunderte/Sekunde. Mitigation: Embedder-Aufrufe in `runtime.ts → createEmbedder()` sammeln und gebuffert flushen (z.B. 1x pro Sekunde aggregiert).
- **Preis-Drift**: Anbieter ändern Preise. Mitigation: Banner im Tab + jährliches Update-Ritual.
- **`usage.db` als zusätzliche PGlite-Instanz**: zweite Pglite (neben `audit.db`) → doppelter RAM/Init-Cost. Akzeptabel; PGlite ist ~30MB/Instanz. Alternative: in `audit.db` als zweite Tabelle. Trennt sich aber logisch sauberer.

## 12 — Reihenfolge fürs Bauen

Empfehlung: P1 → P2 → P3 → P4. P5 nach User-Feedback im Beta-Use.
