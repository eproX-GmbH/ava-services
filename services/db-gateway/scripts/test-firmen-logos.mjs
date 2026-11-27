#!/usr/bin/env node
// Firmenlogos im Gateway (src/lib/firmen-logos.ts, src/lib/objektspeicher.ts; docs/PLAN_FIRMENLOGOS.md LG2).
// Gegen einen nachgebauten Objektspeicher und eine nachgebaute Datenbank; keine echten Dienste noetig.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-firmen-logos.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(r.status ?? 1);
