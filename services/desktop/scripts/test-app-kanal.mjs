#!/usr/bin/env node
// App-Kanal (docs/PLAN_APP_PWA.md): Runner fuer _test-app-kanal.inner.mjs
// mit dem tsx-Loader (TypeScript ohne Build).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-app-kanal.inner.mjs");
const require = createRequire(import.meta.url);
// `--import tsx` resolves the workspace-hoisted tsx CLI shim and
// registers its ESM loader; works whether tsx is hoisted to the
// repo root or installed directly under services/desktop.
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:app-kanal] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--import", "tsx", inner],
  { stdio: "inherit", cwd: root },
);
if ((res.status ?? 1) !== 0) process.exit(res.status ?? 1);

process.exit(res.status ?? 1);
