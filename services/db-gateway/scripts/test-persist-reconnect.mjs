// Braucht einen lokalen RabbitMQ (Standard: guest@localhost:5672).
// Kompiliert das Gateway nach node_modules/.cache/gw-test und testet den
// Persist-Bus dort, mit eigener Test-Exchange.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "node_modules/.cache/gw-test/dist");
const tsc = spawnSync("npx", ["tsc", "-p", "tsconfig.json", "--outDir", out], { stdio: "inherit", cwd: root });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
const r = spawnSync(process.execPath, [join(root, "scripts/_test-persist-reconnect.inner.mjs")], {
  stdio: "inherit",
  cwd: root,
  env: {
    ...process.env,
    PERSIST_BUS_JS: join(out, "lib/persist-bus.js"),
    EVENT_BUS_URL: process.env.TEST_EVENT_BUS_URL ?? "amqp://guest:guest@localhost:5672",
    EVENT_BUS_EXCHANGE: "ava-test-persist",
  },
});
process.exit(r.status ?? 1);
