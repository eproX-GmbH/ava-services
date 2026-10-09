#!/usr/bin/env node
// Baut den headless Server-Einstieg (docs/PLAN_AVA_CLOUD.md §12, R3):
// src/server/main.ts → out/server/main.cjs. Pakete aus node_modules bleiben
// extern (wie beim Electron-Hauptprozess); `electron` und `electron-updater`
// zeigen auf die Attrappen unter src/server/stubs/, weil einige Module unter
// src/main sie noch importieren, der Server sie aber nie ausübt.

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

await build({
  entryPoints: [join(root, "src/server/main.ts")],
  outfile: join(root, "out/server/main.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: true,
  packages: "external",
  alias: {
    electron: join(root, "src/server/stubs/electron.ts"),
    "electron-updater": join(root, "src/server/stubs/electron-updater.ts"),
  },
  define: {
    __AVA_VERSION__: JSON.stringify(pkg.version),
  },
  logLevel: "info",
});
