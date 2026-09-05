import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrgQuotaExceeded } from "../../../shared/types";

// O6 — Banner, wenn der Stellvertreter-Proxy einen Aufruf wegen des
// Organisations-Limits abgelehnt hat (429 org_quota_exceeded). Quelle:
// Push aus dem Hauptprozess; verschwindet beim Schliessen oder wenn die
// Zurücksetzung erreicht ist.

export function OrgQuotaBanner() {
  const [info, setInfo] = useState<OrgQuotaExceeded | null>(null);

  useEffect(() => window.api.org.onQuotaExceeded((i) => setInfo(i)), []);
  useEffect(() => {
    if (!info?.resetAt) return;
    const ms = Date.parse(info.resetAt) - Date.now();
    if (!Number.isFinite(ms)) return;
    const t = setTimeout(() => setInfo(null), Math.max(1000, Math.min(ms, 12 * 3_600_000)));
    return () => clearTimeout(t);
  }, [info]);

  if (!info) return null;
  const limit = info.limitCents != null ? `${(info.limitCents / 100).toFixed(2)} USD` : "das Limit";
  const used = `${(info.usedCents / 100).toFixed(2)} USD`;
  const reset = info.resetAt ? new Date(info.resetAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : null;

  return (
    <div className="token-limit-banner" role="alert">
      <span className="token-limit-banner__icon" aria-hidden>
        ⛔
      </span>
      <p className="token-limit-banner__msg">
        {info.scope === "org_total" ? "Monatsbudget der Organisation aufgebraucht" : "Dein Tagesbudget über den Organisationsschlüssel ist aufgebraucht"}{" "}
        — <strong>{used}</strong> von <strong>{limit}</strong>
        {reset ? <> · Zurücksetzung {reset}</> : null}. KI-Aufrufe über den Organisationsschlüssel sind pausiert; mit eigenem
        Schlüssel geht es weiter.
      </p>
      <Link to="/organisation" className="token-limit-banner__cta">
        Limits ansehen
      </Link>
      <button type="button" className="btn" onClick={() => setInfo(null)} aria-label="Hinweis schließen" style={{ marginLeft: "0.5rem" }}>
        Schließen
      </button>
    </div>
  );
}
