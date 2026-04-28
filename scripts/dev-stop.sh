#!/usr/bin/env bash
# Local dev cleanup — frees the ports `scripts/dev.sh` forks services on.
#
# Why this exists: tsnd/tsx respawn children which sometimes outlive their
# parent shell after Ctrl-C, leaving zombies bound to the dev ports. The
# next `pnpm dev:hostlocal` then dies with EADDRINUSE. This script kills
# whatever is listening on each known dev port, in one go.
#
# Usage:
#   bash scripts/dev-stop.sh           # kill listeners on all dev ports
#   bash scripts/dev-stop.sh --check   # just print what's listening, don't kill
#
# Note: this does NOT touch docker compose infra (Postgres/RabbitMQ/etc).
# Stop those with `docker compose -f infra/docker-compose.dev-hostlocal.yml down`.

set -euo pipefail

# Service ports (keep aligned with scripts/dev.sh)
PORTS=(
  8081   # services/db-gateway
  3010   # company-profile
  3011   # company-contact
  3012   # company-publication
  3013   # company-evaluation
  3014   # website
  3015   # structured-content
  3016   # master-data
)

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
fi

any_found=0
for port in "${PORTS[@]}"; do
  pids=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [[ -z "$pids" ]]; then
    echo ":$port free"
    continue
  fi
  any_found=1
  if [[ "$CHECK_ONLY" -eq 1 ]]; then
    echo ":$port held by PID(s) $pids"
  else
    echo "killing $pids on :$port"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

if [[ "$CHECK_ONLY" -eq 0 && "$any_found" -eq 1 ]]; then
  # brief settle so the next `pnpm dev` doesn't race the kernel releasing
  # the socket
  sleep 1
  echo "==> dev ports cleared"
fi
