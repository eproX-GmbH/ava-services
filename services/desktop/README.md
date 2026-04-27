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

## Smoke tests in the v0 scaffold

Two routes are wired so you can confirm the cloud → gateway → desktop path:

1. **/whoami** — calls `GET /v1/whoami`. Checks auth + gateway URL.
2. **/transactions** — calls `GET /v1/transactions`. Click a row to open
   `/transactions/:id/stream`, which subscribes to the SSE bridge
   (`GET /v1/transactions/:id/stream`) and renders events as they arrive.
   This is the end-to-end test for §6.

## Open follow-ups

- **Auth.** Today the renderer sends no bearer token — the gateway must be
  in a dev mode that accepts unauthenticated requests, or behind a Keycloak
  proxy that injects the token. Real OIDC PKCE flow lands in the main
  process next, then `appConfig.accessToken` becomes non-null.
- **SSE auth.** `EventSource` doesn't support custom headers, so the
  current SSE wrapper passes `?access_token=…` on the URL. Once the auth
  story lands we should switch to `@microsoft/fetch-event-source` for
  proper `Authorization` header support.
- **Workflow screens.** Only W2/W4 are wired. W1 (excel import), W6–W13
  (company drilldowns), W15/W19/W22 (evaluation reads), W14/W16–W21
  (evaluation writes), W23–W25 (corrections) still need UI.
- **Packaging.** `pnpm package:mac|win|linux` builds installers via
  electron-builder; not exercised in CI yet.
