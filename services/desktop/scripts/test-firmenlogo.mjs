#!/usr/bin/env node
// Firmenlogos im Desktop: Zwischenspeicher fuer ava-logo:// (src/main/logo-cache.ts) und die
// Auswahl fuer die quadratische Flaeche (src/renderer/src/components/FirmenLogo.tsx).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-firmenlogo.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);
