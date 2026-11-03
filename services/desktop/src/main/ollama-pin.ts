// Die EINE Ollama-Version, die AVA mitbringt und betreibt (Joyce 2026-11-03):
// kein Nachladen der jeweils neuesten Upstream-Version mehr, weil ungetestete
// Ollama-Releases Breaking Changes in AVA ausloesen koennen. Der Pin wird
// bewusst mit einem AVA-Release angehoben, nachdem die Version geprueft ist.
//
// Gelesen von:
//   - scripts/fetch-ollama.mjs (Bundle beim Build, Pruefsumme aus sha256sum.txt)
//   - main/ollama-binary-updater.ts (stiller Abgleich beim Start)
//   - main/ollama-supervisor.ts (nur die gepinnte verwaltete Version zaehlt)
//
// Dieses Modul darf keine Electron-Importe haben.
export const OLLAMA_PINNED_VERSION = "v0.40.5";
