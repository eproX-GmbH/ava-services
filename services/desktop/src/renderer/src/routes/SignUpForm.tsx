import { useState } from "react";
import { ArrowLeft, Loader2, Sparkles, UserPlus } from "lucide-react";

// In-App-Registration form.
//
// Sends `auth:register` over IPC. Main hits `POST /v1/auth/register` on
// the gateway, which:
//   1. Creates the user via the Keycloak Admin API.
//   2. ROPC-exchanges email+password for an OIDC token-set.
//   3. Returns the tokens.
// Main adopts the tokens through the SAME applyTokens() path as the
// browser sign-in flow, so as soon as `register()` resolves the
// app-level status switches to signedIn and `App` re-renders the
// gated routes. This form will simply be unmounted at that moment.
//
// All visible strings are German. Server errors carry a `code` field
// (email_taken / weak_password / …) so we can target the offending
// form field instead of dumping a generic banner.

const LEGAL = {
  agb: "https://www.ava.bi/agb",
  datenschutz: "https://www.ava.bi/datenschutz",
  impressum: "https://www.ava.bi/impressum",
} as const;

interface Props {
  onBackToSignIn: () => void;
}

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  passwordConfirm?: string;
  acceptTerms?: string;
}

export function SignUpForm({ onBackToSignIn }: Props) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [bannerError, setBannerError] = useState<string | null>(null);

  function validate(): FieldErrors | null {
    const errs: FieldErrors = {};
    if (!firstName.trim()) errs.firstName = "Bitte Vornamen angeben.";
    if (!lastName.trim()) errs.lastName = "Bitte Nachnamen angeben.";
    // Same regex the gateway accepts (zod.email() under the hood). We
    // keep this loose deliberately — anything that looks like an
    // email passes here, the server has the authoritative validator.
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Bitte eine gültige E-Mail-Adresse angeben.";
    }
    if (password.length < 8) {
      errs.password = "Passwort muss mindestens 8 Zeichen haben.";
    }
    if (password !== passwordConfirm) {
      errs.passwordConfirm = "Passwörter stimmen nicht überein.";
    }
    if (!acceptTerms) {
      errs.acceptTerms =
        "AGB und Datenschutzerklärung müssen akzeptiert werden.";
    }
    return Object.keys(errs).length > 0 ? errs : null;
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBannerError(null);
    const errs = validate();
    if (errs) {
      setFieldErrors(errs);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    const result = await window.api.auth.register({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim().toLowerCase(),
      password,
      acceptTerms: true,
    });
    if (result.ok) {
      // Main pushes the signed-in status; App re-renders away from
      // this form. Nothing to do here.
      return;
    }
    setBusy(false);
    // Map server error codes to a field-targeted error where it
    // makes sense; otherwise show the banner.
    switch (result.code) {
      case "email_taken":
        setFieldErrors({ email: result.message });
        break;
      case "weak_password":
        setFieldErrors({ password: result.message });
        break;
      case "invalid_input":
      case "rate_limited":
      case "registration_disabled":
      case "keycloak_error":
      case "network_error":
      case "server_error":
      default:
        setBannerError(result.message);
        break;
    }
  }

  function openExternal(url: string) {
    return (e: React.MouseEvent) => {
      e.preventDefault();
      void window.api.shell.openExternal(url);
    };
  }

  return (
    <div className="signin-shell">
      <form className="signin signup" onSubmit={onSubmit} noValidate>
        <span className="ct-pill" aria-hidden="true">
          <Sparkles className="ct-icon-sm" />
          Konto erstellen
        </span>
        <h1 className="signin__headline">
          Konto bei <span className="ct-gradient-text">AVA</span> anlegen
        </h1>
        <p className="signin__lede">
          Du wirst nach der Registrierung direkt angemeldet — keine separate
          E-Mail-Bestätigung nötig.
        </p>

        {bannerError && (
          <p className="error signin__hint" role="alert">
            {bannerError}
          </p>
        )}

        <div className="signup__grid">
          <label className="field">
            <span>Vorname</span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              disabled={busy}
              maxLength={80}
              required
            />
            {fieldErrors.firstName && (
              <span className="field__error">{fieldErrors.firstName}</span>
            )}
          </label>
          <label className="field">
            <span>Nachname</span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              disabled={busy}
              maxLength={80}
              required
            />
            {fieldErrors.lastName && (
              <span className="field__error">{fieldErrors.lastName}</span>
            )}
          </label>
        </div>

        <label className="field">
          <span>E-Mail</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={busy}
            required
          />
          {fieldErrors.email && (
            <span className="field__error">{fieldErrors.email}</span>
          )}
        </label>

        <label className="field">
          <span>Passwort</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            minLength={8}
            maxLength={128}
            required
          />
          {fieldErrors.password && (
            <span className="field__error">{fieldErrors.password}</span>
          )}
        </label>

        <label className="field">
          <span>Passwort bestätigen</span>
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            required
          />
          {fieldErrors.passwordConfirm && (
            <span className="field__error">{fieldErrors.passwordConfirm}</span>
          )}
        </label>

        <label className="signup__terms">
          <input
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            disabled={busy}
          />
          <span>
            Ich akzeptiere die{" "}
            <a href={LEGAL.agb} onClick={openExternal(LEGAL.agb)}>AGB</a>
            {" "}und die{" "}
            <a
              href={LEGAL.datenschutz}
              onClick={openExternal(LEGAL.datenschutz)}
            >
              Datenschutzerklärung
            </a>
            .
          </span>
        </label>
        {fieldErrors.acceptTerms && (
          <span className="field__error">{fieldErrors.acceptTerms}</span>
        )}

        <button
          type="submit"
          className="primary signin__cta"
          disabled={busy}
        >
          {busy ? (
            <>
              <Loader2
                className="ct-icon"
                style={{ animation: "ava-spin 1s linear infinite" }}
                aria-hidden="true"
              />
              Konto wird erstellt…
            </>
          ) : (
            <>
              <UserPlus className="ct-icon" aria-hidden="true" />
              Konto erstellen
            </>
          )}
        </button>

        <button
          type="button"
          className="link signup__back"
          onClick={onBackToSignIn}
          disabled={busy}
        >
          <ArrowLeft className="ct-icon-sm" aria-hidden="true" />
          Zurück zur Anmeldung
        </button>

        <p className="signup__impressum">
          <a
            href={LEGAL.impressum}
            onClick={openExternal(LEGAL.impressum)}
            className="muted"
          >
            Impressum
          </a>
        </p>
      </form>
    </div>
  );
}
