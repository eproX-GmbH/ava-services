import { useState } from "react";
import { Loader2, LogIn, Sparkles, UserPlus } from "lucide-react";
import { SignUpForm } from "./SignUpForm";

// Sign-in screen — Corporate Trust hero card.
//
// Container for two views:
//   1. "welcome"  — original Anmelden-CTA + small "Konto erstellen"-Link.
//                   Anmelden triggers the OIDC PKCE flow (system browser).
//   2. "signup"   — in-app registration form (SignUpForm).
//                   On success the form does nothing visible; main pushes
//                   a signed-in status update and App re-renders the gated
//                   routes, replacing this screen entirely.
//
// We intentionally don't lift this into a router — the user can't be on
// any other route while signed out, and a one-component-with-mode keeps
// the boot path simple.

export function SignIn() {
  const [view, setView] = useState<"welcome" | "signup">("welcome");
  if (view === "signup") {
    return <SignUpForm onBackToSignIn={() => setView("welcome")} />;
  }
  return <WelcomeCard onStartSignUp={() => setView("signup")} />;
}

function WelcomeCard({ onStartSignUp }: { onStartSignUp: () => void }) {
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
        <p className="signin__signup-prompt">
          Noch kein Konto?{" "}
          <button
            type="button"
            className="link signin__signup-link"
            onClick={onStartSignUp}
            disabled={busy}
          >
            <UserPlus className="ct-icon-sm" aria-hidden="true" />
            Konto erstellen
          </button>
        </p>
      </div>
    </div>
  );
}
