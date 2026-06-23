import { useEffect, useState } from "react";

// v0.1.395 — Globaler, rein lokaler Play/Pause-Schalter für die Verarbeitung.
// Pausiert die lokalen Producer (keine neue Verarbeitung mehr) und sperrt die
// Import-/Retry-Tools des KI-Agenten. Zustand kommt aus dem Main-Process und
// wird per `processing-control:changed` live aktualisiert. Wird oben in
// „Meine Firmen" und im Vorgangsdetail eingebunden.
export function ProcessingToggle() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void window.api.processing.getStatus().then((s) => {
      if (alive) setPaused(s.paused);
    });
    const off = window.api.processing.onChanged((p) => setPaused(p.paused));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const toggle = async () => {
    if (paused === null || busy) return;
    setBusy(true);
    try {
      const res = await window.api.processing.setPaused(!paused);
      setPaused(res.paused);
    } finally {
      setBusy(false);
    }
  };

  if (paused === null) return null;

  return (
    <button
      type="button"
      className={`proc-toggle ${paused ? "proc-toggle--paused" : "proc-toggle--running"}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={paused}
      title={
        paused
          ? "Verarbeitung ist pausiert — klicken zum Fortsetzen"
          : "Verarbeitung läuft — klicken zum Pausieren"
      }
    >
      <span className="proc-toggle__icon" aria-hidden="true">
        {paused ? "▶" : "⏸"}
      </span>
      {paused ? "Pausiert — fortsetzen" : "Verarbeitung pausieren"}
    </button>
  );
}
