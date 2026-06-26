import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DailyTokenLimitStatus } from "../../../shared/types";

// v0.1.405 — Banner unter der TopBar, das erscheint, sobald das
// konfigurierbare TAGES-Token-Limit (Chat + Agent zusammen) erreicht ist.
//
// Quelle: `window.api.usage.limitStatus()` beim Mount + Live-Push über
// `usage.onDailyLimitStatus` (Main schickt nach jedem Turn und bei jeder
// Limit-Änderung). Reine Renderer-Logik, kein eigenes Polling.
//
// Verhalten laut Spec: die laufende Anfrage läuft voll durch; ist danach
// das Tageskontingent erreicht, blockt der Orchestrator die NÄCHSTE
// Anfrage — dieses Banner macht den Zustand sichtbar und verlinkt direkt
// zur Limit-Einstellung (Einstellungen → Verbrauch).

export function DailyTokenLimitBanner() {
  const [status, setStatus] = useState<DailyTokenLimitStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void window.api.usage
      .limitStatus()
      .then((s) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        /* Limit-Status nicht abrufbar — Banner bleibt aus */
      });
    const unsubscribe = window.api.usage.onDailyLimitStatus((s) => {
      setStatus(s);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  if (!status || !status.exceeded || status.limit === null) return null;

  return (
    <div className="token-limit-banner" role="alert">
      <span className="token-limit-banner__icon" aria-hidden>
        ⛔
      </span>
      <p className="token-limit-banner__msg">
        Tägliches Token-Limit aufgebraucht —{" "}
        <strong>{status.usedToday.toLocaleString("de-DE")}</strong> von{" "}
        <strong>{status.limit.toLocaleString("de-DE")}</strong> Tokens heute.
        Neue Anfragen sind pausiert, bis du das Limit erhöhst oder entfernst.
      </p>
      <Link to="/settings#verbrauch-limit" className="token-limit-banner__cta">
        Limit anpassen
      </Link>
    </div>
  );
}
