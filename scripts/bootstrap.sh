#!/usr/bin/env bash
# One-shot developer bootstrap. Run once after cloning the meta-repo.
#
# Steps:
#   1. Init / update git submodules (services per D2 layout)
#   2. pnpm install at the workspace root
#   3. Build shared packages (ai-provider, queue-client, db-client, events)
#   4. Copy .env.dev.example → .env.dev if missing

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> git submodule update --init --recursive"
git submodule update --init --recursive || echo "   (no submodules configured yet — skipping)"

echo "==> pnpm install"
pnpm install

echo "==> Building shared packages"
for pkg in events ai-provider queue-client db-client; do
  if [[ -f "packages/$pkg/package.json" ]]; then
    echo "   build packages/$pkg"
    (cd "packages/$pkg" && pnpm run build) || echo "   (packages/$pkg build failed — continuing)"
  fi
done

if [[ ! -f ".env.dev" && -f ".env.dev.example" ]]; then
  cp .env.dev.example .env.dev
  echo "==> Created .env.dev from template — fill in secrets before running scripts/dev.sh"
fi

echo "==> Bootstrap complete."
