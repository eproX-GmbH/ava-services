import { useState } from "react";

// Sign-in screen.
//
// Triggers the OIDC PKCE flow in the main process. Main opens the user's
// system browser to Keycloak; this component just shows a button + a
// running status hint. When auth completes, the main process pushes a
// status update over IPC and `App` re-renders the gated routes.

export function SignIn() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      await window.api.auth.signIn();
      // No further action — main pushes status; App re-renders.
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <h1>AVA Desktop</h1>
      <p>Mit deinem AVA-Konto anmelden, um fortzufahren.</p>
      <button onClick={onClick} disabled={busy} className="primary">
        {busy ? "Warte auf Browser…" : "Anmelden"}
      </button>
      {busy && (
        <p className="muted">
          Dein Standard-Browser sollte sich geöffnet haben. Schließe die
          Anmeldung dort ab und kehre zu diesem Fenster zurück.
        </p>
      )}
      {error && <p className="error">Anmeldung fehlgeschlagen: {error}</p>}
    </div>
  );
}
