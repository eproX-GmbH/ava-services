#!/usr/bin/env node
// v0.1.145 — Smoke-Test für den geteilten Anthropic-OAuth-Fetch-Wrapper
// (packages/ai-provider/src/anthropic-oauth-fetch.ts).
//
// Was getestet wird:
//   - Authorization-Header wird auf Bearer <token> gesetzt.
//   - anthropic-beta: oauth-2025-04-20 wird gesetzt.
//   - x-api-key wird entfernt.
//   - Auf POSTs nach /v1/messages wird der Claude-Code-Marker dem
//     ersten system-Eintrag vorangestellt (String- und Array-Form).
//   - Idempotent: ist der Marker schon da, wird er nicht doppelt
//     eingefügt.
//   - Auf anderen Pfaden bleibt der Body unverändert (nur Header).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-anthropic-oauth-fetch.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:anthropic-oauth-fetch] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--import", "tsx", inner], {
  stdio: "inherit",
  cwd: root,
});

process.exit(res.status ?? 1);
