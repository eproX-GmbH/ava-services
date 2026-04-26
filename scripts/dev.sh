#!/usr/bin/env bash
# Local dev launcher — boots infra via docker compose, then forks all
# services as host Node processes (D5 model). Designed to mirror what the
# Electron supervisor will do in production (Step 6).
#
# Usage: bash scripts/dev.sh [hybrid]
#   default  — full local stack (infra/docker-compose.dev.yml)
#   hybrid   — RabbitMQ local, Postgres+Elastic from cloud (.env.hybrid)

set -euo pipefail

MODE="${1:-dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$MODE" in
  dev)
    COMPOSE_FILE="infra/docker-compose.dev.yml"
    ENV_FILE=".env.dev"
    ;;
  hybrid)
    COMPOSE_FILE="infra/docker-compose.hybrid.yml"
    ENV_FILE=".env.hybrid"
    ;;
  *)
    echo "Unknown mode: $MODE (expected: dev | hybrid)" >&2
    exit 1
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy from $ENV_FILE.example and fill in secrets." >&2
  exit 1
fi

echo "==> Starting infra ($COMPOSE_FILE)"
docker compose -f "$COMPOSE_FILE" up -d

# Service list with per-service port offsets. Each service reads PORT from
# its shell env, not from .env.sample, so overlapping defaults don't matter.
SERVICES=(
  "company-profile:3010"
  "company-contact:3011"
  "company-publication:3012"
  "company-evaluation:3013"
  "website:3014"
  "structured-content:3015"
  "master-data:3016"
)

pids=()
trap 'echo; echo "==> Stopping services"; kill "${pids[@]}" 2>/dev/null || true; wait 2>/dev/null || true' INT TERM EXIT

for entry in "${SERVICES[@]}"; do
  svc="${entry%%:*}"
  port="${entry##*:}"
  if [[ ! -d "$svc" ]]; then
    echo "   skip $svc (not checked out)"
    continue
  fi
  echo "==> Starting $svc on :$port"
  (
    cd "$svc"
    set -a
    # shellcheck disable=SC1090
    source "$ROOT_DIR/$ENV_FILE"
    PORT="$port" npm run dev
  ) &
  pids+=("$!")
done

wait
