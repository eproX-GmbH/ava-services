#!/usr/bin/env node
// Phase A6 — Smoke-Test für das OAuth-Modul (anthropic-oauth.ts).
//
// Was getestet wird:
//   - generatePkce(): Verifier ist 32-Byte base64url, Challenge ist
//     base64url(sha256(verifier)) ohne Padding, State unterscheidet
//     sich zwischen Aufrufen.
//   - buildAuthorizationUrl(): enthält alle Pflicht-Parameter, codiert
//     korrekt, `code=true` ist als Wert vorhanden.
//
// Was NICHT getestet wird:
//   - Der Live-OAuth-Round-Trip gegen claude.ai/console.anthropic.com.
//     Ohne echtes Anthropic-Konto kann der Code nicht gegen ein Token
//     getauscht werden; das deckt erst manuelles Testen ab. Der
//     BrowserWindow-Flow (anthropic-oauth-flow.ts) selbst hängt an
//     Electron-Runtime-APIs und wird hier ebenfalls ausgespart.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-anthropic-oauth.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:anthropic-oauth] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(process.execPath, ["--import", "tsx", inner], {
  stdio: "inherit",
  cwd: root,
});

process.exit(res.status ?? 1);
