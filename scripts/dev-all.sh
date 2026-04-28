#!/usr/bin/env bash
# Boot the full stack: infra + 7 producers + db-gateway (via dev.sh) and
# then the Electron desktop app, all from one terminal.
#
# Why a wrapper instead of `concurrently`: dev.sh already manages 8 child
# processes with its own SIGINT handler; layering electron-vite on top of
# `concurrently` would interleave logs and make it harder to tell which
# service printed what. This script runs dev.sh in the background, waits
# until the gateway port is reachable, then hands the foreground to
# electron-vite. Hitting Ctrl-C tears down both halves.
#
# Usage:  bash scripts/dev-all.sh [dev|hostlocal|hybrid]

set -euo pipefail

MODE="${1:-hostlocal}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Pick env file the same way dev.sh does so the desktop's GATEWAY_URL
# matches the gateway's PORT.
case "$MODE" in
  dev)        ENV_FILE=".env.dev" ;;
  hostlocal)  ENV_FILE=".env.dev" ;;
  hybrid)     ENV_FILE=".env.hybrid" ;;
  *) echo "Unknown mode: $MODE" >&2; exit 1 ;;
esac
GATEWAY_PORT="$(grep -E '^PORT=' "$ENV_FILE" | head -1 | cut -d= -f2)"
GATEWAY_PORT="${GATEWAY_PORT:-8081}"

echo "==> Starting backend stack (mode=$MODE, gateway :$GATEWAY_PORT)"
bash scripts/dev.sh "$MODE" &
BACKEND_PID=$!

cleanup() {
  echo
  echo "==> Tearing down backend stack (pid $BACKEND_PID)"
  kill -INT "$BACKEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

echo "==> Waiting for gateway on :$GATEWAY_PORT (up to 90s)…"
for i in {1..90}; do
  if lsof -ti ":$GATEWAY_PORT" >/dev/null 2>&1; then
    echo "    gateway is up"
    break
  fi
  sleep 1
done

if ! lsof -ti ":$GATEWAY_PORT" >/dev/null 2>&1; then
  echo "!! gateway never bound :$GATEWAY_PORT — check dev.sh output" >&2
  exit 1
fi

echo "==> Starting Electron desktop (services/desktop, dev:real)"
GATEWAY_URL="http://localhost:$GATEWAY_PORT" \
AUTH_ISSUER="http://auth.localhost/realms/ava" \
AUTH_CLIENT_ID="ava-desktop" \
  pnpm --dir services/desktop dev
