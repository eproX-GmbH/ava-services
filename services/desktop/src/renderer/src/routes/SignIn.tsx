import { useState } from "react";
import { Loader2, LogIn, Sparkles } from "lucide-react";

// Sign-in screen — Corporate Trust hero card.
//
// Triggers the OIDC PKCE flow in the main process. Main opens the user's
// system browser to Keycloak; this component just shows a button + a
// running status hint. When auth completes, the main process pushes a
// status update over IPC and `App` re-renders the gated routes.
//
// Visual: white card with colored shadow + violet soft blob behind it,
// gradient AVA wordmark (replaces the legacy aqua SVG), gradient CTA.
// Logic flow (signIn IPC, busy state, error surfacing) is unchanged.

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
    <div className="signin-shell">
      <div className="signin">
        <span className="ct-pill" aria-hidden="true">
          <Sparkles className="ct-icon-sm" />
          Sicher anmelden
        </span>
        <h1 className="signin__headline">
          Willkommen bei{" "}
          <span className="ct-gradient-text">AVA</span>
        </h1>
        <p className="signin__lede">
          Mit deinem AVA-Konto anmelden, um fortzufahren. Wir öffnen deinen
          Standard-Browser für die sichere Authentifizierung.
        </p>
        <button onClick={onClick} disabled={busy} className="primary signin__cta">
          {busy ? (
            <>
              <Loader2 className="ct-icon" style={{ animation: "ava-spin 1s linear infinite" }} aria-hidden="true" />
              Warte auf Browser…
            </>
          ) : (
            <>
              <LogIn className="ct-icon" aria-hidden="true" />
              Anmelden
            </>
          )}
        </button>
        {busy && (
          <p className="muted signin__hint">
            Dein Standard-Browser sollte sich geöffnet haben. Schließe die
            Anmeldung dort ab und kehre zu diesem Fenster zurück.
          </p>
        )}
        {error && (
          <p className="error signin__hint" role="alert">
            Anmeldung fehlgeschlagen: {error}
          </p>
        )}
      </div>
    </div>
  );
}
