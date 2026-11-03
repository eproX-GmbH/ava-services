import { useEffect, useState } from "react";
import { XIcon } from "./icons";

// 2026-11-03 — Die lokale KI wird still auf die von AVA vorgesehene Version
// abgeglichen (kein Klick mehr). Diese Bubble erscheint NUR, wenn der
// Abgleich fehlgeschlagen ist, damit der Nutzer weiss, warum die lokale KI
// eventuell nicht die erwartete Version hat.

interface UpdaterFrame {
  state: "idle" | "checking" | "downloading" | "installing" | "ready" | "error";
  message?: string;
}

export function OllamaUpdateBanner() {
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    const uebernehmen = (s: unknown): void => {
      const f = s as UpdaterFrame;
      setFehler(f.state === "error" ? (f.message ?? "Unbekannter Fehler") : null);
    };
    void window.api.ollama.getUpdaterState().then(uebernehmen);
    return window.api.ollama.onUpdaterState(uebernehmen);
  }, []);

  if (!fehler) return null;

  return (
    <div className="ollama-update-banner" role="status">
      <div className="ollama-update-banner__body">
        <span className="ollama-update-banner__title">Lokale KI konnte nicht aktualisiert werden</span>
        <span className="ollama-update-banner__sub">{fehler}</span>
      </div>
      <div className="ollama-update-banner__actions">
        <button
          type="button"
          className="ollama-update-banner__cta"
          onClick={() => void window.api.ollama.updateBinary()}
        >
          Erneut versuchen
        </button>
        <button
          type="button"
          className="ollama-update-banner__dismiss"
          onClick={() => setFehler(null)}
          aria-label="Hinweis schließen"
          title="Schließen"
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  );
}
