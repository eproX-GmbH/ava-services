import { useState } from "react";

// v0.1.409 — „Alles zurücksetzen außer KI-Modelle" (Werksreset).
//
// Löscht ALLE lokal gespeicherten Daten — Chats, Profil, Verbräuche,
// Alerts, Memory, Automationen und alle Fremd-Integrationen
// (HubSpot/LinkedIn/Mail inkl. deren Zugänge). ERHALTEN bleiben nur die
// LLM-Provider (gewählte Modelle + API-Keys/OAuth) sowie heruntergeladene
// Ollama-/Whisper-Modelle.
//
// Doppelte Absicherung: erst der rote Button, dann ein Dialog, in dem man
// zusätzlich das Wort ZURÜCKSETZEN tippen muss, bevor der Bestätigen-Knopf
// aktiv wird. Danach startet AVA neu; die eigentliche Löschung passiert
// beim nächsten Boot (vor dem Öffnen der Stores).

const CONFIRM_WORD = "ZURÜCKSETZEN";

export function DangerZoneSection() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const confirmed = typed.trim().toUpperCase() === CONFIRM_WORD;

  async function doReset() {
    if (!confirmed || busy) return;
    setBusy(true);
    try {
      // Renderer-seitige UI-/Zustandsschlüssel leeren (Theme behalten).
      try {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith("ava.") && k !== "ava.theme") localStorage.removeItem(k);
        }
        sessionStorage.clear();
      } catch {
        /* localStorage nicht verfügbar — egal, Main löscht den Rest */
      }
      await window.api.settings.resetAllExceptModels();
      // App startet gleich neu; falls nicht, Hinweis stehen lassen.
    } catch (err) {
      setBusy(false);
      alert(
        "Zurücksetzen fehlgeschlagen: " +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return (
    <section className="provider-section danger-zone" id="danger-zone">
      <h3>Zurücksetzen</h3>
      <p className="muted">
        Setzt AVA auf den Ausgangszustand zurück und löscht{" "}
        <strong>alle lokal gespeicherten Daten</strong> — Chats, Profil,
        Verbrauchsstatistiken, Meldungen, Erinnerungen, Automatisierungen sowie
        alle verbundenen Integrationen (HubSpot, LinkedIn, E-Mail) samt deren
        Zugängen.
      </p>
      <p className="muted small">
        <strong>Erhalten bleiben</strong> deine KI-Modelle: gewählte Provider +
        API-Keys/Anmeldungen und bereits heruntergeladene lokale Modelle.
      </p>
      <button
        type="button"
        className="btn btn--danger"
        onClick={() => {
          setTyped("");
          setOpen(true);
        }}
      >
        Alles zurücksetzen (außer KI-Modelle)
      </button>

      {open && (
        <div
          className="danger-modal__overlay"
          role="dialog"
          aria-modal="true"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="danger-modal">
            <h4>Wirklich alles zurücksetzen?</h4>
            <p>
              Diese Aktion kann <strong>nicht rückgängig</strong> gemacht
              werden. Alle Chats, dein Profil, sämtliche Verbräuche und alle
              Integrationen (inkl. HubSpot/LinkedIn/E-Mail-Zugänge) werden
              endgültig gelöscht.
            </p>
            <p className="muted small">
              Deine KI-Modelle (Provider, API-Keys/Anmeldungen, heruntergeladene
              Modelle) bleiben erhalten. AVA startet danach neu.
            </p>
            <label className="danger-modal__confirm">
              <span>
                Zum Bestätigen <strong>{CONFIRM_WORD}</strong> eingeben:
              </span>
              <input
                type="text"
                autoFocus
                value={typed}
                disabled={busy}
                placeholder={CONFIRM_WORD}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && confirmed) void doReset();
                }}
              />
            </label>
            <div className="danger-modal__actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => setOpen(false)}
              >
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={!confirmed || busy}
                onClick={() => void doReset()}
              >
                {busy ? "Wird zurückgesetzt…" : "Endgültig zurücksetzen & neu starten"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
