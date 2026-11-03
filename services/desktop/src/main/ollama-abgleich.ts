// 2026-11-03 — Stiller Abgleich der Ollama-Binary auf die gepinnte Version.
// Beim Start (bootstrap) und auf Wunsch aus den Einstellungen: fehlt die
// gepinnte Version im verwalteten Verzeichnis, wird sie geholt (Pruefsumme),
// danach Supervisor stop()+start(), damit resolveBinaryPath() neu aufloest.
// Kein Electron-Import, damit core/bootstrap es aufrufen darf.
import type { OllamaBinaryUpdater, OllamaUpdaterState } from "./ollama-binary-updater";

interface SupervisorLike {
  stop(): Promise<void>;
  start(): Promise<void>;
  getInstalledVersion(): Promise<string | null>;
}

let laeuft: Promise<OllamaUpdaterState> | null = null;

export function ollamaBinaryAbgleichen(
  ollama: SupervisorLike,
  updater: OllamaBinaryUpdater,
  opts: { erzwingen?: boolean } = {},
): Promise<OllamaUpdaterState> {
  if (laeuft) return laeuft;
  laeuft = (async () => {
    try {
      const pin = await updater.peekResolvedTargetVersion();
      const laufend = await ollama.getInstalledVersion();
      if (!opts.erzwingen && laufend && pin && laufend === pin) {
        return updater.getState();
      }
      const neu = opts.erzwingen ? (await updater.update(), updater.getState().state === "ready") : await updater.abgleichen();
      if (!neu && !opts.erzwingen) return updater.getState();
      if (updater.getState().state !== "ready") return updater.getState();
      // Supervisor sauber durchstarten, damit der neue Binary-Pfad greift.
      try {
        await ollama.stop();
      } catch (err) {
        console.warn("[ollama-updater] stop() failed during binary swap:", err instanceof Error ? err.message : err);
      }
      try {
        await ollama.start();
      } catch (err) {
        console.warn("[ollama-updater] start() after swap failed:", err instanceof Error ? err.message : err);
      }
      console.info(`[ollama-updater] Binary auf ${pin} abgeglichen (vorher ${laufend ?? "unbekannt"})`);
      return updater.getState();
    } finally {
      laeuft = null;
    }
  })();
  return laeuft;
}
