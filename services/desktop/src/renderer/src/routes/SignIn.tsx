import { useState } from "react";
import logoUrl from "../assets/logo.svg";

// Sign-in screen.
//
// Triggers the OIDC PKCE flow in the main process. Main opens the user's
// system browser to Keycloak; this component just shows a button + a
// running status hint. When auth completes, the main process pushes a
// status update over IPC and `App` re-renders the gated routes.
//
// Brand: the AVA aqua wordmark (logo.svg) replaces the prior plain
// "AVA" text headline so the desktop matches the Keycloak login form
// branding 1:1. The SVG inlines its own fill (#00c0a7), so we don't
// need extra colour rules here.

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
      <img
        src={logoUrl}
        alt="AVA"
        className="signin__logo"
        width={160}
        draggable={false}
      />
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
