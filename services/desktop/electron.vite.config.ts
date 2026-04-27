import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
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
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()],
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
