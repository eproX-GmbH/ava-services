import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ["--import", "tsx", join(here, "_test-telegram-sprachantwort.inner.mjs")], { stdio: "inherit", cwd: join(here, "..") });
process.exit(r.status ?? 1);
