import { useEffect, useState } from "react";
import { compareVersions } from "./OllamaVersionSection";

// v0.1.222 — Boot-Hint: prüft kurz nach App-Start, ob eine neuere
// Ollama-Version verfügbar ist als die installierte. Wenn ja, zeigt
// eine dezente, dismissable Bubble unten rechts (parallel zur
// AppUpdate-Bubble in UpdateBanner.tsx).
//
// Sanftheits-Regeln:
//   - Nur prüfen, wenn Ollama-Provider aktiv ist ODER eine Ollama-
//     Instanz tatsächlich läuft (Cloud-Only-Nutzer interessiert das
//     nicht).
//   - Boot-Wartezeit 15 s, damit der App-Start nicht blockiert wird.
//   - Per-Klick dismissable; merken wir uns 7 Tage in localStorage.
//   - Erst surfacen, wenn Differenz != 0. Floor-Edge-Cases (installiert
//     < floor) werden auch behandelt.
//   - Hinweis verschwindet automatisch, sobald das Update erfolgreich
//     installiert wurde (state=ready aus dem Updater).

const DISMISS_KEY = "ollama-update-banner-dismissed-until";
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const BOOT_DELAY_MS = 15_000;

type UpdaterState =
  | "idle"
  | "checking"
  | "downloading"
  | "installing"
  | "ready"
  | "error";

interface UpdaterFrame {
  state: UpdaterState;
  targetVersion?: string;
  percent?: number;
}

export function OllamaUpdateBanner() {
  const [installed, setInstalled] = useState<string | null>(null);
  const [latest, setLatest] = useState<string | null>(null);
  const [updaterBusy, setUpdaterBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => readDismissed());

  // Verzögerter Boot-Check.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(() => {
      if (cancelled) return;
      void window.api.ollama.getInstalledVersion().then((v) => {
        if (!cancelled) setInstalled(v);
      });
      void window.api.ollama.getResolvedTargetVersion().then((v) => {
        if (!cancelled) setLatest(v);
      });
    }, BOOT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

  // Live-Subscription auf Updater-State, damit die Bubble
  // verschwindet sobald jemand das Update gestartet hat (egal woher).
  useEffect(() => {
    void window.api.ollama.getUpdaterState().then((s) => {
      const f = s as UpdaterFrame;
      setUpdaterBusy(
        f.state === "checking" ||
          f.state === "downloading" ||
          f.state === "installing",
      );
    });
    const off = window.api.ollama.onUpdaterState((s) => {
      const f = s as UpdaterFrame;
      setUpdaterBusy(
        f.state === "checking" ||
          f.state === "downloading" ||
          f.state === "installing",
      );
      if (f.state === "ready") {
        // Update fertig → installed-Version neu lesen, Banner sollte
        // sich danach von selbst ausblenden (latest === installed).
        setTimeout(() => {
          void window.api.ollama.getInstalledVersion().then(setInstalled);
        }, 2_000);
      }
    });
    return () => off();
  }, []);

  if (dismissed) return null;
  if (updaterBusy) return null; // andere UI zeigt den Fortschritt
  if (!installed || !latest) return null;
  if (compareVersions(latest, installed) <= 0) return null;

  const onUpdate = async (): Promise<void> => {
    await window.api.ollama.updateBinary();
  };
  const onDismiss = (): void => {
    const until = Date.now() + DISMISS_DURATION_MS;
    localStorage.setItem(DISMISS_KEY, String(until));
    setDismissed(true);
  };

  return (
    <div className="ollama-update-banner" role="status">
      <span
        className="ollama-update-banner__icon"
        aria-hidden="true"
      >
        ⬆
      </span>
      <div className="ollama-update-banner__body">
        <span className="ollama-update-banner__title">
          Ollama-Update verfügbar
        </span>
        <span className="ollama-update-banner__sub">
          {installed} → {latest}
        </span>
      </div>
      <div className="ollama-update-banner__actions">
        <button
          type="button"
          className="ollama-update-banner__cta"
          onClick={() => void onUpdate()}
          title={`Auf ${latest} aktualisieren`}
        >
          Jetzt aktualisieren
        </button>
        <button
          type="button"
          className="ollama-update-banner__dismiss"
          onClick={onDismiss}
          aria-label="Hinweis 7 Tage ausblenden"
          title="7 Tage ausblenden"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function readDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    if (!Number.isFinite(until)) return false;
    if (Date.now() < until) return true;
    // Abgelaufen → räumen wir auf.
    localStorage.removeItem(DISMISS_KEY);
    return false;
  } catch {
    return false;
  }
}
