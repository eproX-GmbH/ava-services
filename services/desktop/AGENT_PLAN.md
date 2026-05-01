# Phase 8 — Agentic layer

The local research agent. First-tab landing surface; controls the app via
tools; talks to the gateway and (later) to remote model providers.

## Substeps

| ID  | Title                                                                          | Status |
|-----|--------------------------------------------------------------------------------|--------|
| 8.a | Orchestrator + Ollama tool-calling client + IPC scaffolding                    | done   |
| 8.b | Read tools (company / transaction / evaluation gateway proxies)                | done   |
| 8.c | UI tools (`askUser`, `navigate`, `notify`) + Chat UI + ChoiceCard              | done   |
| 8.j | **Self-service provider switch** (Ollama ↔ OpenAI, key storage, settings tools)| done   |
| 8.h | Gateway `POST /v1/companies` single-row ingest endpoint                        | done   |
| 8.d | Markdown memory + writable-userData probe + FirstRunWizard fallback            | done   |
| 8.e | Write tools (importExcel, retryStage, evaluation creates) + Idempotency-Key    |        |
| 8.f | **Heartbeat alerts** (periodic agent sweep, `/alerts` route, bell + popover, OS push) | done 2026-04-29 |
| 8.g | Settings → Agent panel (toggle, model, memory dir, notifications, allow-list) |        |
| 8.i | DESKTOP_DATA_FLOW.md §13 + DECISIONS.md agent entries                          |        |
| 8.l | **Design system & UI polish** (Tailwind v4, AVA brand tokens, splash screen)   |        |
| 8.m | **German UI translation** (`t()` indirection, route-by-route sweep, `lib/format.ts`) | done 2026-04-29 |
| 8.n | **Voice mode** (local STT sidecar, push-to-talk + auto-VAD, Distil-Whisper-DE)  |        |
| 8.r | **Freshness scheduler** (per-stage staleness scan, priority queue, auto-retry) | done 2026-04-30 |
| 8.s | **Offer matching** (Angebot ingestion + global semantic search + per-tx deep research) |        |
| 8.t | **Standing intents + user profile** (persistent lens + recurring watches via heartbeat) |        |
| 8.u | **Build & distribution** (.dmg / .exe packaging, secrets, versioning, OTA updates) |        |

## 8.j — Self-service provider switch (NEW)

Goal: a user can say *"switch me to OpenAI, here's my key"* in the chat and
the agent reconfigures itself end-to-end. Reverse direction works the same way.

### Scope

**In scope (desktop-local):**

- Provider abstraction in `src/main/agent/`. Today `streamChat()` lives in
  `ollama-client.ts` and is called directly by the orchestrator. Refactor to:
  ```ts
  interface LlmProvider {
    id: "ollama" | "openai";
    streamChat(req: ProviderChatRequest): AsyncGenerator<ChatStreamFrame>;
    isReady(): boolean;
    describe(): { model: string | null; reason?: string };
  }
  ```
  Implementations: `OllamaProvider` (wraps current code), `OpenAiProvider`
  (calls `https://api.openai.com/v1/chat/completions` with `tools`).
- Provider config store at `app.getPath("userData")/agent/provider.json`:
  ```json
  { "provider": "ollama", "openai": { "model": "gpt-4.1-mini", "embedModel": "text-embedding-3-small" } }
  ```
  Watched by the orchestrator; reload swaps the active provider without app restart.
- API-key storage via Electron `safeStorage.encryptString` →
  `app.getPath("userData")/agent/openai.enc`. Same pattern as auth.ts's
  refresh-token persistence. Never logged. Never sent to the renderer.
- Settings tools (registered alongside read tools), so the chat agent can
  drive the switch itself:
  - `settings_get_provider()` — returns current provider, model name, and
    `hasOpenAiKey: boolean` (never the key itself).
  - `settings_set_provider({ provider, openaiApiKey?, model?, embedModel? })`
    — atomic switch. Refuses `provider="openai"` if no key is stored AND
    none is supplied. Validates the key with a one-shot `GET /v1/models`
    call before persisting.
  - `settings_clear_openai_key()` — wipes the encrypted key file and
    forces a fall-back to Ollama if it was active.

**Out of scope (deferred to a follow-up):**

- *Pipeline-wide* provider switch (cascade in master-data + embeddings in
  evaluation also using OpenAI). That requires gateway endpoints and
  per-service config plumbing. Track as `8.j2 — pipeline provider switch`
  once the desktop side ships.
- Anthropic / Azure-OpenAI / other vendors. Add adapters when there's a
  user request — `LlmProvider` is the seam.

### Acceptance

- From a fresh install with Ollama running:
  1. User: *"Switch to OpenAI, key=sk-..."* → agent calls
     `settings_set_provider`, key validates, config writes, next assistant
     turn streams from OpenAI.
  2. User: *"Go back to local"* → agent calls
     `settings_set_provider({provider:"ollama"})`, next turn streams from
     Ollama.
- Settings → Agent panel (8.g) shows the same controls; the panel and the
  chat tools share `settings_set_provider` under the hood.
- Restart preserves choice. Nuking `userData/agent/openai.enc` falls back
  to Ollama with a single status-line warning.

### Touch points

- **`src/main/agent/providers/`** — new dir, `ollama-provider.ts`,
  `openai-provider.ts`, `index.ts` exporting `selectProvider(config)`.
- **`src/main/agent/orchestrator.ts`** — `streamChat` import becomes
  `provider.streamChat`; `getStatus()` reads from the active provider.
- **`src/main/agent/settings.ts`** — config + key storage.
- **`src/main/agent/tools/settings.ts`** — three tools above.
- **`shared/types.ts`** — `AgentProvider = "ollama" | "openai"` and
  `AgentStatus.provider` field.

## 8.f — Heartbeat alerts (NEW)

Goal: the agent doesn't only react to chat input — it also runs a quiet
background sweep every few minutes, decides whether anything in the
processed company corpus is *worth bothering the user about*, and if so
files an alert. The user sees those alerts in three places: a dedicated
`/alerts` route, a bell + popover in the AppShell topbar, and (opt-in)
native OS notifications.

Why this is its own substep, not part of 8.b/8.c: it adds three things
that don't exist yet — a *scheduler* (timer + jitter + pause states),
*persisted alerts* (with seen/unseen state), and *notification chrome*
(bell, popover, native toast). Bolting any of those onto an existing
substep would distort the data flow.

### Scope

**In scope:**

1. **Heartbeat scheduler** (main process).
   - `src/main/agent/heartbeat.ts` — `setInterval` with ±20% jitter,
     default cadence 15 min (configurable: 5 / 15 / 30 / 60 / off).
   - Skips a tick when: no provider is ready, app is in DND, quiet
     hours match, or the previous tick is still running (single-flight
     lock).
   - Persists `lastHeartbeatAt` so a sleep/wake cycle doesn't fire 100
     times. On wake, if the elapsed time crossed a tick boundary,
     run *one* catch-up tick, not all of them.

2. **Signal collection.** Each tick calls a small set of gateway
   endpoints filtered to "things that landed since `lastHeartbeatAt`":
   - `GET /v1/alerts/candidates?since=<iso>` — new endpoint that
     fans out internally across the LLM producers and returns a
     unified shape:
     ```ts
     type Candidate =
       | { kind: "publication"; companyId; publicationDate; headline; body; sourceUrl }
       | { kind: "financial-delta"; companyId; reportYear; metric; previous; current; deltaPct }
       | { kind: "profile-change"; companyId; field; before; after; changedAt }
       | { kind: "evaluation-flag"; companyId; topic; verdict; reportedAt };
     ```
   - **Hard freshness gate (server-side, before the LLM ever sees it):**
     drop anything dated more than **18 months** before "today". A 2011
     financial report is filtered out at the gateway, not at the LLM —
     saves tokens and dignity.

3. **LLM judgment** — the cleverness gate.
   - For each surviving candidate, the agent calls a tiny, dedicated
     prompt (NOT the chat system prompt — different job, different
     budget). System message embeds today's date explicitly so "alt"
     vs "neu" is unambiguous:
     > Heute ist 2026-04-29. Bewerte, ob der folgende Datenpunkt eine
     > Benachrichtigung an die Analystin rechtfertigt.
   - Returns a structured JSON: `{ worthAlerting: bool, severity:
     "info"|"warn"|"urgent", headline: string, rationale: string }`.
     Validated with **yup** (per MEMORY.md preference) before persist.
   - Worth-alerting heuristics encoded in the system prompt:
     * Expansion / new location / acquisition / divestiture
     * Revenue or operating-result delta ≥ 15 % YoY (urgent ≥ 30 %)
     * Insolvenz / Restrukturierung / Rechtsstreit
     * Leadership change at C-level
     * Press cycle around the company (>3 publications in 30 days)
   - Explicitly NOT alert-worthy: routine HRB updates, filings older
     than 18 months, marketing content, neutral company-anniversary
     mentions.
   - Cost guard: cap the LLM at N candidates per tick (default 20);
     queue the rest for the next tick.

4. **Persistence.**
   - `app.getPath("userData")/agent/alerts.jsonl` — append-only JSONL,
     same pattern as `general-memory.ts`. One row per alert:
     ```ts
     interface Alert {
       id: string;             // ulid
       tenantId: string;
       companyId: string;
       companyName: string;    // denormalised for offline list-view
       kind: Candidate["kind"];
       severity: "info"|"warn"|"urgent";
       headline: string;       // German, ≤120 chars
       rationale: string;      // German, ≤500 chars
       sourceRef: string;      // `${kind}:${companyId}:${stableHash}` — dedup key
       createdAt: string;      // ISO
       seenAt: string | null;  // null = unread
       dismissedAt: string | null;
     }
     ```
   - Dedup: skip if `sourceRef` already exists in the file.
   - Read path uses an in-memory index keyed by `sourceRef` for O(1)
     lookup; rebuilt on app start.
   - **Defer to gateway later:** if multi-device sync becomes a real
     ask, graduate to a gateway `alerts` table. Track as `8.f2`.

5. **`/alerts` route (renderer).**
   - Chronological list, newest first, grouped by day ("Heute",
     "Gestern", "Vor 3 Tagen").
   - Each row: severity dot · company link · headline · relative time
     · rationale (collapsed; click to expand) · source link (`(im
     Kontext ansehen →)` jumping to the company tab where the data
     lives) · `[Gelesen markieren]` / `[Verwerfen]` buttons.
   - Filter chips at the top: `Alle · Ungelesen · Diese Woche · Diesen
     Monat` plus a per-severity toggle.
   - Empty state: friendly German line "Nichts Neues. AVA meldet
     sich, sobald sich etwas tut."

6. **Bell in AppShell topbar.**
   - 16 px bell icon (inline SVG) in `topbar` between nav and user
     badge. Unread-count badge on top-right of the bell, visible
     only when count > 0; capped at "9+".
   - Click → popover anchored under the bell, ~360 px wide, lists
     the 5 most recent unread alerts with the same severity dot +
     headline + relative time. Footer link "Alle ansehen →" routes
     to `/alerts`.
   - Popover dismisses on outside-click / Esc; opening it does NOT
     auto-mark as read (the user might just be peeking). Marking
     happens on row click or via the explicit button.

7. **Native OS notifications (opt-in).**
   - Electron's `Notification` API. macOS requires the user to grant
     permission on first call; we surface a one-time banner in
     `/alerts` explaining the trade-off.
   - Severity → presentation:
     * `info` → silent, no sound, body only.
     * `warn` → default sound, body + company name.
     * `urgent` → "critical" presentation where the OS supports it
       (macOS allows `silent: false` + `urgency: "critical"`).
   - Clicking a native notification focuses the window and routes to
     `/alerts` (or the per-company drilldown, configurable).
   - Suppressed when:
     * User toggle is off in Settings.
     * System DND active (`Notification.permission !== "granted"`
       handled gracefully, no thrown errors).
     * Quiet hours from settings (default 19:00–07:00 local + weekends).

8. **Settings panel** (slots into `Settings.tsx` — coordinates with
   8.g).
   - Heartbeat cadence: 5 / 15 / 30 / 60 min / aus.
   - Native notifications toggle + permission status indicator.
   - Quiet hours (start, end, weekdays).
   - Severity threshold for native push (info / warn / urgent).
   - Per-company allow-list / block-list (text area; comma-separated
     companyIds — power users only, hidden behind a "fortgeschritten"
     disclosure).
   - "Jetzt einen Heartbeat auslösen" button for testing.

**Out of scope (defer):**

- News scraping outside the existing `companyPublication` upstream.
  We use what the pipeline already collects.
- Cross-tenant alerts. v1 is single-tenant, same as the rest of the
  app today.
- LLM-generated *recommended actions* ("Schreib der Geschäftsführung
  …"). Alerts surface signal, not next-steps. Action automation is a
  separate substep if it becomes a need.
- Web-push / mobile push. Out of scope for an Electron app.

### Acceptance

- A user with a populated company corpus opens the app, waits 15 min
  (or clicks "Jetzt auslösen"), and sees:
  1. A bell with an unread badge in the topbar.
  2. A popover with the latest unread alerts on bell-click.
  3. A `/alerts` page listing them in reverse chronological order.
  4. (Opt-in) a macOS / Windows notification in the corner.
- Opening an alert and clicking "Gelesen markieren" zeroes its row's
  unread state; reload preserves it.
- Restart preserves all alerts. Nuking
  `userData/agent/alerts.jsonl` produces an empty `/alerts` route
  cleanly (no thrown errors).
- A 2011 publication never produces an alert (gateway-side filter).
  A 2026 publication of equivalent shape does.
- The same publication entering the pipeline twice produces exactly
  one alert (dedup via `sourceRef`).
- With the agent's provider unavailable (Ollama down, no API key),
  the heartbeat skips its tick silently — no error toasts, no
  alerts, no native push.
- Quiet hours: native push is suppressed but alerts still land in
  `/alerts` and the bell.

### Touch points

- **`services/db-gateway/src/routes/v1/alerts.ts`** — new fan-out
  endpoint. Mirrors the pattern from §bug-fix's `transaction_errors`
  fan-out. Returns the unified `Candidate[]`.
- **`services/db-gateway/src/routes/v1/schemas.ts`** — `Candidate`
  zod shape.
- **`src/main/agent/heartbeat.ts`** — scheduler + LLM judge +
  persistence. New file.
- **`src/main/agent/alerts-store.ts`** — append-only JSONL +
  in-memory index. Mirror pattern of `general-memory.ts`.
- **`src/main/agent/prompts.ts`** — second `buildAlertPrompt(today)`
  exporter. Kept tiny and separate from the chat prompt.
- **`src/main/notifications.ts`** — wraps Electron `Notification`;
  encapsulates DND / quiet-hours checks so the rest of main doesn't
  reach into platform APIs.
- **`src/main/index.ts`** — wire heartbeat lifecycle to app
  ready/quit; expose IPC handlers for `alerts.list`,
  `alerts.markSeen`, `alerts.dismiss`, `alerts.triggerNow`.
- **`src/preload/index.ts`** — expose `window.api.alerts`.
- **`src/renderer/src/store/alerts.ts`** — Zustand store, mirrors
  `ollama` store pattern: `unreadCount`, `recent5`, `markSeen`,
  `dismiss`, plus an SSE / IPC subscription so the bell updates
  live without route changes.
- **`src/renderer/src/routes/Alerts.tsx`** — new route. Add to
  `AppShell` nav (between *Vorgänge* and *Firmen*).
- **`src/renderer/src/components/AppShell.tsx`** — bell button,
  badge, popover. Popover is plain CSS (no library) — anchor with
  `position: absolute`, dismiss on outside-click via a `useEffect`
  capture-phase listener, same pattern we already use elsewhere.
- **`src/renderer/src/components/AlertBellPopover.tsx`** — new
  small component for the popover content. Reusable from the bell
  and (optionally) from the chat slash-command surface.
- **`src/renderer/src/routes/Settings.tsx`** — heartbeat cadence,
  native-push toggle, quiet hours, severity threshold.
- **`shared/types.ts`** — `Alert`, `AlertSeverity`, `AlertCadence`.

### Phasing within 8.f

To keep PRs reviewable, ship in three sub-PRs:

- **8.f1 — Skeleton + storage. _(done 2026-04-29)_**
  Heartbeat fires every 15 min (±20 % jitter) once `app.whenReady`
  resolves, with a single-flight lock + sleep-wake catch-up tick.
  Candidate source is a one-shot in-process stub returning three
  plausible demo rows (Kannegiesser expansion, Hettich +18 %
  Umsatz, Miele leadership change) so a fresh-install user sees the
  `/alerts` UI populate without a populated gateway. Judge is the
  always-alert placeholder with severity heuristics that exercise
  the info / warn / urgent rendering paths. Persistence is
  `userData/agent/alerts.jsonl` via `AlertsStore`, mirroring
  `general-memory.ts` (append-only, atomic-rewrite mutations,
  `sourceRef → row index` Map for O(1) dedup). `/alerts` route
  renders day-grouped (Heute / Gestern / Vor N Tagen / locale
  date), severity dot, company link, headline + meta, expand-on-
  click rationale + Verwerfen action, "Alle / Ungelesen" filter
  buttons + "Jetzt auslösen" trigger. Nav entry between *Firmen*
  and *Einstellungen*. IPC wired end-to-end with `alerts:changed`
  push so every open window's Zustand store re-fetches without
  polling. No bell, no LLM, no push (those land in 8.f2 / 8.f3).
- **8.f2 — Real LLM judge + bell + popover. _(done 2026-04-29)_**
  `src/main/agent/alert-judge.ts` builds a German system prompt with
  today's date baked in, enumerates the alarmwürdig criteria (Expansion,
  ≥15 % YoY-Delta, Insolvenz, C-Level-Wechsel, Press-Zyklus), and
  forbids JSON keys outside the schema. Output is yup-validated
  against `{ worthAlerting, severity, headline, rationale }` with
  strict-noUnknown; any parse / validation failure → `worthAlerting:
  false` so a flaky tick can't poison the alerts file. 30 s
  per-call timeout via AbortController. Tolerates `\`\`\`json` fences
  and prose-around-JSON via a balanced-brace scanner.
  Throws `JudgeProviderUnavailable` when no provider is ready; the
  heartbeat catches that, marks the tick `skipped`, and crucially
  does NOT advance `lastTickAt` so candidates re-appear on the next
  tick once a provider comes online (no lost signals during a cold
  Ollama start). Bell lives in the topbar (`AlertBell.tsx`) between
  the spacer and the user badge; 36 px tap target with a brand-teal
  unread badge (capped at "9+", suppressed when zero, 2 px topbar-
  bg punch-through so it sits proud of the bar). Click → 360 px
  popover anchored under the bell, lists 5 most recent unread alerts
  with severity dot, two-line clamped headline, company + relative
  time. Capture-phase outside-click + Esc dismiss. Empty state
  ("Nichts Neues. ✓"). Footer "Alle ansehen →" routes to `/alerts`.
  Peeking does NOT auto-mark; row click marks-as-read AND navigates.
- **8.f4 — Real candidate source. _(done 2026-04-29)_**
  Replaces the 8.f1 demo stub with `buildRealCandidateSource(gateway)`
  which walks the existing endpoints — `GET /v1/transactions` → `GET
  /v1/transactions/:id/entities` → per-company `GET /v1/companies/:id`
  + `GET /v1/companies/:id/publications` — and emits one `publication`
  candidate per surviving row. Three filter stages (cheapest first):
  freshness (drop ≥18 months old), delta (`updatedAt > since` so
  subsequent ticks only see new), cap (≤30 candidates / ≤50
  companies / ≤20 transactions per tick). Concurrency-limited to 5
  parallel HTTP calls so a fast laptop can't stampede the gateway.
  `pickOccurredAt()` prefers the report period end → `updatedAt` →
  `createdAt` → 31 December of `year`, dropping rows with no usable
  date instead of pretending they're recent. Stable `sourceRef` is
  `publication:<companyId>:<year>:<begin>:<end>` so the AlertsStore's
  dedup catches re-emits across ticks. Composite wiring keeps the
  demo stub as a fallback only when (a) the real source returned 0
  AND (b) `alerts.list().length === 0` — fresh-install users still
  see something on /alerts; populated installs only see real
  candidates. The proper gateway-side fan-out endpoint
  (`GET /v1/alerts/candidates?since=…`) tracks as 8.f5.

- **8.f3 — Native push + Settings panel + DND/quiet hours. _(done 2026-04-29)_**
  `src/main/agent/alert-prefs-store.ts` persists user preferences
  to `userData/agent/alert-prefs.json` (atomic write-temp + rename),
  with sanitisation on every read so a hand-edited file with weird
  values reverts to defaults gracefully. Defaults: 15 min cadence,
  push OFF (D7-aligned opt-in), `warn`-and-up threshold, quiet
  hours 19:00–07:00 + weekends silenced. `src/main/notifications.ts`
  wraps Electron's `Notification` and centralises every gate
  (OS support → user toggle → severity threshold → quiet-hours
  window with wrap-around midnight handling → try/catch around
  `new Notification` for macOS-permission-denied). Severity →
  presentation: `info` silent, `warn` default sound, `urgent`
  uses macOS `urgency: "critical"` so the toast bypasses Focus
  modes. Click handler focuses the window and pushes
  `notifications:focusAlerts` IPC; App.tsx routes to `/alerts` on
  every fire (one-click recovery from a notification). Heartbeat
  gained `setIntervalMs(ms)` for runtime cadence changes; the
  prefs store re-routes its `changed` event into the heartbeat so
  the cadence radio takes effect without an app restart. Settings
  → *Meldungen* panel offers cadence (5/15/30/60/aus), push toggle
  + permission hint when OS-blocked, severity threshold, time-
  window quiet hours via `<input type="time">`, weekend toggle,
  and a "Jetzt Heartbeat auslösen" button that surfaces the
  resulting `TickInfo` in muted text. New IPC: `alert-prefs:get`
  / `set` / `:changed` push, `notifications:getPermissionStatus`,
  `notifications:focusAlerts` push. Surfaced via
  `window.api.alerts.{getPrefs, setPrefs, onPrefsChanged,
  getNotificationPermission, onFocusAlerts}`.

## 8.l — Design system & UI polish (NEW)

Goal: turn the Electron renderer from "functional but homemade CSS" into
a coherent product that *feels* like a tool an analyst would happily run
all day. Reference points are **OpenCode**, **Claude Code**, and
**Codex** — calm, dense, monospace-comfortable, dark-first; every screen
makes the agent's work the visual hero, not the chrome.

The trigger for a dedicated substep is that we now have ~10 routes and
1k+ lines of `styles.css` accreted across phases 8.a–8.k. Each route
hand-rolls its own button/list/badge styles; the inconsistency is
starting to show, and adding more features would compound it. Doing
this work now (before 8.e/8.f land more surface) is cheaper than
retrofitting later.

### Brand & aesthetic direction

- **Primary:** `#00c0a7` (the AVA logo's *Aqua* mark). Used for the
  active nav indicator, primary buttons, focus rings, agent's own chat
  bubble accent, and the "ready" status dot. Sparingly elsewhere — too
  much teal turns into a brochure.
- **Reference apps:**
  - *OpenCode* — agent-thread layout, role-tagged messages, generous
    line-height in the assistant bubble, monospace tool names with a
    subtle disclosure for args, status dots inline. Steal: the
    timeline-of-actions feel and the way tool output collapses by
    default.
  - *Claude Code* — soft borders instead of shadows; semantic colors
    (success/warn/error) muted to ~60% saturation so they sit calmly
    next to body text; dark surfaces use a near-black, not pure black,
    with ~3-4 elevation steps. Steal: the elevation palette and the
    "code blocks always have monospace, prose never" discipline.
  - *Codex* — extremely tight chrome (single thin top bar, no sidebars
    by default), keyboard-first interactions visible as little kbd
    chips. Steal: the kbd treatment for our shortcuts and the absence
    of decorative dividers.
- **Mood:** quiet, technical, fast. No gradients, no rounded-3xl pill
  buttons, no drop shadows beyond a 1-pixel hairline. Two type sizes
  for body, one for code, one heading scale.

### Stack decision: Tailwind v4 (CSS-first)

Why v4 over v3: zero JS config (no `tailwind.config.js`), `@theme`
directive lets us declare brand tokens in a single CSS file and they
flow into every utility *and* into custom CSS via `var(--…)`. Smaller
runtime, faster Vite HMR. Native `@layer` and container queries.
The Vite plugin is one line in `electron.vite.config.ts`.

**Out of scope:** shadcn/ui, headless-ui, radix. We have <20 unique
component patterns — pulling in a kit costs more than writing them.
We will adopt Radix primitives *if and when* we need a real popover/
combobox/dialog with proper keyboard semantics; until then, native
`<select>` + handful of custom components stays.

### Token model (tentative — finalised in 8.l1)

Declared once in `styles.css` as `@theme { … }`:

```css
@theme {
  /* Brand */
  --color-brand-50:  oklch(96% .03 180);
  --color-brand-500: #00c0a7;        /* logo */
  --color-brand-600: oklch(58% .12 180);
  --color-brand-700: oklch(46% .12 180);
  /* Surface (dark) */
  --color-bg-0: #0b0d0c;             /* app background */
  --color-bg-1: #111413;             /* cards / chat bubbles */
  --color-bg-2: #1a1e1d;             /* active row, code blocks */
  --color-bg-3: #242927;             /* hover / popover */
  --color-border: #2a302e;           /* hairlines */
  --color-border-strong: #3a423f;
  --color-fg: #e5e7e6;
  --color-fg-muted: #9aa3a0;
  --color-fg-faint: #6b7370;
  /* Semantic */
  --color-ok:    oklch(72% .14 150);
  --color-warn:  oklch(80% .15  85);
  --color-err:   oklch(70% .19  25);
  /* Type */
  --font-sans: "Inter", "SF Pro Text", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
  /* Spacing & radii (Tailwind defaults are fine; we override radii
     down because Codex/Claude Code never go above ~6px). */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
}
```

Light theme stays a follow-up (`8.l5`); dark-first matches the
reference apps and most analyst-tool muscle memory.

### Delivery in numbered steps

`8.l` is broken down so each step ships independently and the app is
shippable after every one. No big-bang rewrite.

- **8.l1 — Tailwind v4 setup & token layer.**
  - Add `tailwindcss@4` + `@tailwindcss/vite` to the renderer's
    `package.json`; wire the plugin into `electron.vite.config.ts`'s
    renderer block.
  - Replace the top of `styles.css` with `@import "tailwindcss";` and
    the `@theme { … }` block above. Keep all existing rules below for
    now — they'll be migrated route-by-route.
  - Add a `<body class="dark">` toggle in `main.tsx` so the dark
    palette is always on (light theme deferred to 8.l5).
  - Acceptance: existing UI looks pixel-identical, but `bg-brand-500`
    etc. work in any new component.

- **8.l2 — App shell & nav. _(done 2026-04-29)_**
  - New `<AppShell>` component wrapping the routes. Layout: a 56px
    top bar with the AVA wordmark on the left (the SVG, not text),
    nav links centered, user badge + provider status on the right.
    No left sidebar — Codex/Claude Code feel.
  - Replace `.nav` / `.user-badge` / `.main` with shell-internal
    Tailwind. NavLink active state uses the brand colour as an
    underline, not a filled pill.
  - Acceptance: every route renders inside the shell; no layout
    regressions.
  - Pulled forward from 8.l7: variable woff2 fonts now bundled
    locally via `@fontsource-variable/inter` +
    `@fontsource-variable/jetbrains-mono` and registered as the
    `--font-sans` / `--font-mono` heads. CSP-safe (no CDN).

- **8.l3 — Splash / loading screen.**
  - New top-level `<Splash>` component shown until `useAuthStore` has
    resolved AND `agent.getStatus()` has returned at least once. The
    SVG logo (path-only, no embedded styles) animates with a slow
    pulse on the brand colour; below it a 1-line status hint
    ("Starting Ollama…", "Connecting to gateway…", "Ready").
  - Renderer-side; no main-process changes. Hides itself with a
    150ms opacity transition once both gates pass.
  - Acceptance: cold start shows the splash for ≥one frame instead
    of the current bare-page-then-content flicker; warm reload
    shows it briefly and dissolves.

- **8.l4 — Component primitives.**
  Six tiny components in `src/renderer/src/components/ui/`, each
  one file, each with a single Tailwind className composition and
  no library:
  - `Button` (variants: `primary` brand, `ghost`, `danger`; sizes
    `sm`/`md`).
  - `Input` / `Textarea` / `Select` (shared focus ring on
    `--color-brand-500`).
  - `Badge` (semantic ok/warn/err/neutral).
  - `Card` (1px hairline + `bg-bg-1`).
  - `Kbd` (the `<kbd>` chip, mono, hairline).
  - `Spinner` (replace the inline CSS one).
  Migrate Chat.tsx + Settings.tsx to use them as the proving
  ground. Keep the rest on the legacy CSS until 8.l5/6 touch them.

- **8.l5 — Route polish, batch 1: Chat & Companies.**
  - Chat: assistant bubbles get a thin left border in brand colour
    instead of a fill (cleaner with long replies); user bubble
    becomes `bg-bg-2`; activity rows align with a 12px hanging
    indent so the timeline reads as a single column. Markdown
    company links (already in 8.k…) get a subtle dotted underline
    + hover tint. Tool-args disclosure becomes a `<details>` with
    a 90° caret, monospace inside.
  - Companies list: convert to a virtualised table only if we
    cross ~5k rows; until then a simple data-table with sticky
    header. Row hover = `bg-bg-2`; selected = brand left-edge.
  - Acceptance: side-by-side screenshot review matches the
    reference vibe.

- **8.l6 — Route polish, batch 2: Transactions & Settings & Whoami.**
  - Transactions detail's pipeline matrix: cells become 24px
    rounded-sm pills with semantic colour (ok/warn/err/neutral),
    no text inside (state is the colour); hover/click to inspect.
    Replaces the current emoji-y dots and lines up with what
    Claude Code does for run-state grids.
  - Settings: section cards with a small section-header pattern
    (uppercase mono label + 1-line description). API-key inputs
    get a clear/save action group; the "no encryption available"
    warning becomes a Banner component.
  - Whoami: the identity dl becomes a compact "key: value" grid
    with monospace values.

- **8.l7 — Type & motion pass.**
  - ~~Bundle Inter + JetBrains Mono as local woff2~~ — done in 8.l2
    via `@fontsource-variable/*` (variable woff2, served from
    `out/renderer/assets/`, CSP-safe).
  - Remaining: one global motion convention: 120ms ease-out on
    hover/colour transitions, 200ms on layout, 350ms ease-in-out
    on splash fade. No spring physics. Documented in `styles.css`.

- **8.l8 — Cleanup.**
  - Delete the parts of the legacy `styles.css` that no surviving
    component references (likely 60–80% reduction).
  - Lint rule: forbid `style={{}}` literals in renderer code
    (they bypass tokens). One escape hatch: dynamic CSS variables
    (e.g. progress bars).

### Acceptance (whole substep)

- Cold start shows the AVA splash with the logo before the chat
  appears.
- Every route uses Tailwind utilities and the brand tokens; no new
  hand-rolled CSS classes added during 8.l5/6.
- Chat side-by-side comparison with OpenCode/Claude Code in screenshot
  review yields a "yes, same family" verdict.
- `pnpm build` size delta < +50 kB gz over baseline (Tailwind v4 +
  Inter + JetBrains Mono compress well).
- No runtime perf regression on 60fps chat scroll with 200 messages.

### Touch points

- **`services/desktop/electron.vite.config.ts`** — `@tailwindcss/vite`
  plugin.
- **`services/desktop/package.json`** — `tailwindcss@4`,
  `@tailwindcss/vite` deps.
- **`src/renderer/src/styles.css`** — `@theme` block, retains a
  shrinking `@layer components` section during migration.
- **`src/renderer/src/components/ui/`** — new dir for primitives.
- **`src/renderer/src/components/AppShell.tsx`** — new shell.
- **`src/renderer/src/components/Splash.tsx`** — new.
- **`src/renderer/src/assets/`** — logo SVG (committed copy of the
  Aqua mark) and bundled fonts.
- **Every `src/renderer/src/routes/*.tsx`** — touched in 8.l5/6 to
  use primitives. No behavioural changes; visual only.

### Decisions (locked-in 2026-04-29)

1. **Light theme:** deferred. Dark-first only; `prefers-color-scheme:
   light` is a cheap retrofit later if a user asks.
2. **Density toggle:** deferred. Single comfortable density.
3. **Logo lockup:** mark-only animated on the splash (it animates
   better and reads at any size); the full Aqua wordmark goes in the
   top nav.
4. **Tool-call disclosure:** convert inline previews to native
   `<details>` elements during 8.l5 — converges with OpenCode and
   saves vertical space on repeat-tool turns.

## 8.m — German UI translation (NEW)

The tool's primary audience is German operators working with German
companies; the agent's prompts and chat output are already German
(8.k). The renderer chrome and route copy are still mostly English,
which produces a jarring switch every time the user looks away from
the chat. This substep finishes the language migration.

### Approach: hard-coded German with a `t()` indirection

We deliberately do **not** ship i18next / react-intl. Reasons:

- Every screen we own has a known German audience; there is no
  user-toggle requirement and adding one would invent work.
- ICU message-format machinery is overkill for ~250 strings, all of
  which want the same locale at all times.
- Runtime locale switching adds a re-render boundary we don't need.

Instead we introduce a tiny `t()` helper:

    // src/renderer/src/lib/i18n.ts
    const de = { /* … */ } as const;
    export function t<K extends keyof typeof de>(key: K): string {
      return de[key];
    }

Strings live in a single `de.ts` map keyed by `route.section.label`.
`t("companyDetail.tabs.overview")` returns `"Übersicht"`. This:

- Catches duplicates and drift via the union of literal keys.
- Lets us sweep a route in one PR without touching unrelated routes.
- Compresses well; build-time tree-shake leaves only used keys.
- Trivially upgradable to i18next if we ever ship a non-German locale
  — the call sites already look like calls into a translation layer.

### Delivery in numbered steps

- **8.m1 — Foundation & shared formatters _(done 2026-04-29)_.**
  - `src/renderer/src/lib/format.ts` shipped with `fmtMoney`,
    `fmtShareCapital`, `fmtDate`, `fmtDateRange`, `numVal`,
    `telHref`, `mailHref`, `mapsHref`, `looksLikeEmail`,
    `looksLikePhone`. Locale locked to `de-DE`.
  - `CompanyDetail.tsx` migrated as the canary route — markdown
    rendering for the profile, German tab/section labels,
    `tel:` / `mailto:` / Google Maps links.

- **8.m2 — AppShell + auth flows. _(done 2026-04-29)_**
  - **Decision change vs. original plan:** dropped the `lib/i18n.ts` +
    `lib/de.ts` indirection. For ~250 strings, single locale, no
    runtime toggle, the `t("key.path")` machinery is pure ceremony
    over inline German literals — and it actively hurts grep-ability
    when reviewing copy. We inline German strings directly (matching
    the 8.m1 CompanyDetail precedent). The 8.m6 lint rule still
    catches drift back to English.
  - AppShell nav labels translated (`Import`, `Vorgänge`, `Firmen`,
    `Einstellungen`, `Status`); sign-out → "abmelden".
  - `App.tsx` loading + memory-warning copy translated.
  - `SignIn.tsx`, `FirstRunWizard.tsx`, `DownloadDock.tsx` fully
    translated — including ModelRow status states, Versuch X/Y
    suffixes, dock tooltips, retry/dismiss labels.
  - Cold start through to the "Chat" route is fully German.

- **8.m3 — Route batch 1: Chat, Companies, Transactions list. _(done 2026-04-29)_**
  - `Chat.tsx` fully translated: header status line, drop overlay,
    empty / blocked states, attachment chips, send/stop/attach
    buttons, ActivityRow args toggle, ThinkingRow, role labels
    (`Du` / `AVA` / `Werkzeug` / `System`), choice card heading,
    SessionPicker labels + relative-time formatter
    (`gerade eben`, `vor X Min.`, …).
  - `Companies.tsx` translated (Firmen, Stadt, search placeholder,
    pagination — Seite X / Y, weiter →).
  - `Transactions.tsx` translated; `startTime` now goes through
    `fmtDate` (DD.MM.YYYY).
  - Acceptance: every visible label is German; every date in the
    transactions list is DD.MM.YYYY.

- **8.m4 — Route batch 2: TransactionDetail, Evaluations,
  BestMatchDetail, ChatSession. _(done 2026-04-29)_**
  - `TransactionDetail.tsx`: stage labels translated where they read
    awkwardly (`Profile` → `Profil`, `Contact` → `Kontakt`,
    `Evaluation` → `Bewertung`, `Master` → `Stamm`,
    `Structured` → `Struktur`); cell-state badge text is now German
    (`fertig` / `fehlgeschlagen` / `läuft` / `wartet` /
    `übersprungen`). Drill-down panel + retry form fully German;
    `formatTime` uses `de-DE` locale.
  - `Evaluations.tsx`: panel headings, form fields, validation
    messages; topic chips show German labels but keep the English
    wire identifiers (`keywords` etc) — same convention as the
    pipeline-stage map.
  - `BestMatchDetail.tsx`: column headers + the feedback dropdown
    show German prose (`Akzeptiert`, `Abgelehnt`, …) while the wire
    enum (`ACCEPTED`, …) stays unchanged.
  - `ChatSession.tsx`: role labels rendered as `Du` / `AVA`;
    placeholder + Send button German.
  - Wire vocabulary that doubles as API contract (stage IDs,
    feedback enums, topic identifiers) stays English in the payload
    and only the on-screen rendering switches to German.

- **8.m5 — Route batch 3: Settings, Whoami, Ingest. _(done 2026-04-29)_**
  - `Settings.tsx`: provider chooser, model rows, API-key rows,
    installed-models panel (`reparieren` / `löschen` / `Laufzeit
    neu starten`), download affordance, long-term memory section
    incl. `formatRelativeDate` (German relative phrasing,
    `de-DE` fallback).
  - `Whoami.tsx`: heading + dt labels (`Mandant`, `Akteur`,
    `Berechtigungen`); cross-link to Einstellungen.
  - `Ingest.tsx`: dropzone copy, chips-field hints, validation
    messages, submit button.
  - `TransactionStream.tsx`: heading + event counters in German.

- **Bug fixes _(done 2026-04-29)_.**
  - **Transactions list ordering** — gateway now sorts the merged
    company-master list by `createdAt` desc before pagination, so
    `Vorgänge` shows newest first (lexicographic compare on ISO-8601
    is correct). Touched
    `services/db-gateway/src/routes/v1/transactions.ts`.
  - **Empty errors panel on TransactionDetail** — root cause: the
    gateway only fanned out `processing-errors` to the
    `company-profile` upstream, so failures from the other five LLM
    producers (`structured-content`, `company-publication`,
    `website`, `company-contact`, `company-evaluation`) never
    reached the UI. Rewrote the errors route to fan out across every
    `STAGE_UPSTREAMS` entry and stamp each row with a `service`
    field (= matrix stage id). Added `service?: string` to
    `ProcessingErrorShape` in `schemas.ts`. Renderer now shows the
    stage label per error via `stageLabelForService` + `fmtErrorTime`
    helpers in `TransactionDetail.tsx`.

- **8.m6 — Cleanup & lint. _(done 2026-04-29)_**
  - Added `scripts/check-german.mjs` — a regex-based guard that
    scans `src/renderer/src/routes/**` plus
    `components/{AppShell,DownloadDock}.tsx` for JSX text nodes and
    the four user-facing string attrs (`placeholder`, `title`,
    `aria-label`, `alt`, `label`). Flags any literal containing an
    unmistakably-English stop word ("the", "loading", "please",
    "retry", …). Allow-list covers domain identifiers (`HRA`,
    `HRB`, `API`, `URL`, `JSON`, `OLLAMA`, `AVA`, …) and the
    pipeline-stage ids that leak into code-styled spots
    (`structuredContent`, `companyProfile`, …). Wired into
    `pnpm build:typecheck` so CI catches regressions, and exposed
    on its own as `pnpm lint:german`. Cheaper than a full custom
    ESLint rule; revisit if/when we add eslint to this package.
  - Stop-word list is intentionally narrow — German uses many
    English loan words verbatim ("Settings", "Memory", "Optional",
    "Info", "Model", "Provider", "Session", "Email", "Website")
    and we don't want to fight the user's own copy. The guard
    catches obvious regressions; deeper coverage stays a humans-
    review-PRs job.
  - Smoke-tested by injecting "Loading user, please retry" into
    `Whoami.tsx` — guard caught it on the next run.
  - No legacy `nav` / field-label objects to delete: `grep` for
    `^const nav` / `^const FIELD_LABEL` / `Labels?` in
    `src/renderer/src/` came back empty — those were already
    superseded inline during 8.m1–5.

### Out of scope

- Translating server-side log lines or `chat-detail.json` snapshots
  (those are diagnostic artefacts).
- Any ICU plural / gender machinery — German pluralisation in our
  copy is 1 / >1 only, handled with a ternary at the call site.
- Swapping the agent's German output to anything else.

### Touch points

- **`src/renderer/src/lib/format.ts`** — already exists.
- **Every `src/renderer/src/routes/*.tsx`** — touched once with
  inline German literals.
- **`src/renderer/src/components/{AppShell,DownloadDock}.tsx`** —
  touched in 8.m2.


## 8.n — Voice mode (NEW)

Goal: a microphone affordance in the chat composer that records the user,
transcribes locally with no network round-trip, and drops the result into
the input box (or auto-sends, with a setting). German-first because the UI
is German-first; offline-first because that's our brand promise (D7).

### Stack decision: Distil-Whisper (German variant) via `whisper.cpp` sidecar

Survey of the early-2026 open-source landscape:

| Model                       | Size    | German    | License      | Runtime            | Notes                       |
|-----------------------------|---------|-----------|--------------|--------------------|-----------------------------|
| **Distil-Whisper v3 (DE)**  | ~756 MB | ~6.3% WER | MIT          | whisper.cpp / ONNX | 6× faster than Whisper L-V3 |
| Whisper Large V3 Turbo      | ~809 MB | very good | MIT          | whisper.cpp        | 216× real-time, multilingual |
| NVIDIA Canary-Qwen 2.5B     | ~2.5 GB | 5.6% WER  | NVIDIA       | ONNX / TensorRT    | Best accuracy, too heavy    |
| Moonshine v2                | 27–200 MB | weak    | Apache 2.0   | ONNX / CoreML      | Real-time CPU, English only |
| Silero STT                  | ~40–300 MB | ok     | SPL v2 (!)   | ONNX / JIT         | Commercial license unclear  |
| Parakeet TDT 1.1B           | ~1.1 GB | English   | NVIDIA       | ONNX               | Fastest, but no German      |

**Pick: Distil-Whisper v3 (German fine-tune)** — the best quality-per-MB
for our use-case. MIT license, ~756 MB on disk (sub-1 GB target), runs
under `whisper.cpp` which already has a clean sidecar pattern we can
mirror from D7's Ollama bundling. ~6.3% WER on German conversational
speech is tier-1; the 6× speedup over Whisper Large V3 makes it usable
on CPU laptops without a GPU.

**Caveats noted up front:**

- Whisper-family models still spike to ~4–6 GB RAM during inference;
  we'll guard against running it concurrently with Ollama on 8 GB
  machines (queue: pause LLM streaming while transcribing, or surface
  a "low memory" warning).
- Streaming/real-time transcription with Whisper is chunk-based; the
  natural UX is **push-to-talk → release → see transcription**, not
  a live caption. Live captions are a future option (Moonshine for the
  English caption-overlay case, Distil-Whisper for the final German
  pass).
- Model weights are ~756 MB; bundling them in the installer would
  bloat it past the 200 MB threshold mentioned in D7 for Ollama. Mirror
  the Ollama pattern: ship the binary, fetch weights on first use into
  `app.getPath("userData")/whisper/` with a progress UI in the
  FirstRunWizard.

### Scope

**In scope (this substep):**

- Bundle `whisper.cpp` binaries the same way 8.l3's `fetch:ollama`
  script bundles Ollama: `scripts/fetch-whisper.mjs`,
  `resources/whisper/<platform>-<arch>/`, `electron-builder.yml`
  `extraResources` entry.
- `src/main/voice/whisper-sidecar.ts` — spawn `whisper.cpp` as a
  child process; queue requests; surface status (`installed`,
  `modelDownloaded`, `busy`). Pattern mirrors `src/main/ollama.ts`.
- Model download UX: a "Sprachmodell" panel in Settings (alongside
  the existing LLM model panel) that pulls the German Distil-Whisper
  GGUF on demand with progress, cancel, and "Sprachmodell entfernen".
  Reuse the existing `DownloadDock` component.
- Renderer integration: enable the mic button in the composer
  (currently a disabled placeholder pointing at this section). Two
  modes:
  1. **Push-to-talk** (default): click-and-hold the mic, release to
     transcribe. Tactile, no false triggers.
  2. **Auto-VAD** (opt-in setting): click once → records until silence
     → transcribes. Uses `@ricky0123/vad-web` or webrtcvad-bound
     bindings; ~1 MB.
- IPC: `voice.startRecord()`, `voice.stopRecord()` returning a
  transcript or an error reason. The renderer never touches the
  microphone bytes — main process owns the `MediaRecorder` via a
  hidden `BrowserView` or Web Audio in the renderer with the buffer
  shipped to main for transcription.
- Privacy: every transcription stays on-device; we add a chip
  ("🎤 lokal" / "🎤 local") next to the mic in the composer to make
  this visible.

**Out of scope (defer):**

- Cloud STT fallback (OpenAI Whisper API, Deepgram, Google) — not
  worth the privacy compromise unless a user explicitly asks; revisit
  in a `8.n2` once we see real usage.
- Voice *output* (TTS — agent talks back). Different problem; would
  need Piper or Kokoro and a separate UX for interrupting playback.
- Wake-word / always-listening. Battery and privacy cost are too high
  for the value.
- Live caption overlay during streaming (see Moonshine note above).

### Acceptance

- First-run user: opens Settings → Sprachmodell → clicks "Herunterladen"
  → progress bar fills → mic button in chat composer becomes enabled.
- Push-to-talk: hold mic, speak a German sentence, release. Within
  ~2× audio length on an M-series laptop / 4× on a mid-range x86 CPU,
  the transcript appears in the textarea (not auto-sent unless the
  user enables auto-send in Settings).
- Offline: airplane mode, transcription still works.
- Concurrent stress: while Ollama is streaming a long answer,
  recording works but transcription queues until the LLM yields the
  CPU/RAM (or a status banner explains the delay).
- Uninstall: "Sprachmodell entfernen" wipes the GGUF and disables the
  mic button cleanly.

### Touch points

- **`scripts/fetch-whisper.mjs`** — new, mirrors `fetch-ollama.mjs`.
- **`resources/whisper/`** — new, gitignored, populated by the script.
- **`electron-builder.yml`** — add the `extraResources` entry.
- **`src/main/voice/whisper-sidecar.ts`** — new sidecar manager.
- **`src/main/voice/index.ts`** — IPC handlers + model-download
  driver + safeStorage isn't needed (no secrets here).
- **`src/main/index.ts`** — wire the IPC channel.
- **`src/preload/index.ts`** — expose `window.api.voice`.
- **`src/renderer/src/store/voice.ts`** — Zustand store mirroring the
  `ollama` store pattern.
- **`src/renderer/src/routes/Chat.tsx`** — re-enable the mic button
  (currently disabled, pointing at this plan section). Add the
  "🎤 lokal" indicator chip when a recording is in flight.
- **`src/renderer/src/routes/Settings.tsx`** — Sprachmodell panel.
- **`src/renderer/src/components/DownloadDock.tsx`** — already
  generic enough; just feed it Whisper-model state alongside Ollama
  state.

### Sources

Northflank "Best Open-Source STT Models 2026", Gladia "Best
Open-Source STT 2026", Modal "Open-Source STT in 2025", and the
Ionio 2025 Edge STT benchmark — all surveyed during the §8.n
planning pass on 2026-04-29.

### Phasing

- **8.n1 — Sidecar bundling + model-download UX. _(done 2026-04-30)_**
  `scripts/fetch-whisper.mjs` mirrors fetch-ollama.mjs (per-platform
  archives from the whisper.cpp GitHub releases, ditto/tar/unzip
  extract helpers, idempotent skip-if-present, chmod 0755 on Unix).
  `electron-builder.yml` `extraResources` entry copies the binary
  into `<resourcesPath>/whisper/<platform>-<arch>/whisper-cli[.exe]`
  at package time; `package:mac/win/linux` scripts now run
  `pnpm fetch:whisper` before electron-builder. `src/main/voice/
  whisper-sidecar.ts` owns the lifecycle: probes binary + model,
  emits `VoiceStatus` (`idle` → `binary-missing` / `model-missing` →
  `downloading` → `ready` / `error`), streams the GGUF download via
  `fetch` + `Readable.fromWeb` + temp+rename so a crash mid-pull
  can't strand a half-baked file. Coalesced ~5 Hz progress frames
  feed an exponential moving average in the renderer store for a
  stable bytes/sec readout. Default model is the German Distil-
  Whisper Q4_0 quant (~756 MB) on Hugging Face, env-overridable via
  `WHISPER_MODEL_URL` for dev / air-gapped installs. Settings →
  Sprachmodell panel surfaces state chip + disk path + size +
  download/cancel/remove buttons + progress bar with rate. Chat
  composer's mic button is now a `VoiceMicButton` that gates on
  `state === "ready"` and surfaces tooltip hints for the other
  states ("Sprachmodell nicht installiert – Einstellungen →
  Sprachmodell"). Transcription IPC (`voice:transcribe`) is wired
  end-to-end but the sidecar's `transcribe()` returns a stub string
  — actual whisper.cpp invocation lands in 8.n2.
- **8.n2 — Audio capture + real transcription.** Push-to-talk on the
  mic button (mousedown→mouseup), MediaRecorder in the renderer,
  bytes shipped via `voice:transcribe` IPC, sidecar spawns
  whisper-cli against a temp WAV, returns the German transcript
  which drops into the textarea. "🎤 lokal" indicator chip while
  recording. Smoke-test step (`whisper-cli --help`) tightens the
  ready-state check beyond filesystem presence.
- **8.n3 — Auto-VAD opt-in.** `@ricky0123/vad-web` for hands-free
  recording: click-once-to-start, auto-stop on silence, transcribe.
  Per-tenant Settings toggle.

## 8.r — Freshness scheduler (NEW)

Goal: keep the company corpus current without spamming the user. The
heartbeat alerts loop (8.f) detects *meaningful* events among already-
fresh data; the freshness scheduler keeps the data fresh in the first
place by re-running stale pipeline stages on a per-company basis.
Composed: freshness scheduler refreshes data → heartbeat judges
significance → alerts notify only when something actually changed.

The two loops are deliberately separate. A daily refresh that doesn't
change anything is silent; a refresh that surfaces a +18 % YoY-Delta
goes through the existing judge and lands in `/alerts`.

### Per-stage cadence (defaults)

Different stages decay at different rates. Anchors agreed with the
user; all are configurable per-tenant in Settings (8.r3):

| Stage              | Default cadence | Why                           |
|--------------------|-----------------|-------------------------------|
| companyPublication | 60–90 days      | Annual reports + filings; quarterly at most |
| structuredContent  | 30 days         | Slow-changing aggregate; monthly enough |
| companyProfile     | 7 days          | Master-data drift, address / leadership changes |
| companyContact     | 7 days          | Personnel turnover; weekly is the sweet spot |
| website            | 7 days          | Crawl-cost moderate; weekly catches most edits |
| companyEvaluation  | 14 days         | LLM-driven derived view; refreshes after the producers above |

`masterData` is excluded — it's the canonical record, not a refreshable
derivative.

### Priority queue

A *staleness score* per (companyId, stage) pair drives ordering:

```
score = max(0, daysSinceLastRun - cadenceDays) * stageWeight
        × (1 + recentInterestBoost)
```

- `stageWeight` is `cadenceDays`-inverse so contact / website rows
  (weekly) move faster than financial rows (60-day) when both are
  equally overdue, but finance still rises if it's been 6 months.
- `recentInterestBoost` (0–1) up-weights companies the user has
  recently drilled into (CompanyDetail page-view) or @-mentioned in
  chat. Read from a small per-tenant ring buffer kept in memory.
- Score ≤ 0 → not yet stale; never queued.

The scheduler picks the top-K each tick (default K=5) up to a
per-stage and global rate limit. Excess rows wait for the next tick;
their score grows monotonically until they reach the front.

### Throttle policy

- **Per stage**: at most 3 retries per stage per hour (avoids
  hammering one producer when the queue has e.g. 200 stale
  companyProfile rows).
- **Global**: at most 10 dispatches per hour total.
- **Per company**: at most 1 stage in flight per company at a time
  (master-data → profile → contact pipeline upstreams already serialise
  internally; running two stages in parallel for one company can race
  on the same row).
- **Quiet hours pass-through**: re-runs are silent disk work, so quiet
  hours don't apply. The user only hears about something via the alert
  heartbeat downstream.

### Scheduling loop

`src/main/agent/freshness-scheduler.ts` — `setInterval` with ±15 %
jitter, default cadence 30 minutes. Pauses when:
  - No transactions exist (nothing to refresh).
  - Throttle ceiling already hit for this hour.
  - User toggled the scheduler off in Settings.
  - The provider judge below is unreachable (no LLM means we can't
    later evaluate the refreshed payload meaningfully — defer).

A tick:
1. Fetch the pipeline matrices for every recent transaction
   (re-uses `/v1/transactions/:id/pipeline`, which already carries
   per-cell `updatedAt`).
2. Build the candidate queue: per (companyId, stage) compute
   `daysSinceLastRun`, score, and rate-limit slots.
3. Dispatch up to K rows via `POST /v1/transactions/:id/entities/:cid/retry`
   (the same endpoint the manual `retry_stage` tool uses).
4. Persist `lastDispatchAt` per stage so the next tick honours the
   per-stage hourly cap across process restarts.

### Persistence

Two tiny JSON files under `userData/agent/`:

- `freshness-prefs.json` — user-configurable cadences + master toggle
  + per-tenant overrides. Same atomic write-temp + rename pattern as
  `alert-prefs.json`.
- `freshness-cursor.json` — opaque scheduler state:
  ```ts
  {
    perStageHourlyDispatched: { [stage]: { hour: ISO, count: number } },
    globalHourlyDispatched: { hour: ISO, count: number },
    inFlight: { [companyId]: { stage, dispatchedAt: ISO } }
  }
  ```
  Survives restarts so a relaunch right after a flurry of dispatches
  doesn't blow through the throttle.

### Self-service tools (chat)

Same pattern as the §8.f5 alerts tools — every Settings knob is also
reachable via tool call so the user can drive it from chat:

- `freshness_scan` — list the top N stale (companyId, stage) pairs
  with their score + days-overdue. Read-only inspection.
- `freshness_run_now` — force-dispatch the top-K (default 5; capped at
  the global hourly limit) without waiting for the next tick. Returns
  the dispatched list.
- `freshness_get_prefs` / `freshness_set_prefs` — read/patch cadences
  + master toggle. Cadence values in days; `0` per stage = "never
  auto-refresh" (manual retries still work).
- `freshness_pin_company(companyId)` / `freshness_unpin_company` —
  add to / remove from a small priority pin list (these companies
  always sort to the top regardless of recency boost). Backed by a
  `pinned: string[]` field in `freshness-prefs.json`.

### Settings UI

A *Aktualisierung* panel in Settings, alongside the existing
*Meldungen* panel:
- Master toggle: "Auto-Aktualisierung aktivieren" (default on).
- Per-stage cadence rows (slider or numeric input, days; 0 = aus).
- Global hourly cap (3 / 10 / 25 / unlimited).
- "Jetzt scannen" button → runs `freshness_scan`, shows the staleness
  table inline (same component used by the chat tool's preview).
- "Top 5 jetzt aktualisieren" button → `freshness_run_now`.
- Pinned-companies list with chip-style remove buttons.

### Acceptance

- Fresh install with one transaction containing 50 companies:
  scheduler ticks every 30 min; first tick dispatches the top 5
  oldest contact/profile/website rows; over the first 24 h the
  scheduler walks through every weekly-cadence row exactly once.
- 6-month-old import with 200 companies: tick rate-limits to ≤ 10/h
  globally, finishes the weekly-cadence stages over ~2 days; the
  60-day financial rows wait until they cross the threshold.
- User runs `Auto-Aktualisierung aus` in Settings → next tick reads
  `enabled: false` and exits without dispatching; manual retries
  still work.
- User says in chat "Aktualisiere ACME jetzt" → agent calls
  `freshness_pin_company` then `freshness_run_now` → ACME's
  outstanding stages get dispatched immediately, regardless of score.
- Heartbeat alerts (8.f) downstream sees the refreshed data and
  surfaces only the changed-and-significant rows.

### Phasing

To keep PRs small:

- **8.r1 — Skeleton + cadence read. _(done 2026-04-30)_**
  `FreshnessScheduler` ticks every 30 min (±15 % jitter, single-flight
  lock), walks the last 25 transactions' pipeline matrices, scores
  every (companyId, stage) cell, and logs the top-K most-overdue rows
  to console. Pinned companies (per `FreshnessPrefs.pinned`) get a
  10× score boost and float to the top. `FreshnessPrefsStore` persists
  cadences + master toggle + pinned list to
  `userData/agent/freshness-prefs.json` with the same atomic temp +
  rename pattern the alert prefs use; defaults: 7d for contact /
  profile / website, 14d for evaluation, 30d for structured content,
  75d for publications. Throttle ceilings stored but unused (8.r2
  reads them). Master toggle hooks into `pref.changed` for runtime
  start/stop without restart. IPC: `freshness:recentTicks`,
  `freshness:triggerNow`, `freshness:getPrefs`, `freshness:setPrefs`
  exposed for the upcoming Settings panel + chat tools. Dispatch path
  intentionally absent — `dispatch` constructor option is the seam
  8.r2 will fill.
- **8.r2 — Dispatch + throttle. _(done 2026-04-30)_**
  `FreshnessCursorStore` persists the throttle counters + per-company
  in-flight locks to `userData/agent/freshness-cursor.json` (atomic
  temp + rename). Hour-bucket model: each tick reads the current UTC
  hour, resets counters when the bucket rolls, and atomically
  reserves a slot via `tryReserveSlot(stage, companyId, now, limits)`
  which checks per-stage cap → global cap → per-company in-flight
  lock in one shot. `releaseSlot()` rolls back on dispatch failure
  so a transient gateway 5xx doesn't burn the throttle budget.
  `sweepInFlight()` runs at the start of every tick to clear locks
  older than `IN_FLIGHT_TTL_MS` (60 min — defensive ceiling for a
  silently-failed dispatch). The scoring pass also skips companies
  with active in-flight entries so the candidate list the Settings
  panel sees stays free of rows the user can't act on this tick.
  `FreshnessScheduler.defaultDispatch` calls
  `POST /v1/transactions/:tid/entities/:cid/retry` with
  `{ stage }` — same endpoint + body shape the chat-driven
  `retry_stage` tool uses; fresh idempotency key per call so
  schedule-driven retries aren't deduped against recent manual ones.
  Tick info now carries the actually-dispatched (companyId, stage)
  pairs for the transparency log; console output flags each top-K
  candidate as `dispatched` or `skipped (throttle/in-flight)`.
- **8.r3 — Settings UI + tools. _(done 2026-04-30)_**
  Six `freshness_*` chat tools (the plan called for five but
  pin/unpin split cleanly into atomic add/remove): `freshness_scan`
  (read-only candidate list — fires a tick under the throttle),
  `freshness_run_now` (action framing for the same), `freshness_get_prefs`,
  `freshness_set_prefs` (master toggle + per-stage cadenceDays + throttle
  + topKPerTick — partial patches; `cadenceDays: { companyProfile: 3 }`
  only changes one stage), `freshness_pin_company` /
  `freshness_unpin_company` (idempotent). Settings panel:
  *Aktualisierung* section between *Meldungen* and *Langzeit-
  gedächtnis*. Master toggle, six per-stage cadence number inputs
  with hint text, throttle ceilings (`perStagePerHour`,
  `globalPerHour`, `topKPerTick`), pinned-companies chip list with
  click-to-remove, "Jetzt scannen" button surfacing the latest
  `FreshnessTickInfo` inline, expandable history of the last 10
  ticks (mirrors HeartbeatHistory pattern). New IPC:
  `freshness:getPrefs` / `setPrefs` / `triggerNow` / `recentTicks`,
  push channel `freshness:prefs-changed` so multiple windows + the
  scheduler-toggle path stay in sync. Prompt section
  *Aktualisierung / Freshness-Scheduler* added with a synonym list
  ("Aktualisierung = Auffrischung = Freshness = Refresh = Re-Run =
  automatischer Retry") + every trigger phrase mapped to the right
  tool; cadence-per-stage ('Profil alle 3 Tage'), throttle
  ('maximal 5 Retries pro Stunde'), and pin/unpin paths spelled out.
- **8.r4 — Recent-interest boost. _(done 2026-04-30)_**
  `InterestStore` — main-side in-memory ring buffer (capacity 200,
  LRU eviction on the touch-order, not the first-seen-order so a
  re-touch refreshes recency). `getBoost(companyId, now)` returns a
  0–1 value with linear decay over 14 days from the most recent
  touch; `0` for never-touched. Memory only by design (per-session
  attention signal, not a preference; restart is the right reset).
  Score formula in `FreshnessScheduler.scan` now multiplies by
  `(1 + interestBoost)`, so a CompanyDetail-opened-today company
  doubles its score (×2 at boost=1) without overpowering an explicit
  pin (×10). Renderer signals: `useEffect` on the `id` param in
  `CompanyDetail.tsx` (every mount and route-param change pings),
  plus an `onClick` on `[…](company:id)` links in `Chat.tsx` so a
  click counts even if the user never lands on the detail page (⌘
  +click into another window). Single new IPC `interest:record` —
  fire-and-forget; render path stays untouched on failure.

### Touch points

- **`src/main/agent/freshness-scheduler.ts`** — main loop, scoring,
  throttle, dispatch.
- **`src/main/agent/freshness-prefs-store.ts`** — JSON-backed prefs
  store, mirrors `alert-prefs-store.ts`.
- **`src/main/agent/freshness-cursor-store.ts`** — opaque scheduler
  state across restarts.
- **`src/main/agent/tools/freshness.ts`** — five chat tools (scan,
  run-now, get/set prefs, pin/unpin).
- **`src/main/agent/tools/index.ts`** — register the new tools.
- **`src/main/index.ts`** — instantiate scheduler, wire IPC, start +
  stop on app lifecycle.
- **`src/preload/index.ts`** — `window.api.freshness.*` surface.
- **`src/renderer/src/store/freshness.ts`** — Zustand mirror.
- **`src/renderer/src/routes/Settings.tsx`** — *Aktualisierung* panel.
- **`src/main/agent/prompts.ts`** — chat-side trigger phrases.
- **`shared/types.ts`** — `FreshnessPrefs`, `StalenessRow`,
  `FreshnessTickInfo`.

### Out of scope

- Cross-tenant scheduling (each tenant's scheduler runs in their
  own desktop instance).
- Adaptive cadence (learning per-company churn rates from observed
  diffs). Worth doing once we have 6 months of refresh data; not
  before.
- Web-push or external "company X is stale" reminders. The freshness
  loop is silent by design; the alerts loop is the user-facing
  surface.

## 8.s — Offer matching (NEW)

Goal: drop an Angebot / Ausschreibung into chat (paste, attach, or
hand-type), have the agent match it against the user's company corpus,
and surface the ranked candidates with rationale. Two scopes:

1. **Per-transaction deep research** — pick the best companies inside
   one Vorgang. Pipeline-bound, full LLM evaluation per company,
   produces a ranked best-match job the user can revisit later under
   `/evaluations/best-matches/:id`.
2. **Global semantic search** — across the *entire* corpus, not bound
   to a transaction. Faster (vector similarity, no per-company LLM
   evaluation), broader (every company the tenant has ever ingested),
   thinner output (top-N IDs + similarity scores; the user can promote
   any hit into a deep research afterwards).

Why this is its own substep, not part of 8.b: the read-side
evaluation tools already wrap `/v1/evaluations/best-matches[/:id]`,
but the *write* path (start a new best-match) and the global search
path don't have agent surfaces. Plus offer ingestion is a non-trivial
UX problem (paste vs. PDF vs. structured form).

### Existing pieces to reuse

- **`POST /v1/evaluations/best-matches`** (gateway → company-evaluation
  service) — the user-facing form on `Evaluations.tsx` already drives
  this end-to-end. Takes `{ transactionId, offerText, … }`, returns
  `{ id }`, runs the LLM evaluation pipeline async.
- **`GET /v1/evaluations/best-matches/:id`** — final ranked candidates
  with scores. The renderer's `BestMatchDetail.tsx` consumes this.
- **`GET /v1/evaluations/best-matches/:id/feedback`** — per-row
  feedback writes for relevance training.
- **chat-session evaluations** under `/v1/evaluations/chats/…` — for
  multi-turn drilldown into a specific match. Already routed in the
  renderer.

What's missing:
- No agent tool wraps the *start* call. The model can read the result
  but can't kick off a new job from chat.
- No `/v1/evaluations/search` (the semantic-search endpoint flagged as
  deferred in `tools/evaluations.ts` comment block). Adding it
  requires upstream work in `company-evaluation` to expose a vector-
  similarity query against the existing embeddings.

### Scope

**In scope:**

1. **Offer ingestion in chat — three equal-priority modes.**
   The agent recognises an offer regardless of how the user delivers
   it; no single mode is "primary". The three input shapes are:
   a. **Free-form chat description** — the user just types it.
      Example: *"Ich suche einen Hersteller industrieller
      Wäschereimaschinen in der DACH-Region mit ≥ 100 Mitarbeitern,
      Geschäftsbereich Hotellerie."* No file, no paste-block —
      a normal user message that happens to describe an offer.
   b. **Pasted text block** — same conversation flow, but the
      user dumped a longer copy/paste from a tender document or
      email. Often Markdown/plain-text formatting, multiple
      paragraphs, sometimes German contract boilerplate at the
      top. Treated identically to (a) once detected.
   c. **PDF / `.txt` / `.md` attachment** — the user dropped a
      file into the composer. Renderer parses it the same way
      it parses .xlsx attachments today; the parsed text becomes
      the offer text the agent reads via the existing
      `[attachment: foo.pdf, …]` header pattern.
   The agent's job is to detect the intent in any of these shapes
   and route to the matching tool. The existing
   `Evaluations.tsx` form stays as a non-chat fallback for users
   who prefer a structured surface, but the chat path doesn't
   require it.

2. **Intent detection (PFLICHT in the prompt).**
   The system prompt grows a dedicated *Angebot / Ausschreibung*
   section with the trigger taxonomy:
   - **Explicit framing** — `Angebot:`, `Ausschreibung:`,
     `Tender:`, `Lieferantensuche:`, `Wir suchen:`, `RFQ:` at the
     start of the user message → unambiguous, route immediately.
   - **Implicit framing** — phrasings without an explicit label:
     *"Welche Firma könnte X für mich liefern"*, *"Ich brauche
     einen Anbieter, der Y kann"*, *"Passt einer meiner Importe
     zu folgendem Bedarf …"*, *"Wer macht Z im Raum München"*.
     These all describe a need the user wants matched against the
     corpus.
   - **PDF/text attachment with offer-shaped content** — the
     attached file lists requirements / specifications / wanted
     capabilities. Detected from the parsed text (presence of
     phrases like *"Anforderung"*, *"Leistungsbeschreibung"*,
     *"Lieferant gesucht"*, plus offer-style structure: bullet
     lists of capabilities, region/size constraints, deadline).
   When intent is detected the agent must:
     - Extract the offer text (from the message body OR the
       attached file's parsed content).
     - Disambiguate scope ONCE via `ask_user_choice`: *"Globale
       Suche durch deinen kompletten Firmenbestand oder eine
       Tiefenanalyse innerhalb eines Vorgangs?"*. Default is
       global search (cheaper, broader); the deep research path
       wants explicit user opt-in because it costs LLM time.
     - On "Tiefenanalyse" → ask which transaction (chip with
       most-recent N transactions auto-resolved via
       `transaction_list`).
     - Skip the disambiguation when the user's framing already
       answers it: *"in diesem Vorgang"* / *"in der letzten
       Transaktion"* → deep research; *"aus meinem ganzen
       Bestand"* / *"über alle Firmen"* → global search.

3. **Per-transaction deep research tool.**
   - `evaluation_start_best_match({ transactionId, offerText })` —
     wraps `POST /v1/evaluations/best-matches`. Returns `{ id }`.
     Polls (or subscribes to SSE if available) and surfaces the top-N
     ranked candidates as a chat message with `[Foo GmbH](company:…)`
     links + score + per-match rationale.
   - Long-running: dispatches and replies "Job läuft, Ergebnis liegt
     in 2–5 Min in /evaluations/best-matches/<id> — soll ich
     benachrichtigen sobald fertig?". On follow-up "ja" we register
     a one-shot watch (8.t glue) that pings via alerts when the job
     finishes.
4. **Global semantic search tool.**
   - `evaluation_global_search({ offerText, limit? })` — calls
     `/v1/evaluations/search?q=…&limit=…` (new gateway endpoint).
     Returns top-N (companyId, similarityScore, snippet) tuples.
     No transaction binding; no LLM evaluation; vector-similarity
     ranking only.
   - Use case: "Welche Firmen aus meinem Bestand könnten zu diesem
     Angebot passen?" — without committing to a deep research run.
   - Server-side: gateway proxies to `company-evaluation`'s
     `/api/v1/embeddings/query` (or equivalent — needs upstream
     review). Includes a hard cap (top-50) to keep tokens / latency
     predictable.
5. **Result delivery.**
   - Best-match result chat reply: top-5 candidates with company link
     + score badge + one-line rationale. Footer link to the full
     /evaluations/best-matches/<id> view.
   - Global-search reply: top-10 candidates with similarity score +
     city + a *deep research starten* affordance per row that calls
     `evaluation_start_best_match` if the user wants to escalate.

**Out of scope (defer):**

- DOCX / XLSX offer ingestion — start with text + PDF.
- LLM-driven extraction of structured fields (budget, deadline,
  industry tags) from the offer; current best-match pipeline takes
  raw text and that's good enough.
- Per-row feedback collection in chat — keep that on
  `BestMatchDetail.tsx` for now.
- Cross-tenant search.

### Acceptance

- User pastes "Wir suchen einen Hersteller von industriellen
  Wäschereimaschinen mit ≥ 100 Mitarbeitern in DACH" → agent calls
  `evaluation_global_search`, replies with top-10 matches
  (Kannegiesser, Jensen, …) + similarity + city.
- User says "ok, run a deep research für die letzte Transaktion" →
  agent calls `evaluation_start_best_match` against the most-recent
  transactionId, reports the job id + ETA, optionally sets up an
  on-finish alert via 8.t.
- User drops a 2-page PDF Angebot → agent extracts text, summarises
  what it understood, asks "Globale Suche oder deep research im
  aktuellen Vorgang?" via `ask_user_choice`.

### Phasing

- **8.s1 — Intent detection + match-start tools + chat result
  rendering. _(done 2026-04-30)_** Two new write tools in
  `src/main/agent/tools/evaluations.ts`: `evaluation_offer_analysis`
  (global semantic search via the existing
  `POST /v1/evaluations/offer-analysis`; takes raw offer text +
  optional `topK`, returns `bestMatchJobId`) and
  `evaluation_start_best_match` (per-transaction deep research via
  `POST /v1/evaluations/best-matches`; auto-resolves `companyIds`
  from the transaction's entities when the user didn't name a
  subset, defaults to the 5-axis topic set
  `keywords + companyProfile + businessPurpose + sales + employees`
  unless the user scoped). Both ship with `randomUUID()`
  idempotency keys so a re-asked dispatch never double-runs the
  upstream pipeline.
  Prompt section *Angebot / Ausschreibung / Lieferantensuche*
  added: explicit recognition of three ingestion modes
  (free-form chat / paste / attached file) with explicit and
  implicit trigger-phrase taxonomies, `ask_user_choice` scope
  disambiguation (default = global, opt-in deep research),
  formulaic-skip when the user already framed it ('in diesem
  Vorgang', 'aus meinem ganzen Bestand'), wall-clock ETA in the
  reply (30–90 s global / 2–5 min deep). Top-N rendering uses
  the existing `[Foo GmbH](company:…)` format the agent already
  knows. **Discovered during build:** `POST /v1/evaluations/
  offer-analysis` ALREADY EXISTS on the gateway — the
  `tools/evaluations.ts` comment claiming `/v1/evaluations/search`
  was deferred is stale. 8.s2 collapses into 8.s1; the original
  8.s2 placeholder is now reserved for downstream UX (eval-search
  tool result quality cap, etc.) if needed.
  PDF parser stays in 8.s3 — the free-text + paste paths in 8.s1
  don't depend on it.
- **8.s2 — Result-quality cap + re-rank polish.** *(Reserved.)*
  Original scope ("global semantic search") collapsed into 8.s1
  because `POST /v1/evaluations/offer-analysis` was already shipped.
  Slot kept for downstream polish: similarity-threshold cap so we
  don't surface 50 weak hits, optional hybrid ranking that boosts
  candidates the user has recently engaged with (interest-store
  signal from §8.r4). Skip if the global search baseline reads
  fine on real offers.
- **8.s3 — PDF ingestion in chat.** Renderer parses .pdf into text
  (mirror the .xlsx attachment pattern), agent reads the text from
  the wire-format header, kicks off the appropriate match.
- **8.s4 — Auto-notify on best-match completion.** One-shot watch
  registered via 8.t infrastructure → fires when the best-match job
  flips to `done`.

### Touch points

- **`services/db-gateway/src/routes/v1/evaluations.ts`** — new
  `/evaluations/search` proxy (8.s2).
- **`services/db-gateway/src/routes/v1/evaluation-writes.ts`** —
  ensure the existing `POST /best-matches` accepts agent-supplied
  payloads cleanly (idempotency-key already wired in 8.e).
- **`src/main/agent/tools/evaluations.ts`** — add
  `evaluation_start_best_match`, `evaluation_global_search`,
  optionally `evaluation_summarise_offer`.
- **`src/main/agent/prompts.ts`** — Angebot intent detection +
  routing block.
- **`src/renderer/src/lib/attachment.ts`** — PDF parser path
  (8.s3).
- **`src/renderer/src/routes/Chat.tsx`** — best-match result chip
  rendering with company-link list + score badges.

### Open design questions

- **Long-running result delivery**: poll vs. SSE vs. one-shot
  alert? Heartbeat already runs every 15 min — riding that loop
  would mean 0–15 min latency before the user hears the job
  finished. SSE on `/v1/evaluations/best-matches/:id/events` (if
  upstream supports it) would be the cleanest live update.
- **Global-search ranking**: pure vector similarity vs. hybrid
  (cosine + recency boost from 8.r4 interest store)? Likely hybrid
  — analysts care more about companies they're already engaged
  with — but defer the ranking-fusion experiment until 8.s2 ships
  the cosine baseline.
- **Quality gate**: a global-search result with similarity < 0.65
  is probably noise; cap surface at meaningful threshold so we
  don't dump 50 weak matches when the offer doesn't fit anything.

## 8.t — Standing intents + user profile (NEW)

Goal: the agent stops being a stateless responder and starts behaving
like a research assistant who knows *what you care about* (user
profile) and *what to keep watching for you* (standing instructions).
Two distinct mechanisms; one user-facing surface.

### What "smart" means here

> The user could tell the agent what he is actually interested in and
> what type of person he wants to talk to — the agent should focus
> that primarily.

Translation: every agent response is biased by the user's lens. A
sales rep gets "this company has procurement-friendly signals", a
researcher gets "this company published 3 papers in your field". Same
data, different framing, because the system prompt has the user's
profile woven in.

> If the user asks to regularly check for specific topics, the agent
> needs to remember that and execute it in the background.

Translation: "merk dir, dass ich wöchentlich Updates zu ACMEs
Expansion will" → the agent (a) writes a memory entry so it
remembers the intent next session, (b) registers a recurring watch
that runs against fresh data, (c) surfaces hits via the alerts
heartbeat.

### Composition with existing loops

```
freshness scheduler (8.r)        — keeps data fresh
heartbeat alerts (8.f)           — judges generic significance
standing-intent watcher (8.t)    — judges user-specific significance
                                   (profile + watches as the rubric)
                  │
                  ▼
            unified /alerts surface
```

Three loops feeding one user-visible surface — the user doesn't have
to know which loop produced a given alert. They just see "Neuer
Vorstandswechsel bei ACME (passt zu deinem Watch ‚ACME Leadership-
Wechsel')".

### Two persistent surfaces

**1. User profile** — stable, slow-changing. Stored as a
structured-but-extensible JSON at `userData/agent/user-profile.json`:

```ts
interface UserProfile {
  /** Free-text — woven into the system prompt verbatim. ~300 chars
   *  cap so token spend stays bounded. */
  bio: string;
  /** Optional structured fields the agent extracts from chat ("ich
   *  arbeite im Vertrieb DACH") — kept alongside the bio for
   *  prompts that want them programmatically. */
  role?: string;
  industries?: string[];
  geographies?: string[];
  topics?: string[];
  /** Conversation tone the agent should adopt. */
  tone?: "neutral" | "knapp" | "ausführlich";
  updatedAt: string;
}
```

The system prompt prepends a small block:

```
Nutzer-Profil (Lese-Kontext, beeinflusst Antworten):
  - Bio: <bio>
  - Rolle: <role>
  - Branchen: <industries>
  - Regionen: <geographies>
  - Schwerpunktthemen: <topics>
  - Bevorzugter Ton: <tone>
```

Empty fields are omitted. Bio is the primary signal; structured
fields are tie-breakers.

**2. Standing instructions / Watches** — task-shaped, may fire
many times. Stored as JSONL at `userData/agent/watches.jsonl`,
mirroring `alerts.jsonl`'s pattern:

```ts
interface Watch {
  id: string;
  /** German one-liner the user originally said, kept verbatim for
   *  display + audit. */
  prompt: string;
  /** LLM-translated rubric the executor evaluates against. Single
   *  shape — no kind taxonomy in v1. Optional scoping fields keep
   *  the eval cheap when the user named specific companies / topics.
   *  See "Single trigger shape" below for the rationale. */
  trigger: WatchTrigger;
  cadence: "daily" | "weekly" | "monthly";
  createdAt: string;
  /** When the agent last evaluated this watch. Cadence is enforced
   *  against this — a weekly watch evaluates once per week, NOT on
   *  every heartbeat tick. */
  lastCheckedAt: string | null;
  /** Hits accumulated so the user can see history. */
  hits: Array<{ alertId: string; at: string }>;
  /** User-toggleable; when paused the watcher skips this row. */
  enabled: boolean;
}

interface WatchTrigger {
  /** German rubric phrased like an alert-judge criterion ("Wechsel
   *  auf C-Level (Geschäftsführung, Vorstand)"). The executor sends
   *  this verbatim into a yup-validated judgement call against each
   *  candidate. */
  rubric: string;
  /** When set, only candidates for these companies are evaluated.
   *  The 80 % case ("watch ACME for X") — no LLM call needed to
   *  know which row to inspect. */
  companyIds?: string[];
  /** When set, only candidates whose `kind` matches one of these
   *  pre-filter the candidate set ("expansion", "leadership",
   *  "financial-delta"). Pure scoping; doesn't affect rubric eval. */
  topics?: string[];
}
```

**Why a single trigger shape (no kind taxonomy):**
We don't have data on what users will actually register. Building
a `company-topic` / `industry-event` / `best-match-done` taxonomy
up front means maintaining mappings for shapes that might never
fire, and a "watch failed to register" failure mode whenever the
LLM's translation doesn't fit the schema. The single-rubric shape
plus optional `companyIds` / `topics` scoping covers every concrete
case via "rubric written natural, scope filtered cheaply": *"Wechsel
auf C-Level"* with `companyIds: ["ACME"]` is the entire taxonomy
the §8.f2 alert judge already uses, just persistent. The 8.s4
"best-match completed" callback uses a direct event hook in main,
NOT a watch — because that's a one-shot completion signal, not a
recurring pattern match. We graduate frequent rubric patterns
into pre-filter shortcuts in 8.t3 *if* observed data justifies it.

The watcher executor rides the heartbeat tick (no new timer):
- For each enabled watch whose `lastCheckedAt` is older than its
  cadence threshold, evaluate. Cadence-respecting: a weekly watch
  fires once a week even if the heartbeat ticks 96 times in
  between. Cap at **20 active watches per tenant** (configurable
  in 8.t3) so the cost ceiling is governable — at 20 watches with
  mixed cadences, we're at ≤ ~50 LLM judge calls per week total.
- The judge re-uses the §8.f2 alert-judge plumbing: the candidate
  set the heartbeat already collected → filter by the watch's
  `companyIds` / `topics` scope → for each survivor, one yup-
  validated LLM call against `rubric`.
- A hit creates a regular `Alert` (8.f shape) with `kind:
  "evaluation-flag"` and a `watchId` reference — surfaces in the
  bell, /alerts, native push, exactly like a heartbeat-judged alert.

### Hard rule: propose-and-confirm, never silent persistence

Every mutation that writes a profile field or registers a watch
goes through a **user-visible draft** before persisting. The agent
shows what it inferred, the user clicks a button (or types yes /
nein), then the write happens. This is the same gating pattern
§8.f5 uses for "delete all alerts" and the chat composer's
attachment-name field uses today.

Concretely:

- **Profile**: agent NEVER calls `profile_set` directly from
  observed conversation. It calls `profile_propose_update(patch)`
  which renders an `ask_user_choice` card showing the proposed
  fields verbatim. Confirmed → `profile_set`. Declined → drop.
  Explicit user edits ("update my bio to …") still bypass the
  proposal step; the gate is for *agent-inferred* updates.
- **Watches**: `watch_register({ prompt, cadence })` first
  translates the prompt into a `WatchTrigger`, then renders a
  draft preview ("Wöchentlicher Watch: ACME, Rubrik 'Wechsel auf
  C-Level'. Soll ich starten?"). Confirmed → persist. Declined →
  drop. Costs one extra round-trip per registration but lets the
  user catch mistranslations (wrong companyId, wrong rubric scope)
  before the watch fires for two weeks against the wrong target.

The "no silent edits" rule is in the system prompt as a hard
constraint, same shape as §8.f5's "Sage NIE 'kein Lösch-API'"
clause that finally got `alerts_dismiss_all` to work.

### Scope

**In scope:**

1. **User profile store + system-prompt injection.**
2. **First-run nudge.** First user-initiated chat turn ever (no
   profile present yet), the agent's opening reply ends with a
   one-paragraph invitation: *"Bevor ich loslege: in welchem
   Kontext recherchierst du Firmen? Zwei, drei Sätze (z. B. Rolle,
   Branche, Region, Schwerpunktthemen). Ich passe meine Antworten
   dann an. Du kannst auch jetzt skippen — wir kommen später
   nochmal darauf zurück."* Skipped is sticky: a `profileSkipped:
   true` flag on the empty profile prevents re-prompting unless
   the user explicitly says "lass uns mein Profil mal aktualisieren".
   No badge, no banner — once the user said "skip", the agent
   stops bringing it up.
3. **Conversational profile updates via propose-and-confirm.**
   When the agent infers a stable signal across a conversation
   (e.g. user mentioned role + region + interests within the same
   exchange), it offers the proposed patch verbatim via
   `ask_user_choice`. One suggestion per conversation max, even
   if multiple signals fire — chained suggestions feel naggy.
4. **Watch store + watcher executor (rides heartbeat,
   cadence-respecting, capped at 20 active).**
5. **Chat self-service tools:**
   - `profile_get` — read current profile.
   - `profile_propose_update({ patch, reason })` — render the
     draft via `ask_user_choice`; on confirm, write via
     `profile_set` internally. The agent-facing tool of choice
     for inferred updates.
   - `profile_set({ bio?, role?, … })` — direct write. Used for
     explicit user requests ("update my bio to …") and the
     first-run nudge response.
   - `profile_clear` — wipe everything ("vergiss, was du über
     mich weißt").
   - `watch_list` — what the agent is keeping an eye on.
   - `watch_register({ prompt, cadence })` — translates +
     drafts + persists on confirm. Single tool the user calls;
     the propose-and-confirm gate is internal.
   - `watch_remove({ id })` — idempotent.
   - `watch_pause` / `watch_resume`.
6. **Settings → Profil & Beobachtungen panel.**
   - Bio textarea + structured-fields editor.
   - Watch list with toggle + remove + last-fire timestamp.
   - "Mein Profil zurücksetzen" button.
7. **Topbar watcher-count chip.** Sits next to the alert bell.
   Always visible when the user has at least one active watch.
   Renders the count + a colour dot that maps to capacity
   utilization against the (configurable) cap:
     - **green**:  ≤ 50 % of cap (≤ 10 watches under the default 20).
     - **orange**: 51–89 % (11–17). Hint that the user is filling
       the slot space; nothing's broken yet.
     - **red**:    ≥ 90 % (18–20). Warns BEFORE the next
       `watch_register` rejects with the cap message.
   Click → opens a popover anchored under the chip (same shape as
   the bell popover) listing the 5 most-recently-fired watches,
   with a footer link "Alle ansehen → /watches" once that route
   exists. Falls back to the Settings → Profil & Beobachtungen
   panel until the dedicated route lands. Hover tooltip shows
   "X von Y aktiven Watches".
8. **Prompt updates** — explicit trigger phrases that route into
   profile / watch tools, the propose-and-confirm rule, and the
   first-run nudge invitation.

**Out of scope (defer):**

- Multi-user profiles per device.
- Watch sharing / templates across tenants.
- Adaptive cadence (LLM learns from user's response rate which
  watches to fire more / less aggressively). Worth doing once
  there's signal data; not before.
- Voice / TTS replies for watch hits.

### Acceptance

- **First-run**: fresh install, user says "Hallo" → agent's reply
  ends with the profile-nudge paragraph. User answers in the same
  turn ("ich bin im Vertrieb für Maschinenbau Bayern, …") → agent
  calls `profile_set` directly (this counts as explicit because the
  user is responding to the prompt). User clicks "skip" / says
  "später" → `profileSkipped: true` lands; agent never re-asks.
- **Inferred update with confirm**: user later says across a
  conversation "ich fokussiere auf Geschäftsführer-Wechsel" + "neue
  Produktlinien interessieren mich auch" → agent ends the assistant
  turn with `profile_propose_update(...)` showing the draft patch
  verbatim. User confirms → applied. User declines → dropped, agent
  doesn't re-suggest the same thing within the same conversation.
- **Watch creation**: user says "Schau jede Woche, ob ACME einen
  Geschäftsführer-Wechsel meldet" → agent calls `watch_register`,
  which translates to `{ rubric: "Wechsel auf C-Level
  (Geschäftsführung, Vorstand)", companyIds: ["ACME…"], topics:
  ["evaluation-flag", "profile-change"] }`, drafts the preview, the
  user confirms → persisted. The next heartbeat tick re-uses the
  candidate set, filters by ACME, evaluates the rubric via the
  alert-judge plumbing.
- **Watch firing**: two weeks later ACME has a leadership change →
  the watcher's rubric eval matches → an alert lands in the bell
  with `kind: "evaluation-flag"` and a `watchId` reference. The
  headline references the watch source ("Watch ‚ACME Leadership' →
  Neuer CEO …").
- **Inspection + management**: "Was beobachtest du gerade für
  mich?" → agent calls `watch_list`. "Pausiere den ACME-Watch" →
  `watch_pause`. "Vergiss alles, was du über mich weißt" →
  `profile_clear` (no propose-and-confirm; explicit destructive
  request).
- **Cap enforcement**: 21st watch attempt → tool refuses with
  "Maximal 20 aktive Watches; bitte zuerst einen entfernen oder
  pausieren." Cap is configurable in 8.t3.

### Phasing

- **8.t1 — User profile + first-run nudge + propose-and-confirm.
  _(done 2026-04-30)_** `UserProfileStore` persists to
  `userData/agent/user-profile.json` (atomic temp+rename, sanitised
  reads, 300-char bio cap, 12-entry caps on industries / geographies
  / topics, dedup case-insensitively). Four chat tools: `profile_get`,
  `profile_set` (direct — for explicit user requests + nudge response
  + Settings panel writes), `profile_propose_update` (gates on
  `ask_user_choice` showing the patch verbatim — agent's only path
  for inferred updates), `profile_clear`. System-prompt builder
  reads the store on every turn and injects a *Nutzer-Profil*
  block at the TOP of the prompt + a *First-Run-Hinweis* block
  when the profile is empty AND `profileSkipped !== true`. The
  hard-rule clause forbids silent profile edits ("propose-and-
  confirm IMMER"); same enforcement style as the §8.f5 "no kein
  Lösch-API" line that finally got `alerts_dismiss_all` working.
  Settings → Profil panel: bio textarea + role / industries /
  geographies / topics free-text inputs (comma-split) + tone
  dropdown + "Profil speichern" / "Profil zurücksetzen" buttons +
  "Zuletzt aktualisiert" timestamp. Saving via the panel always
  clears `profileSkipped` so the agent stops avoiding profile
  suggestions. New IPC: `profile:get` / `profile:set` / `profile:clear`
  + push channel `profile:changed` so multi-window edits stay in
  sync. Independent of watches; ships ahead of 8.t2 because it's
  the simpler half and unblocks 8.t4 (profile-aware ranking)
  without 8.t2's risk.
- **8.t2 — Watch store + executor + topbar chip.
  _(done 2026-04-30)_** `WatchStore` (JSONL, append-only with
  atomic-rewrite mutations, mirrors AlertsStore) persists
  `Watch[]` to `userData/agent/watches.jsonl`. Single-shape
  `WatchTrigger` (rubric + optional companyIds + topics); no kind
  taxonomy. `WatchExecutor` hooks into a new
  `Heartbeat.postCandidateHook` slot — runs after the primary
  alert judge with the same candidate set, filters by each due
  watch's scope, fires one yup-validated rubric LLM call per
  surviving candidate, persists hits as Alerts tagged
  `kind: "evaluation-flag"` with `sourceRef = watch:{id}:{ref}`
  for dedup, advances `lastCheckedAt` even on error so a broken
  watch can't block the loop. Cadence-respecting: weekly watches
  fire once per week regardless of heartbeat tick frequency. Cap:
  20 active watches per tenant, enforced at register + resume.
  Five chat tools: `watch_list`, `watch_register` (propose-and-
  confirm via `ask_user_choice` showing the draft verbatim),
  `watch_remove`, `watch_pause`, `watch_resume` (with cap re-
  check). Topbar `WatchChip` between spacer and AlertBell;
  always-visible-when-≥1-active count + capacity-coloured dot
  (green ≤50%, orange 51–89%, red ≥90% with extra ring + warn
  text in the popover). Click → 380 px popover with 5
  most-recently-fired watches + "Verwalten in Einstellungen →"
  footer. Prompt section *Standing Watches / Beobachtungen*
  added with synonym list (Watch = Beobachtung = Standing
  Instruction = Wiederkehrender Check) + every trigger phrase
  mapped + concrete-rubric hint ("'Wechsel auf C-Level' ja, 'irgendwas
  Wichtiges' nein"). New IPC: `watches:list` / `watches:remove` /
  `watches:setEnabled` + push channel `watches:changed`.
  Settings panel surface for watches deferred to 8.t3 polish — the
  chip popover + chat tools cover the v1 management story.
- **8.t3 — Polish.** *(Conditional on observed data.)* If a small
  set of rubric patterns fires repeatedly across watches, graduate
  them into pre-filter shortcuts so the executor can short-circuit
  the LLM call. Configurable cap (raise / lower the 20-watch limit
  per tenant). Best-match completion uses a direct event hook in
  main, NOT this watch infrastructure (one-shot signal vs. recurring
  pattern match).
- **8.t4 — Profile-aware ranking.** Score formula in
  `freshness-scheduler.ts` and the alert judge gain a "matches
  the user's interests?" multiplier from the profile's structured
  fields. Pure additive over what 8.t1-t3 ship; only meaningful
  once profiles are non-empty for a real population of users.

### Touch points

- **`src/main/agent/profile-store.ts`** — new.
- **`src/main/agent/watch-store.ts`** — new (JSONL, mirrors
  alerts-store).
- **`src/main/agent/watch-executor.ts`** — new; called from the
  existing heartbeat tick after the alert judge runs.
- **`src/main/agent/tools/profile.ts`** — `profile_get` /
  `profile_set` / `profile_propose_update` / `profile_clear`.
- **`src/main/agent/tools/watches.ts`** — five watch tools.
- **`src/main/agent/prompts.ts`** — profile-injection block at
  the top of the system prompt; first-run-nudge text; the
  hard "no silent edits, always propose-and-confirm" rule;
  watch-management trigger phrases.
- **`src/renderer/src/routes/Settings.tsx`** — *Profil &
  Beobachtungen* panel.
- **`src/renderer/src/components/WatchChip.tsx`** — new; topbar
  count + capacity-coloured dot + popover (8.t2). Mirrors the
  AlertBell construction so the two chips read as a pair.
- **`src/renderer/src/components/AppShell.tsx`** — slot the
  WatchChip between the spacer and AlertBell.
- **`shared/types.ts`** — `UserProfile`, `Watch`, `WatchTrigger`.

### Open design questions

- **First-run nudge wording / placement**: the proposed nudge
  appends a paragraph to the agent's first reply. Some users will
  resent any startup ceremony, even an opt-out one. Mitigation:
  one click to skip, sticky `profileSkipped: true` flag, no badge,
  no banner, no re-prompting unless the user explicitly says
  "lass uns mein Profil mal aktualisieren". If real users still
  hate it, the fallback is moving the prompt into a one-time
  Settings tour that fires only when they navigate there.
- **Profile drift via propose-and-confirm**: how aggressive should
  the agent be at SUGGESTING updates? Plan says "one suggestion
  per conversation max". If the user always declines, the agent
  should learn to suggest less often (per-tenant counter that
  decays the suggestion frequency after N consecutive declines).
  Land this only if observed behaviour requires it.
- **Privacy**: profile + watches are on-device by design. If
  multi-device sync becomes a need, gate behind an explicit
  user opt-in.

> Resolved during the 2026-04-30 design review (kept as a record):
> *LLM trigger reliability* + *watch fan-out cost* — collapsed by
> moving to the single-shape `WatchTrigger` (rubric + optional
> companyIds / topics scoping) and cadence-respecting evaluation,
> capped at 20 active watches per tenant. Math: 20 watches × mixed
> cadences ≈ 50 LLM calls per week, fully governable.
> *Profile auto-extraction* — replaced with first-run nudge +
> propose-and-confirm. Hard "no silent edits" rule in the prompt.

## 8.u — Build & distribution (NEW)

Goal: `pnpm package:mac` and `pnpm package:win` produce signed,
notarized installers that **a non-technical end user can double-click**.
The installed app:

- Knows where the gateway is, who its OIDC issuer is, and which app
  it identifies as — every production endpoint baked in at packaging
  time.
- Holds NO server secrets. Anything sensitive (DB credentials,
  fly.io API tokens, JWT signing keys) lives ONLY on the server side
  the desktop talks to. Per-user secrets (refresh tokens, OpenAI
  keys) are encrypted via Electron's `safeStorage`.
- Carries a deterministic, human-readable version number tied to a
  Git tag.
- Auto-checks for updates on launch + on demand, downloads + verifies
  + installs them with the user's consent, and supports rolling
  out platform-specific releases independently.

### Mental model — what's a "secret" and where does it live?

Three buckets. Mixing them up is how desktop apps leak credentials.

| Bucket | Lifetime | Where it lives | Example |
|---|---|---|---|
| **Public config** | Per-build | Bundled in the app at packaging time, plain JSON | Gateway URL, Keycloak issuer URL, OIDC `client_id` for the desktop public client, update server URL, app version |
| **Per-user secret** | Per-install | Encrypted via `safeStorage` under `app.getPath("userData")` | OIDC refresh token (8.a), OpenAI/Anthropic API keys (8.j), local model paths |
| **Server-only secret** | Centralised | Fly.io secrets / 1Password / SOPS — NEVER on the desktop | DB credentials, JWT *private* keys, fly.io API token, third-party webhook secrets |

The desktop **never** receives or stores a server-only secret. When
the desktop needs a privileged operation (DB read, agent fan-out,
upstream provider call), it talks to db-gateway with a Bearer JWT;
the gateway holds the actual privilege and translates the call. This
is already the architecture (D3 / D11) — §8.u just commits to never
breaking it.

The "fly.io Managed Postgres" credential the user mentioned belongs
firmly in bucket 3. The desktop never sees it. Only db-gateway,
running on fly.io with the credential injected as a fly secret,
talks to Postgres.

### Scope

**8.u1 — Cross-platform packaging.** electron-builder configured
for `dmg` (macOS arm64 + x64) and `nsis` (Windows x64); existing
`package:*` scripts already wire `pnpm fetch:ollama` + `pnpm
fetch:whisper` before the build so binaries land in
`extraResources`. Add the missing pieces:

- **Code signing** (mandatory on macOS for Gatekeeper, strongly
  recommended on Windows for SmartScreen):
  - macOS: Developer ID Application certificate stored in CI
    secrets, identity wired via `mac.identity` in
    electron-builder.yml. Existing TODO marker in the file gets
    filled in.
  - Windows: EV (or OV) code-signing cert. `win.certificateFile`
    + `win.certificatePassword` from CI secrets. EV has a
    one-time HSM dance; OV is cheaper but still subject to
    SmartScreen reputation building. Plan for OV initially +
    revisit when ship volume justifies EV.
- **Notarization** (macOS only, Apple's gate against unsigned-by-
  intent malware):
  - `mac.notarize` block with `appleId` + `appleIdPassword` (an
    app-specific password) or `teamId` + Apple ID API key. Done
    in CI after signing; fails the build on rejection.
  - Stapling via `electron-builder` post-step so the .dmg ships
    with the notarization ticket and works offline on first
    launch.
- **CI workflow** (GitHub Actions, one job per platform):
  - macOS-arm64 / macOS-x64 / windows-x64 runners.
  - Pulls release tag → runs `pnpm install` → `pnpm package:<plat>`
    → uploads artifacts + the auto-generated update manifests
    (`latest-mac.yml`, `latest.yml`).
  - Branch-protected so `package:linux` doesn't accidentally ship
    until 8.u Linux work begins (out of scope here).
- **Reproducibility**: `pnpm install --frozen-lockfile` + lockfile
  committed; `WHISPER_CPP_VERSION` / `OLLAMA_VERSION` pinned at
  CI level so two runs of the same tag produce byte-identical
  archives modulo timestamps.

**8.u2 — Production config + secret hygiene.**

- **`shared/config.ts`** new module: source-of-truth for all build-
  time config. Reads from `import.meta.env.VITE_*` at build time
  for the renderer + `process.env.AVA_*` at packaging time for
  main. Falls back to dev defaults so local dev still works.
  Fields:
  ```ts
  export interface AppConfig {
    gatewayUrl: string;        // e.g. https://gateway.ava.app
    authIssuer: string;        // OIDC issuer (Keycloak realm URL)
    authClientId: string;      // public OIDC client id
    updateUrl: string;         // electron-updater feed URL
    updatePublicKey: string;   // ed25519 pubkey for verifying
                               // update artifacts (DSA fallback for
                               // legacy electron-updater)
    appVersion: string;        // injected from package.json at build
    isProduction: boolean;
  }
  ```
- **electron-builder env injection**: `extraMetadata.version` set
  from the Git tag during CI; `--define`s for the renderer Vite
  build; `process.env.NODE_ENV=production` for main.
- **No `.env` file in the bundle**. Anything in `.env` is just
  unencrypted text — bundling it = bundling a plain-text secret
  store. Public config goes through the source-baked path above.
- **Per-user secrets** stay on `safeStorage`:
  - macOS: Keychain-backed (per the existing 8.j infrastructure).
  - Windows: DPAPI per-user.
  - Linux: libsecret with the basic-obfuscation fallback already
    surfaced in `safeStorage.isEncryptionAvailable()`.
- **Tamper-resistance posture**: the bundled JS is plain text in
  the .asar — anyone willing to unpack can read public config.
  That's *fine* (none of it is secret). For the truly motivated
  attacker we can later layer asar integrity (electron 30+'s
  `asarIntegrity` block) which fails launch on tampering. Track
  as 8.u5 polish.

**8.u3 — Versioning + release channels.**

- **semver in `package.json`**: `1.0.0` baseline. `package:*`
  bakes this into the bundle's `Info.plist` (CFBundleShortVersion-
  String) / Windows VERSIONINFO so users see it in About / right-
  click Properties.
- **Git-tag-driven CI**: pushing a tag `v1.2.3` triggers the
  release workflow; the workflow rejects builds where the tag
  doesn't match `package.json.version` (catches the "forgot to
  bump" mistake).
- **Channels** via electron-builder's `channel` field:
  - `latest` — production release.
  - `beta` — opt-in pre-release for staff / pilot customers.
  - `alpha` — internal dogfood.
  Tag suffixes (`v1.2.3-beta.1`) route to the corresponding
  channel automatically.
- **Per-platform independence**: each platform's CI job publishes
  to its own update manifest (`latest-mac.yml`, `latest.yml`,
  `latest-linux.yml`). Bumping macOS to 1.2.4 leaves Windows on
  1.2.3 until that platform's CI ships its own build. The
  `version` in package.json stays the marketing version; the
  per-platform releases roll forward independently.

**8.u4 — OTA updates via electron-updater.**

- **Library**: `electron-updater` (the de-facto Electron auto-
  update framework, maintained alongside electron-builder so the
  manifest formats line up).
- **Publish target**: GitHub Releases for v1, S3 / R2 for v2 once
  release-volume warrants it. The auto-generated `latest-mac.yml`
  / `latest.yml` artifacts get attached to each Release; the app
  fetches them from `https://github.com/<org>/<repo>/releases/
  download/<tag>/latest-mac.yml` (or whichever feed the
  `publish` config points at).
- **Update lifecycle in main**:
  ```
  app.whenReady → autoUpdater.checkForUpdatesAndNotify()
                  ↓
              update-available event → renderer ipc push
                  ↓
              user clicks "Jetzt aktualisieren" → autoUpdater.downloadUpdate()
                  ↓
              update-downloaded → renderer ipc push
                  ↓
              user clicks "Neustart & installieren" → autoUpdater.quitAndInstall()
  ```
- **Renderer UX**: a small banner above the topbar when
  `update-available` fires:
  ```
  Eine neue Version ist verfügbar (1.2.4 → 1.2.5). [Jetzt aktualisieren] [Später]
  ```
  When the download finishes:
  ```
  Update bereit. [Neu starten & installieren] [Beim nächsten Start]
  ```
  Settings panel gets a "Nach Updates suchen" button + "Update-
  Kanal" radio (latest / beta / alpha) for opt-in pre-release.
- **Signature verification**: electron-updater verifies SHA512 of
  the downloaded artifact against the manifest, and (when
  `publisherName` is configured) verifies the macOS notarization
  / Windows code-signing chain matches what's expected. We DON'T
  invent our own ed25519 signing on top — the platform-native
  signing from 8.u1 is the trust root. `disableWebInstaller:
  false` stays default (so users with admin rights can swap an
  unsigned manual download in only by explicit choice).
- **Background updates** (silent download, prompt-only-on-ready)
  via `autoUpdater.autoDownload = true` once the channel
  + signing story is stable. Defer until 8.u4-v2 — first ship with
  explicit user-confirmation download so we see install-success
  rates before going silent.
- **Rollback story**: not in v1. If a release breaks something,
  ship 1.2.6 over 1.2.5; users update on next-launch check.
  Track delta updates / blockmap diffs as 8.u-future.

**8.u5 — Cross-platform mic permission re-test.** Verify the dev-
mode TODO from 8.n2 disappears in the packaged build. Acceptance:
fresh-installed `.dmg`, first launch, click mic, OS prompt fires
with the correct app name + usage description, "AVA Desktop"
appears in System Settings → Privacy → Microphone.

### Out of scope (defer)

- **Linux .AppImage / .deb** — electron-builder supports it; we
  just don't have a target customer there. Track as 8.u-linux.
- **App-Store distribution** (Mac App Store, Microsoft Store) —
  needs sandboxing, separate entitlements, store review. Out of
  band of the OTA model entirely.
- **Delta updates** (block-level patches) — supported by
  electron-updater but adds CI complexity. Add when full-package
  download size becomes a real complaint.
- **Forced updates** (server-driven "you cannot use the app until
  you upgrade") — better UX for the v2 once we have telemetry on
  install latencies. Avoid in v1 to not anger users.
- **Telemetry / crash reporting** — should land alongside but
  involves a separate privacy review (GDPR, opt-in policy). Track
  as a sibling substep.

### Acceptance

- `git tag v1.0.0 && git push --tags` triggers the GitHub Actions
  workflow → both macOS arm64+x64 .dmg and Windows x64 .exe
  artifacts attach to the GitHub Release within ~15 min.
- Both bundles are signed + notarized; a non-technical user
  double-clicks the .dmg / .exe, drags or runs through NSIS, and
  the app launches without Gatekeeper / SmartScreen warnings.
- About → Version reads `1.0.0`. Right-click → Properties on
  Windows shows the same.
- Settings → "Nach Updates suchen" reports "Du bist auf der
  neuesten Version" the day of release.
- Push `v1.0.1` → next launch of an installed `1.0.0` shows the
  update banner; clicking through downloads, verifies, restarts,
  and the new version's About screen reads `1.0.1`.
- Pushing `v1.0.2-beta.1` does NOT promote `latest`-channel users;
  flipping the user's channel to "beta" in Settings → next check
  picks up `1.0.2-beta.1`.
- macOS shipped at `v1.0.1` with Windows still on `v1.0.0` is a
  valid state — both manifests are independent.
- No `.env` / `.envrc` / secret-shaped string survives a `find`
  through the unpacked .asar.

### Phasing

- **8.u1 — Packaging baseline. _(done 2026-04-30)_** Hardened-
  Runtime entitlements (`build/entitlements.mac.plist`) cover
  JIT, dyld env, library-validation off, mic input, network
  client — narrowest set that lets V8 + the bundled sidecars
  (Ollama, whisper-cli) run while keeping camera / location /
  screen recording explicitly off the bundle's surface. Updated
  `electron-builder.yml`: `mac.identity: null` (lets electron-
  builder pick the imported keychain identity at CI time),
  `hardenedRuntime: true`, `entitlements` + `entitlementsInherit`
  pointed at the new plist, `notarize: false` in the YAML so
  developer-machine builds don't trip on missing creds —
  notarization gets force-enabled in CI via the
  `ELECTRON_BUILDER_NOTARIZE` env. `publish:` block configured
  for GitHub Releases (`provider: github, releaseType: release,
  vPrefixedTagName: true`). Windows code-signing intentionally
  deferred per the customer's pilot-rollout posture; YAML keeps
  the `nsis` target unsigned with a comment marking the future
  OV slot.
  `.github/workflows/desktop-release.yml` runs three jobs in
  parallel on tag push (`v*`): macOS arm64 + macOS x64 (both
  signed via `apple-actions/import-codesign-certs` + notarized
  via `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
  secrets), and Windows x64 (unsigned). Each job runs the
  per-platform `pnpm fetch:ollama` + `pnpm fetch:whisper` first,
  then `electron-builder --publish always` which uploads the
  installer + auto-update manifests to the matching GitHub
  Release. Two new pre-flight scripts:
  `scripts/validate-version-tag.mjs` (asserts `package.json.version`
  matches the Git tag, fails the workflow fast on a missed bump)
  and `scripts/check-bundle-secrets.mjs` (post-build grep across
  `out/` + `release/` for `*_SECRET=` / `*_TOKEN=` / `*_PASSWORD=`
  patterns + PEM private-key headers, with an allow-list for the
  known public-config identifiers like `AUTH_CLIENT_ID` and
  `GATEWAY_URL`). `pnpm audit:bundle` runs the same locally.
- **8.u2 — Production config separation.** ✅ Done.
  `src/shared/config.ts` is the single source-of-truth: layered
  resolution `process.env.AVA_*` → `process.env.{GATEWAY_URL,…}`
  (back-compat) → hard-coded prod defaults when packaged, dev
  defaults when launched via `electron-vite dev`. Resolved once at
  main boot using `app.isPackaged` + `app.getVersion()`. The
  resolved bundle is exposed via `app:getConfig` IPC so the
  renderer + Settings "About" panel can read gateway URL, OIDC
  issuer, OIDC client id, update channel, app version, isDev.
  Dev-auth-bypass is double-guarded: env flag AND `!isPackaged`,
  so a packaged binary refuses to honor it even if the env is
  set. `scripts/check-bundle-secrets.mjs` extended with three
  bucket-3 (server-only) patterns — postgres connection strings
  with embedded creds, fly.io API token references, JWT-shaped
  blobs — plus a forbidden-filename sweep that fails the build
  if any `.env*` / `secrets.{json,yml}` lands in `out/` or
  `release/`. Negative-test verified: planted leak files trip the
  scanner, scanner returns clean once removed.
- **8.u3 — Channels + version policy.** Multi-channel publish,
  tag-driven CI gating, per-platform independent versions.
- **8.u4 — electron-updater integration.** In-app banner, opt-in
  download, signature verification, channel toggle in Settings.
- **8.u5 — Mic-permission verification in packaged build.**
  (8.n2 deferred TODO.)

### Touch points

- **`electron-builder.yml`** — fill the `mac.identity` /
  `mac.notarize` blocks, add `win.certificateFile`,
  `publish: { provider: github, repo: …, owner: … }` (or s3),
  `mac.extendInfo` already done.
- **`.github/workflows/release.yml`** — new; mac+win matrix,
  signing-secret env, artifact upload, manifest publish.
- **`package.json`** — add `"build": { "appId":
  "com.ava.desktop", "productName": "AVA Desktop", … }` if not
  already in electron-builder.yml; bump to `1.0.0`.
- **`src/shared/config.ts`** — new; `getAppConfig()` reads
  Vite/process env at build time and freezes the result.
- **`src/main/updater.ts`** — new; wraps `electron-updater` with
  the IPC + state machine the renderer banner consumes.
- **`src/preload/index.ts`** — `window.api.updater.*` surface.
- **`src/renderer/src/store/updater.ts`** — Zustand mirror.
- **`src/renderer/src/components/UpdateBanner.tsx`** — new;
  rendered in AppShell above the topbar when an update is
  pending or downloaded.
- **`src/renderer/src/routes/Settings.tsx`** — *Updates* panel
  with manual check + channel radio.
- **`scripts/check-bundle-secrets.mjs`** — new; CI step that
  greps the unpacked .asar for any `*_SECRET` / `*_TOKEN` /
  `password=*` patterns and fails the build on a hit. Catches
  accidental `.env`-leak regressions.
- **`AGENT_PLAN.md`** — this section.

### Resolved decisions (2026-04-30)

- **OTA feed**: GitHub Releases for v1.
- **macOS code-signing**: in scope. The customer already holds an
  Apple Developer Program account from a prior App Store product;
  Developer ID Application identity will be reused for outside-
  store distribution + notarization via the same account.
- **Windows code-signing**: deferred. Initial Windows builds ship
  unsigned; users see a SmartScreen "unrecognized publisher"
  warning on first launch and must click "More info → Run anyway".
  Acceptable for a B2B / pilot rollout; revisit OV cert when
  consumer / scale audience starts.

### Open design questions

- **Background download default**: silent download with prompt-
  only-on-ready is the standard ChatGPT / VS Code pattern, but
  hides bandwidth use from the user. Default to explicit-confirm
  download in v1 for transparency; flip the default in v2 once
  install-success rates look healthy in telemetry.
- **Forced minimum version**: do we want a "you must update past
  X to keep using the app" gate? Useful when a security fix
  ships, painful when users are mid-flight. Defer until we've
  seen one such fix; can land as a v2 IPC handshake the gateway
  participates in.
