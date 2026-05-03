import { defineConfig, externalizeDepsPlugin } from "electron-vite";
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
    plugins: [externalizeDepsPlugin()],
    // Bake the GitHub PAT into the main bundle at build time so
    // electron-updater can fetch the (private) repo's release feed.
    // Source: SUBMODULES_PAT secret in CI (or the GH_TOKEN env locally).
    // The token is read-only on the repo's contents and is acceptable
    // to leak in a closed-pilot context — anyone with the .dmg already
    // has access to the published .dmg files which is what the token
    // grants. Promote to runtime gateway-mediated token in 8.v1.6.
    define: {
      "process.env.AVA_RELEASE_TOKEN": JSON.stringify(
        process.env.AVA_RELEASE_TOKEN ?? process.env.GH_TOKEN ?? "",
      ),
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
    plugins: [react(), tailwindcss()],
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
