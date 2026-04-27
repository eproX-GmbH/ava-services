// Renderer-side type for the preload bridge. Imported via tsconfig.web's
// `include` so `window.api` autocompletes in the renderer.

import type { Api } from "./index";

declare global {
  interface Window {
    api: Api;
  }
}

export {};
