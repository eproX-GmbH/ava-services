#!/usr/bin/env bash
#
# v0.1.193 — vendor-drift CI guard (v0.1.198: Windows-portable).
#
# Asserts the vendored `@ava/ai-provider/dist/index.js` in every
# producer submodule matches the workspace canonical at
# `packages/ai-provider/dist/index.js` byte-for-byte. Fails CI on
# drift with a per-producer diff in the log.
#
# Why this exists:
#   v0.1.183: company-evaluation shipped with stale ai-provider
#     lacking the null-safe getEmbedder, crashed at boot for
#     Anthropic-only users.
#   v0.1.191: company-contact + company-profile shipped with
#     pre-v0.1.145 vendor lacking the ANTHROPIC_AUTH_TOKEN OAuth
#     fallback, crashed at boot for claude.ai-login users.
#
# This step runs in all three build jobs (arm64, x64, Windows)
# so the same class of bug can't slip through any single arch.
#
# Cross-platform notes:
#   - Uses `cmp -s` for byte-comparison instead of `shasum`/
#     `sha256sum`. `cmp` is in coreutils and ships with both
#     macOS and Git-Bash-for-Windows out of the box; the earlier
#     `shasum`-based check failed with exit 127 on Windows
#     runners where `shasum` is not on PATH.
#   - Avoids `-name latest-mac.yml`-style finds — bash basics
#     only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CANONICAL="$REPO_ROOT/packages/ai-provider/dist/index.js"

if [[ ! -f "$CANONICAL" ]]; then
  echo "vendor-drift: canonical $CANONICAL missing — has packages/ai-provider been built?" >&2
  exit 1
fi

echo "vendor-drift: canonical = packages/ai-provider/dist/index.js"

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
    # No vendored copy in this submodule — either not vendored or
    # the submodule wasn't checked out (CI without SUBMODULES_PAT
    # silently skips submodule init). Not drift, just nothing to
    # compare.
    echo "vendor-drift: $p — no vendored ai-provider copy (skipped)"
    continue
  fi
  if cmp -s "$CANONICAL" "$candidate"; then
    echo "vendor-drift: $p — OK"
  else
    echo "vendor-drift: $p — DRIFT" >&2
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
  echo "Fix:" >&2
  echo "  rsync -a --delete packages/ai-provider/dist/ <producer>/vendor/ai-provider/dist/ \\" >&2
  echo "    && rsync -a --delete packages/ai-provider/src/  <producer>/vendor/ai-provider/src/" >&2
  echo "Then commit the submodule update + bump the parent." >&2
  exit 1
fi

echo ""
echo "vendor-drift: all producers in sync ✓"
