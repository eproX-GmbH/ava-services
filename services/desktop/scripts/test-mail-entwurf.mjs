#!/usr/bin/env node
// Mail-Entwürfe (docs/PLAN_MAIL_ENTWURF.md): Runner fuer _test-mail-entwurf.inner.mjs mit tsx.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const res = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-mail-entwurf.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(res.status ?? 1);
