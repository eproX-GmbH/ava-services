#!/usr/bin/env bash
#
# v0.1.193 — vendor-drift CI guard.
#
# Background:
#   The producer submodules (company-profile, company-contact,
#   company-evaluation, website) each ship a `vendor/ai-provider/`
#   copy of the workspace `packages/ai-provider/` so the producer
#   bundle is self-contained inside the packaged Electron app. The
#   downside is the vendored copies can drift behind the workspace
#   source — and they did, twice:
#     - v0.1.191 fixed a stale vendor copy in company-contact +
#       company-profile that lacked the v0.1.145 ANTHROPIC_AUTH_TOKEN
#       OAuth fallback. Two producers crashed at boot for every user
#       on the claude.ai-login flow.
#     - The same class of bug had hit company-evaluation in v0.1.183.
#
# This script asserts the vendored dist/index.js in every producer
# submodule matches the workspace's packages/ai-provider/dist/index.js
# byte-for-byte. CI runs it as a step in the desktop-release workflow.
# Exits 0 on match, 1 on drift (with a diff per drifted producer).
#
# Why dist/index.js specifically: it's the runtime entry that the
# producer actually loads. If src/ is in sync but dist/ wasn't rebuilt
# the bug still ships, so we anchor on the compiled artifact.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL="$REPO_ROOT/packages/ai-provider/dist/index.js"

if [[ ! -f "$CANONICAL" ]]; then
  echo "vendor-drift: canonical $CANONICAL missing — has packages/ai-provider been built?" >&2
  exit 1
fi

CANONICAL_HASH="$(shasum -a 256 "$CANONICAL" | awk '{print $1}')"
echo "vendor-drift: canonical hash $CANONICAL_HASH (packages/ai-provider/dist/index.js)"

PRODUCERS=(
  company-profile
  company-contact
  company-evaluation
  website
)

DRIFTED=()
for p in "${PRODUCERS[@]}"; do
  candidate="$REPO_ROOT/$p/vendor/ai-provider/dist/index.js"
  if [[ ! -f "$candidate" ]]; then
    # No vendored copy yet — not drift, just not vendored. Skip.
    echo "vendor-drift: $p — no vendored ai-provider copy (skipped)"
    continue
  fi
  candidate_hash="$(shasum -a 256 "$candidate" | awk '{print $1}')"
  if [[ "$candidate_hash" == "$CANONICAL_HASH" ]]; then
    echo "vendor-drift: $p — OK ($candidate_hash)"
  else
    echo "vendor-drift: $p — DRIFT ($candidate_hash)" >&2
    DRIFTED+=("$p")
  fi
done

if [[ ${#DRIFTED[@]} -gt 0 ]]; then
  echo "" >&2
  echo "vendor-drift: ${#DRIFTED[@]} producer(s) out of sync with packages/ai-provider:" >&2
  for p in "${DRIFTED[@]}"; do
    echo "  - $p" >&2
    echo "    diff -u packages/ai-provider/dist/index.js $p/vendor/ai-provider/dist/index.js" >&2
    diff -u "$CANONICAL" "$REPO_ROOT/$p/vendor/ai-provider/dist/index.js" | head -40 >&2 || true
    echo "" >&2
  done
  echo "Fix: rsync -a --delete packages/ai-provider/dist/ <producer>/vendor/ai-provider/dist/ \\" >&2
  echo "  &&  rsync -a --delete packages/ai-provider/src/  <producer>/vendor/ai-provider/src/" >&2
  echo "Then commit the submodule update + bump the parent." >&2
  exit 1
fi

echo ""
echo "vendor-drift: all producers in sync ✓"
