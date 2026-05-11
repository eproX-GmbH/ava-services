# Changelog

Notable changes per release of `@ava/desktop`. Older releases (pre-v0.1.90) are
not back-filled here; check `git log --grep "(v0.1."` for tagged context.

The repo uses one rolling tag per desktop release (`v<major>.<minor>.<patch>`)
on `main`. Submodules cut their own feature branches and are pinned via the
desktop bundle; `pnpm fetch:producers` re-vendors them into the .dmg.

## v0.1.112 — 2026-05-10

- **LinkedIn-Beobachter: extraction selector refresh.** v0.1.110
  anti-detection let the real feed render, but `postsSeen` stayed at
  zero — LinkedIn had shipped a DOM/class rename and the three
  hard-coded post-wrapper selectors no longer matched. This release:
  - Broadens the post-wrapper match list to 12 candidates covering
    `article` / `li` / `div` wrappers, the newer `data-id="urn:..."`
    attribute, and class-only fallbacks (`.feed-shared-update-v2`,
    `.update-components-update-v2`, `.feed-update-v2`). The URN is
    resolved from `data-urn`, `data-id`, a nested `[data-urn]`, or
    finally parsed out of a `/feed/update/<urn>/` permalink.
  - Hedges every per-post sub-selector (actor scope, body, sub-line,
    article link, permalink) against a candidate list and returns the
    first non-null match.
  - Dumps the feed container's `outerHTML` (capped at 2 MB) to
    `<runDir>/05_feed_html.html` right before extraction, mirroring
    the existing best-effort screenshot pattern, so selector drift
    can be diagnosed offline from the run folder alone.
  - Logs a `candidateCounts` / `finalCount` diagnostic via the
    existing `console.info` channel and stashes the same object in
    `run.json` under a new optional `extractionDiagnostic` field
    (`LinkedInRunMeta` updated accordingly).
  Downstream extractor shape (`postUrn`, `author`, `mediaUrls`, …)
  is unchanged; only which selectors find each field was relaxed.

## v0.1.111 — 2026-05-10

- **handelsregister.de scraper: JSF sidebar navigation.** The direct
  URL `https://www.handelsregister.de/rp_web/erweiterte-suche.xhtml`
  now returns HTTP 400 with a German security-session-end page, so
  every handelsregister scrape was failing at step 2 of the flow.
  The fix routes through the real navigation path:
  1. Land on `welcome.xhtml`, dismiss the cookie banner.
  2. Open the PrimeFaces sidebar via `#topbar-menu-button` if the
     "Erweiterte Suche" link is not already visible (the sidebar
     auto-opens on some loads, so we probe first).
  3. Click the link, selected by `//a[contains(@onclick,
     'erweiterteSucheLink')]` (XPath against the stable JSF param
     value), with visible-text and `j_idt46` id fallbacks.
  4. Wait for the `Registergericht` select to render — the JSF
     post-back leaves the URL as `welcome.xhtml`, so URL is not a
     usable readiness signal.
  Form filling, results-row SI click, and XML capture are unchanged.
  Submodule branch: `fix/handelsregister-sidebar-nav-v0.1.111` in
  `structured-content`, pinned via the desktop bundle.

## v0.1.110 — 2026-05-10

- **LinkedIn-Beobachter: anti-fingerprint hardening.** Earlier runs
  hit a session kill mid-hydration: cookies passed the auth check, but
  LinkedIn detected the headless-Electron fingerprint and re-rendered
  the feed as the anonymous marketing page. This release closes six
  classic detection holes.
  - Hidden `show: false` window replaced with a visible, transparent,
    off-screen window (`x/y = -2000`, `setOpacity(0)`, `skipTaskbar`,
    `frame: false`). Real outer dimensions, real paint, invisible to
    the user. Set `AVA_LINKEDIN_DEBUG_WINDOW=1` to show the window
    normally for inspection.
  - `navigator.userAgentData` now returns Chrome-124 brands (no
    "Electron" / "HeadlessChrome"), with a matching high-entropy
    payload and `platform: "macOS"`. `navigator.platform`,
    `hardwareConcurrency`, `deviceMemory`, `screen.*` and
    `window.outer*` are all pinned to plausible Mac values.
  - Stealth overrides are re-injected on every `did-start-navigation`
    and `dom-ready`, not just once on the initial `about:blank`, so
    LinkedIn's in-app route changes never see a clean prototype.
  - Scroll loop is fully `sendInputEvent`-based. The previous JS
    `window.scrollBy` fallback is removed; if the wheel event fails
    we skip the cycle rather than emit an untrusted scroll. Wheel
    delta jitters between 500-850px, with an extra 400-1200ms random
    delay between cycles and a 30% chance of a pre-scroll mouseMove.
  - Pre-scroll human warmup: 2-4s wait, two mouseMoves, one small
    wheel nudge, then another second before the main scroll loop
    starts.

## v0.1.109 — 2026-05-10

- **LinkedIn-Beobachter: per-run screenshot capture.** Each scrape now
  drops a timestamped folder under `userData/linkedin/runs/` with PNG
  shots at every checkpoint (initial nav, auth check, feed loaded, each
  scroll cycle, before extraction, error) plus a `run.json` sidecar
  with outcome, postsSeen, url and userAgent. Retention is capped at
  the last 10 runs; older folders are pruned on each new run.
  Screenshot capture is best-effort and cannot break the scrape.
  Settings panel gains a "Letzte Läufe" fieldset listing the most
  recent runs with an "Ordner öffnen" button each. Debugging-
  transparency only; scrape logic is unchanged.

## v0.1.108 — 2026-05-10

- **Chat bubble.** User message bubble flipped from indigo→violet gradient to
  flat `#0a3d36` deep teal. Contrast with white text is ~10.5:1, passes
  WCAG AAA (4.5:1 required for AA, 7:1 for AAA on normal text). No gradient.

## v0.1.107 — 2026-05-10

- **Chat agent: proactive re-import on data gaps.** When the company fan-out
  shows the company exists in master-data (`company_get` hit) but 3 or more
  content facets come back empty / 404 / 500 (profile, keywords, website,
  publications, contacts, structured-content), the agent now calls
  `import_company` unprompted with the name + city pulled from the
  `company_get` result. Previously the agent narrated the gaps in prose and
  waited for the user to ask. Idempotency: the rule does not re-fire if an
  import for that company already ran earlier in the same chat.

## v0.1.106 — 2026-05-10

- **Keywords persist fix.** `company-profile` producer now calls
  `getCompanyKeywords` alongside `getCompanyProfile`, includes the result in
  the persist payload, and emits the `companyEvaluation.upsertKeywords`
  downstream event. Gateway `applyCompanyProfile` does a transactional
  delete-then-insert into `CompanyKeyword` (zod-validated). Before this fix
  the company-profile cell turned green in the matrix but the
  `CompanyKeyword` table stayed empty.
- **Evaluation pending fix (derived cell).** `companyEvaluation` is now
  derived in the matrix read path from its upstream set
  `{structuredContent, companyPublication, website, companyProfile, companyContact}`:
  any upstream `in_progress` → `in_progress`; all upstreams terminal with
  at least one `completed` → `completed`; all upstreams terminal with none
  completed → `skipped`; otherwise `pending`. Sidesteps the pre-seeded
  `pending` row that never got overwritten when the v0.1.80 progress-signal
  cleanup removed per-slice `in_progress` publishes.

## v0.1.105 — 2026-05-10

- **Multi-source reachability monitor.** The single-service upstream probe
  expanded to an array of probed services with per-service hysteresis
  (`FAILED_PROBES_THRESHOLD=2`), 5-minute fast-path cooldown, 405-tolerance,
  and a 120-second probe cadence. Today probes `unternehmensregister.de`
  and `handelsregister.de`. Whoami got an "Erreichbarkeit der Quellen"
  panel showing per-service state + last-checked timestamps.
- **Dynamic upstream banner.** Banner hides when all sources reachable;
  lists each unreachable service with a fallback hint when only some are
  down; signals producer-paused state when all are down. Dismiss-suppress
  is keyed by signature, so a future combination of outages isn't silently
  muted by a prior dismissal.
- **Handelsregister.de fallback for structured-content.** New
  `handelsregister-webdriver.ts` in the structured-content submodule:
  cookie dismiss → erweiterte Suche form fill → SI link click → XML
  capture (handles both inline-render and download-attachment branches via
  perf-log + `node-fetch` with session cookies). XML output is identical
  in shape to unternehmensregister, so no DB schema change. The producer
  picks the source at each spawn via `AVA_STRUCTURED_CONTENT_SOURCE`, set
  by `pickStructuredContentSource()` in main; preference is
  handelsregister → unternehmensregister.
- **Auto-pause widened.** Structured-content producer only auto-pauses when
  **both** upstreams are down. Company-publication still pauses on
  unternehmensregister-down alone (no fallback there yet).

## v0.1.104 — 2026-05-09

- Per-tab tier pills on the company detail page (replaces the prominent
  Datenqualität top banner).
- Sidebar collapsed icon stack polish.

## v0.1.103 — 2026-05-09

- Stripe `cancel_at_period_end` surfaced in Settings as
  „Kündigung zum X vorgemerkt", with a helper to take it back. Webhook
  captures the flag on `subscription.updated`.

## v0.1.102 — 2026-05-09

- Reachability banner triggers less eagerly: 120s probe interval, two
  consecutive failures required, 5-minute cooldown on fast-path probes
  triggered by producer error reports, 405 tolerated as a reachable
  signal.

## v0.1.101 — 2026-05-09

- Plan & Abrechnung redesigned with 4-up comparison cards + tier-aware
  CTAs. „Empfohlen" badge on the Pro tier. „Abonnement verwalten" hidden
  for free users (would otherwise 400 against the portal).

## v0.1.99 — 2026-05-08

- CI vendor bug fix: the `prepare: tsc` lifecycle in vendored producer
  `package.json` was rebuilding `dist/` from stale committed `src/` on
  every `npm install`, silently wiping `getCurrentTier` / `getCurrentModel`
  exports. The fix strips `prepare` / `postinstall` / `preinstall` /
  `install` from staged vendor `package.json` before npm install runs.
  Release workflow no longer swallows producer build failures with
  `|| echo skipped`.

## v0.1.91 → v0.1.98 — LinkedIn-Beobachter (L0 → L7)

Opt-in LinkedIn feed beobachtung over 8 phases. Hidden Electron
`BrowserWindow` on `persist:linkedin` partition; `safeStorage`-encrypted
cookies; vision-LLM image analysis; entity linking against master-data;
heartbeat polling; surfaced via `/linkedin` route with filter bar +
signal cards + lightbox. Anti-detection hardening in L7.

## v0.1.75 — 2026-05-06

- Restored the `@theme {` opener in `styles.css` that v0.1.68 silently
  dropped. v0.1.69 → v0.1.74 had CSS tokens floating outside any block,
  Tailwind parser failing in CI, every release silently broken for seven
  bumps because `build:typecheck` doesn't compile CSS. Open follow-up:
  wire the renderer build into `build:typecheck` so this fails locally.
