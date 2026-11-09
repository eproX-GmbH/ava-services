import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { createRequire } from "node:module";

// 2026-11-06 (v0.1.939): Das MCP-SDK samt Pruefbibliothek ajv wird in das
// Hauptbuendel gebacken statt zur Laufzeit aus node_modules geladen. Grund:
// electron-builder packte unter node-linker=hoisted die gehoistete ajv 6
// (ohne uri-js) statt der vom SDK gebrauchten ajv 8 — Startabsturz "Cannot
// find module 'uri-js'" in v0.1.935-938. Gebuendelt entscheidet Rollup zur
// Bauzeit ueber die Fassung, nicht der Paketierer.
const BUENDELN = /^(@modelcontextprotocol\/sdk|ajv|ajv-formats)(\/|$)/;
const buendelRequire = createRequire(import.meta.url);
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

// electron-vite handles the three-process layout (main / preload / renderer)
// with a single config. Each section gets its own Vite build pipeline.
//
// Why electron-vite (vs raw Vite + electron-forge):
//   - Free HMR for both the renderer and the main process, so a code change
//     in `src/main/*.ts` restarts Electron without losing the renderer state.
//   - Sensible defaults for the preload bridge (CommonJS output, externalises
//     `electron`).
//   - Single config file keeps the surface area small while we're still
//     iterating on the desktop architecture.
export default defineConfig({
  main: {
    // externalizeDepsPlugin keeps everything in package.json#dependencies
    // out of the bundle — they get plain `require()`s in the emitted main
    // process bundle, resolved at runtime by Node from node_modules.
    //
    // Without this, electron-vite/Rollup tries to statically analyze the
    // CJS dist of every workspace dep (e.g. @ava/ai-provider). Rollup's
    // commonjs plugin can't see through TypeScript's emit pattern for
    // re-exported imported bindings (`Object.defineProperty(exports, …,
    // { get })` or member-access assignments), so the build fails with
    // "createLLM is not exported by …/dist/index.js" even though the
    // export is plainly there at runtime.
    //
    // Bundling Node-side deps also has zero upside here: Electron ships
    // its own Node, the `node_modules` directory is right there next to
    // the bundle in production, and externalizing keeps native modules
    // (better-sqlite3, onnxruntime-node, …) working without rollup-side
    // shims.
    // 2026-11-06 (v0.1.939): Das MCP-SDK samt seiner Pruefbibliothek wird in
    // das Hauptbuendel gebacken statt zur Laufzeit aus node_modules geladen.
    // Grund: electron-builder packte unter node-linker=hoisted die
    // gehoistete ajv 6 (ohne uri-js) statt der vom SDK gebrauchten ajv 8 —
    // Startabsturz "Cannot find module 'uri-js'" in v0.1.935-938. Gebuendelt
    // entscheidet Rollup zur Bauzeit ueber die Fassung, nicht der Paketierer.
    plugins: [
      // Unterpfade wie "ajv/dist/runtime/uri" (aus ajv-generiertem Code) auf
      // Dateipfade aufloesen, BEVOR externalizeDepsPlugin sie als extern
      // markieren kann — so landen sie mit im Buendel.
      {
        name: "ava-sdk-unterpfade-buendeln",
        enforce: "pre" as const,
        resolveId(id: string) {
          if (!BUENDELN.test(id)) return null;
          try {
            return { id: buendelRequire.resolve(id), external: false };
          } catch {
            return null;
          }
        },
      },
      externalizeDepsPlugin({ exclude: ["@modelcontextprotocol/sdk", "ajv", "ajv-formats"] }),
    ],
    // Bake the GitHub PAT into the main bundle at build time so
    // electron-updater can fetch the (private) repo's release feed.
    // Source: SUBMODULES_PAT secret in CI (or the GH_TOKEN env locally).
    // The token is read-only on the repo's contents and is acceptable
    // to leak in a closed-pilot context — anyone with the .dmg already
    // has access to the published .dmg files which is what the token
    // grants. Promote to runtime gateway-mediated token in 8.v1.6.
    define: {
          },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // Tailwind v4 uses a CSS-first config — no `tailwind.config.js`. The
    // Vite plugin scans the renderer's source for utility classes at
    // build time and emits exactly the CSS that's used. Token layer and
    // any global rules live in `src/renderer/src/styles.css`.
    plugins: [
      // Generative UI (docs/PLAN_GENERATIVE_UI.md): json-render braucht die
      // zod-4-Schnittstelle; der Desktop nutzt zod 3.25, das sie unter
      // "zod/v4" mitbringt. Nur Importe AUS json-render umleiten, sonst
      // wechselten KI-Pakete im Hauptprozess mit (Lockdatei-Versuch 2026-11-09).
      {
        name: "ava-json-render-zod4",
        enforce: "pre" as const,
        async resolveId(id: string, importer?: string) {
          if (!importer || !importer.includes("@json-render")) return null;
          if (id !== "zod" && !(id.startsWith("zod/") && !id.startsWith("zod/v4"))) return null;
          return this.resolve(id === "zod" ? "zod/v4" : `zod/v4/${id.slice(4)}`, importer, { skipSelf: true });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
