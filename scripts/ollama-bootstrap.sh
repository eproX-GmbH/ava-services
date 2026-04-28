#!/usr/bin/env bash
# Pull the default LLM + embedder into the dev Ollama container so the
# producers don't 404 on first call. Idempotent — `ollama pull` is a no-op
# when the model is already present (ollama compares manifest digests).
#
# Called from scripts/dev.sh after `docker compose up -d ollama`, and safe
# to invoke standalone if you want to refresh manually.
#
# Models match the defaults in packages/ai-provider/src/index.ts so flipping
# LLM_PROVIDER=ollama in .env.dev "just works" without further config.
set -euo pipefail

LLM_MODEL="${OLLAMA_LLM_MODEL:-gemma3:4b}"
EMBED_MODEL="${OLLAMA_EMBED_MODEL:-embeddinggemma}"
OLLAMA_URL="${OLLAMA_URL:-http://localhost:11434}"

# Wait for the daemon to actually be ready (compose `healthy` is async).
echo "==> Waiting for ollama at $OLLAMA_URL"
for i in {1..30}; do
  if curl -fsS --max-time 2 "$OLLAMA_URL/api/version" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo "!! ollama did not come up in 30s" >&2
    exit 1
  fi
done

pull_if_missing() {
  local model="$1"
  if curl -fsS "$OLLAMA_URL/api/tags" | grep -q "\"$model\""; then
    echo "    $model already present"
    return 0
  fi
  echo "==> Pulling $model (this may take a while on first run)"
  # Stream so the dev sees progress; --insecure-registry is unnecessary for
  # the public registry. We use the docker exec path because the JSON
  # streaming API is awkward to render in a shell — the CLI inside the
  # container already shows a tidy progress bar.
  docker exec -i ava-ollama ollama pull "$model"
}

pull_if_missing "$LLM_MODEL"
pull_if_missing "$EMBED_MODEL"

echo "==> Ollama ready: $LLM_MODEL + $EMBED_MODEL"
