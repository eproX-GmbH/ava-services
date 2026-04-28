#!/usr/bin/env bash
# Local dev launcher — boots infra via docker compose, then forks all
# services as host Node processes (D5 model). Designed to mirror what the
# Electron supervisor will do in production (Step 6).
#
# Usage: bash scripts/dev.sh [dev|hostlocal|hybrid]
#   dev        — full local stack in Docker (infra/docker-compose.dev.yml)
#   hostlocal  — no Docker; assumes Postgres/RabbitMQ/Keycloak already running
#                on the host (uses .env.dev + docker-compose.dev-hostlocal.yml)
#   hybrid     — RabbitMQ local, Postgres+Elastic from cloud (.env.hybrid)

set -euo pipefail

MODE="${1:-dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$MODE" in
  dev)
    COMPOSE_FILE="infra/docker-compose.dev.yml"
    ENV_FILE=".env.dev"
    ;;
  hostlocal)
    COMPOSE_FILE="infra/docker-compose.dev-hostlocal.yml"
    ENV_FILE=".env.dev"
    ;;
  hybrid)
    COMPOSE_FILE="infra/docker-compose.hybrid.yml"
    ENV_FILE=".env.hybrid"
    ;;
  *)
    echo "Unknown mode: $MODE (expected: dev | hostlocal | hybrid)" >&2
    exit 1
    ;;
esac

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy from $ENV_FILE.example and fill in secrets." >&2
  exit 1
fi

echo "==> Starting infra ($COMPOSE_FILE)"
# Newer docker compose versions exit non-zero on an empty services map
# ("no service selected"), which is exactly the case for hostlocal mode.
# Tolerate that — `set -e` would otherwise abort the whole launcher.
docker compose -f "$COMPOSE_FILE" up -d || echo "    (compose returned non-zero — ok if hostlocal/no services)"

# Ollama (local LLM, see docs/OLLAMA_PLAN.md). The hostlocal/dev compose
# files declare an `ollama` service; pull the default models so producers
# can switch to LLM_PROVIDER=ollama without hitting 404s. Don't fail the
# launcher if ollama isn't running (devs may be offline / on the OpenAI
# path); just warn and continue.
if docker ps --format '{{.Names}}' | grep -q '^ava-ollama$'; then
  bash "$ROOT_DIR/scripts/ollama-bootstrap.sh" || \
    echo "!! ollama bootstrap failed — producers using LLM_PROVIDER=ollama will 404. See docs/OLLAMA_PLAN.md" >&2
else
  echo "    (ollama container not running — skipping model pull. LLM_PROVIDER=openai will still work)"
fi

# Quick reachability checks for host-managed infra. In `dev` mode the
# compose stack provides everything; in `hostlocal`/`hybrid` we expect the
# user to have Postgres/RabbitMQ/Keycloak/Elasticsearch running already and
# we'd rather fail fast with a clear hint than watch 7 producers crash-loop
# trying to connect.
if [[ "$MODE" != "dev" ]]; then
  ES_URL="$(grep -E '^ELASTIC_SEARCH_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  if [[ -n "$ES_URL" ]]; then
    if ! curl -fsS --max-time 2 "$ES_URL" >/dev/null 2>&1; then
      echo "!! Elasticsearch not reachable at $ES_URL — start it before continuing." >&2
      echo "   (master-data fuzzy lookup + company-evaluation vector index depend on it)" >&2
      exit 1
    fi
    echo "    elasticsearch ok ($ES_URL)"
  fi
fi

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
  "services/db-gateway:8081"
)

# The Electron desktop app (services/desktop) is not started here on
# purpose — `electron-vite dev` opens a window and is best driven from a
# separate terminal:
#
#   cd services/desktop && GATEWAY_URL=http://localhost:8080 pnpm dev
#
# Mixing it into this fanout would mean closing the window kills the whole
# stack, which makes iteration awkward.

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
  # Short tag for log prefixing — strip "services/" so db-gateway shows as
  # `[db-gateway]` instead of `[services/db-gateway]`. Pad to a fixed width
  # so columns line up across services.
  tag="${svc##*/}"
  printf -v padded_tag '%-19s' "$tag"
  (
    cd "$svc"
    set -a
    # shellcheck disable=SC1090
    source "$ROOT_DIR/$ENV_FILE"
    # Pick start script: legacy producers use 'start', new services use 'dev'.
    # `npm run` (no -s) prints the script names indented; -s silences everything
    # in some npm versions, so don't use it for detection.
    # Pipe both streams through sed to prefix each line with the service tag.
    # `sed -l` (BSD) / `sed --unbuffered` (GNU) keeps lines flowing in real
    # time instead of buffering until the child exits.
    if [[ "$(uname)" == "Darwin" ]]; then SED_UNBUF="-l"; else SED_UNBUF="--unbuffered"; fi
    if npm run 2>/dev/null | grep -qE "^  dev$"; then
      PORT="$port" npm run dev 2>&1 | sed $SED_UNBUF "s|^|[$padded_tag] |"
    else
      PORT="$port" npm start 2>&1 | sed $SED_UNBUF "s|^|[$padded_tag] |"
    fi
  ) &
  pids+=("$!")
done

wait
