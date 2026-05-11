# @ava/desktop

The AVA Electron desktop app — replaces the legacy `user-interface/` Next.js
client. Talks **only** to `db-gateway` (no direct DB / RabbitMQ access).

## Stack

- **electron-vite** — three-process bundler (main / preload / renderer)
  with HMR for both main and renderer.
- **React 18** + **react-router-dom** (HashRouter — no server required).
- **@tanstack/react-query** for HTTP cache.
- **zustand** for app-level state (gateway URL, future auth token).
- **electron-builder** for installer packaging (mac / win / linux).

## Layout

```
src/
  main/        Electron main process (BrowserWindow, IPC handlers, auth).
  preload/     Bridge module exposed to the renderer as window.api.
  renderer/    React app (renderer process, sandboxed, no Node).
    src/
      api/      Gateway client (fetch + SSE).
      routes/   Screen components (W1–W25 workflows).
      store/    Zustand stores.
```

## Development

```bash
# from services/desktop
pnpm install
GATEWAY_URL=http://localhost:8080 pnpm dev
```

The renderer expects the gateway to be reachable at `GATEWAY_URL` (defaults
to `http://localhost:8080`, which matches `db-gateway`'s `.env.example`).
Use `bash scripts/dev.sh` from the meta-repo root to start the gateway plus
upstream services in another terminal.

## Shipped surfaces (v0.1.120)

- **AI-Chat** (`/chat`) — primary interface. Agent has 92 tools (full
  inventory in [`TOOLS.md`](../../TOOLS.md), auto-generated from the
  TS sources). System prompt + tool definitions under `src/main/agent/`.
  The fan-out for open company questions includes `company_crm_summary`
  for CRM-linked companies (cache-safe, 6h TTL). LinkedIn-Beobachter
  setup + CRM linkage are now also drivable from chat
  (`linkedin_connect`, `crm_link_manual`, `crm_enrich_now`, etc.).
- **Companies / company detail** (`/companies`, `/companies/:id`) —
  per-tab tier pills, overview / financials / management / contacts /
  insights / jobs tabs. PersonCard collapses field-grouped Facts behind
  a "+N Varianten" toggle; INACTIVE rows hide in a `<details>` history
  disclosure. Tier pill tooltip is CSS-driven (no native delay).
- **Transactions matrix** (`/transactions`, `/transactions/:id`) —
  live pipeline grid via SSE bridge, drilldown to producer logs. Failed
  cells show an "Nx" badge after the second attempt and a German retry-
  status line in the tooltip ("Wartet auf erneuten Versuch in 8 Min" /
  "Erneuter Versuch fällig" / "Aufgegeben nach 5 Versuchen"). The
  retry-ticker auto-retries failed cells every 10 min, prioritising
  lower attempt counts; user can disable via Settings → Meldungen.
- **LinkedIn-Beobachter** (`/linkedin`) — opt-in feed monitoring with
  vision-LLM image analysis. See `src/main/linkedin/`. Per-run
  screenshot folder + `run.json` under `userData/linkedin/runs/`.
  Open-link modal warns about LinkedIn flagging before navigating;
  Sponsored posts skipped at extraction time.
- **Whoami / Status** (`/whoami`) — multi-source reachability panel
  (unternehmensregister.de + handelsregister.de), active provider,
  build info.
- **Settings** (`/settings`) — provider selection (Ollama / OpenAI /
  Anthropic / Google / Mistral), Stripe portal, voice setup, LinkedIn
  controls, freshness preferences, heartbeat auto-retry toggle.
- **Ingest / First-run wizard** (`/ingest`, `/first-run`) — Excel + CSV
  + single-company + CRM (HubSpot today; Salesforce + Dynamics stubbed)
  imports. Confirmed matches persist a CompanyCrmLink so the agent can
  pull CRM context on demand. Excel auto-detects typed CRM-ID columns
  (`hubspot_id`, `hs_object_id`, `salesforce_id`, `sfdc_id`, `sf_id`,
  `dynamics_id`, `msd_id`, `dataverse_id`, `d365_id`).
- **Alerts + chat history** — bell dropdown + searchable chat archive.

## Packaging

```bash
pnpm package:mac      # arm64 .dmg + .zip in dist/
pnpm package:win
pnpm package:linux
```

`scripts/fetch-ollama.mjs`, `scripts/fetch-whisper.mjs`, and
`scripts/fetch-producers.mjs` vendor the Ollama binary, Whisper.cpp +
Distil-Whisper-DE GGUF, and the 6 producer subprocess bundles into
`resources/` before electron-builder runs. CI workflow at
`.github/workflows/desktop-release.yml`.

## Auth + SSE

OIDC PKCE flow lives in `src/main/auth/`. Tokens are stored in OS keychain
via `safeStorage`. The renderer's SSE wrapper uses
`@microsoft/fetch-event-source` so the bearer token rides in the
`Authorization` header rather than the query string.

## Skills

User-authored `SKILL.md` files extend the chat agent with personas
and workflow templates. AVA looks under `<userData>/skills/<name>/`
and `<repo>/.ava/skills/<name>/`. Format reference + frontmatter
table lives in [`SKILLS.md`](../../SKILLS.md) at the repo root.

S1 (loader + schema + hot-reload) shipped in v0.1.121. S2 (agent
integration: system-prompt block, `/skill-name` invocation,
enforced tool allowlist, `metadata.ava.requires` gate evaluator
against CRM + Ollama) shipped in v0.1.122 — see `PLANS.md` §2 and
the Tool-Allowlist + `/skill-name` sections in [`SKILLS.md`](../../SKILLS.md).

**Starter skills (S6, v0.1.123):** 3 starter skills shipped:
`outreach-draft-de`, `qualifying-fragebogen`, `wettbewerber-uebersicht`.
They auto-vendor into `<userData>/skills/` on first launch and are
user-editable from there. The vendor step is no-overwrite — once a
file exists in `<userData>/skills/<name>/`, AVA never touches it
again on upgrade, so local edits survive. To re-pull the shipped
version delete the file and relaunch.

**Settings → Skills (S3, v0.1.124):** read-only inventory under
*Einstellungen → Skills*. Lists every loaded skill with its
`b2b-scope` + scope-source pill, lets the user toggle each on or off
(persisted in `<userData>/skills-prefs.json`), and opens the raw
markdown body in a modal. Gate-failing skills (`metadata.ava.requires`)
stay visible with a German "Voraussetzung fehlt: …" reason instead of
disappearing silently. In-app editor + zip import/export land with
S4/S5.

## Tooling notes

- After touching anything under `src/main/agent/tools/*.ts`, run
  `pnpm -F @ava/desktop tools:doc` to regenerate `TOOLS.md` at the repo
  root and commit the result. `build:typecheck` runs the generator first
  so the doc rarely lags, but the diff check is human-discipline today —
  a CI gate can land later. The source of truth stays the TS files; the
  doc is a read-only inventory the agent + reviewers consult.

## Known follow-ups

- **Tool-coverage Phases T2-T4** — exposing Ollama / voice / updater
  setup + diagnostics + canonical CRM-OAuth flow as agent tools.
  Plan in [`PLANS.md`](../../PLANS.md) §1. Phase T1 (LinkedIn + CRM
  family) shipped in v0.1.119; T2 next.
- **Skills system (S4-S5)** — in-app editor, zip
  import/export. S1 (loader + schema, v0.1.121), S2 (agent
  integration + enforced allowlist + gates, v0.1.122), S6
  (three starter skills bundled + auto-vendored on first launch,
  v0.1.123) and S3 (Settings → Skills list UI + toggle + body
  viewer, v0.1.124) are landed; see [`SKILLS.md`](../../SKILLS.md)
  and
  [`PLANS.md`](../../PLANS.md) §2.
- **Renderer cache** — `useTabQuery` keeps a 404 response cached
  after a producer finishes, so a freshly persisted profile only
  appears after navigate-away-and-back or app restart. Plausibly
  fixed by the same SSE bridge that solves M4.
- **Workstream A publication accuracy** — numeric extraction
  (Bilanzsumme / Umsatz / Gewinn) is unreliable on tabular layouts
  and unit-scale prefixes (TEUR, Mio). Eval harness + structural
  table extraction + tier-aware routing planned; awaiting ground-
  truth examples.
- Wire the renderer build into `build:typecheck` so CSS parse errors fail
  locally instead of silently in CI (v0.1.69–v0.1.74 cautionary tale).
- OTA scrub-on-download — quarantine attribute removal on the downloaded
  .dmg still requires a manual restart on first launch.
- Tier-aware persist pre-check pattern (F3 wave 2) still TODO in
  website / profile / contact / evaluation / publication producers.
- Matrix M4: full SSE bridge for live cell state changes (today some
  surfaces still poll).
- Harden CI vendor step — don't silently skip on producer build failure.
- Events-as-context for company-evaluation — LinkedIn signals,
  publications, and CRM events feeding the embedding input. Parked
  pending the M4 SSE work above.
