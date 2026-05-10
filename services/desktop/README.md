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

## Shipped surfaces (v0.1.108)

- **AI-Chat** (`/chat`) — primary interface. Agent has ~30 tools (company
  reads, imports, transactions, watches, alerts, freshness, CRM, profile,
  memory). System prompt + tool definitions under `src/main/agent/`.
- **Companies / company detail** (`/companies`, `/companies/:id`) —
  per-tab tier pills, overview / financials / management / contacts /
  insights / jobs tabs.
- **Transactions matrix** (`/transactions`, `/transactions/:id`) —
  live pipeline grid via SSE bridge, drilldown to producer logs.
- **LinkedIn-Beobachter** (`/linkedin`) — opt-in feed monitoring with
  vision-LLM image analysis. See `src/main/linkedin/`.
- **Whoami / Status** (`/whoami`) — multi-source reachability panel,
  active provider, build info.
- **Settings** (`/settings`) — provider selection (Ollama / OpenAI /
  Anthropic / Google / Mistral), Stripe portal, voice setup, LinkedIn
  controls, freshness preferences.
- **Ingest / First-run wizard** (`/ingest`, `/first-run`) — Excel + CSV
  + single-company + CRM (HubSpot today) imports.
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

## Known follow-ups

- Wire the renderer build into `build:typecheck` so CSS parse errors fail
  locally instead of silently in CI (v0.1.69–v0.1.74 cautionary tale).
- OTA scrub-on-download — quarantine attribute removal on the downloaded
  .dmg still requires a manual restart on first launch.
- Tier-aware persist pre-check pattern (F3 wave 2) still TODO in
  website / profile / contact / evaluation / publication producers.
- Matrix M4: full SSE bridge for live cell state changes (today some
  surfaces still poll).
