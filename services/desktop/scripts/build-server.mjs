#!/usr/bin/env node
// Baut den headless Server-Einstieg (docs/PLAN_AVA_CLOUD.md §12, R3):
// src/server/main.ts → out/server/main.cjs. Pakete aus node_modules bleiben
// extern (wie beim Electron-Hauptprozess); `electron` und `electron-updater`
// zeigen auf die Attrappen unter src/server/stubs/, weil einige Module unter
// src/main sie noch importieren, der Server sie aber nie ausübt.

import { build } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

// Loesungskarten liest src/main/wissen/index.ts per Vite-Glob (import.meta.glob), den
// esbuild nicht kennt; ohne Ersatz stuerzt der Server beim Start ab (seit v0.1.943,
// bemerkt 2026-11-12 bei ava-i-strategic-it). Das Plugin backt die Karten wie Vite
// als Objekt { "./karten/…md": Inhalt } ins Buendel.
const kartenGlob = {
  name: "karten-glob",
  setup(b) {
    b.onLoad({ filter: /[\\/]wissen[\\/]index\.ts$/ }, (args) => {
      const quelle = readFileSync(args.path, "utf8");
      const ordner = join(dirname(args.path), "karten");
      const dateien = {};
      const lauf = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const voll = join(dir, e.name);
          if (e.isDirectory()) lauf(voll);
          else if (e.name.endsWith(".md") && voll !== join(ordner, "README.md")) {
            dateien["./" + relative(dirname(args.path), voll).split("\\").join("/")] = readFileSync(voll, "utf8");
          }
        }
      };
      lauf(ordner);
      const ersetzt = quelle.replace(/import\.meta\.glob\([\s\S]*?\}\)/, JSON.stringify(dateien));
      if (ersetzt === quelle) throw new Error("karten-glob: import.meta.glob in wissen/index.ts nicht gefunden");
      return { contents: ersetzt, loader: "ts" };
    });
  },
};

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
  plugins: [kartenGlob],
  logLevel: "info",
});
