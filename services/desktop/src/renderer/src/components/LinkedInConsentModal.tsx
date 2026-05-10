// LinkedIn-Beobachter consent modal (Phase L0).
//
// Hard opt-in gate. The Settings master switch routes through this
// before flipping `enabled: true`. The user must read the disclosure
// and tick the responsibility checkbox; "Aktivieren" stays disabled
// until both happen. Esc / backdrop click cancels.

import { useEffect, useState } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
  onAccepted: () => void;
}

export function LinkedInConsentModal({ open, onClose, onAccepted }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset checkbox each time the modal opens so a previous abort
  // doesn't leave it pre-checked.
  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setBusy(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onAktivieren = async () => {
    if (busy || !acknowledged) return;
    setBusy(true);
    try {
      await window.api.linkedin.acceptConsent();
      const result = await window.api.linkedin.updateSettings({ enabled: true });
      if (result && typeof result === "object" && "error" in result) {
        // Should never happen — we just accepted consent — but surface
        // it instead of silently failing.
        // eslint-disable-next-line no-console
        console.error("[linkedin] enable after consent failed:", result.error);
        return;
      }
      onAccepted();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="linkedin-consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="linkedin-consent-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="linkedin-consent-panel">
        <header className="linkedin-consent-header">
          <h3 id="linkedin-consent-title">LinkedIn-Beobachter aktivieren</h3>
          <p className="muted small">
            Bevor du diese Funktion einschaltest, lies bitte folgende Hinweise:
          </p>
        </header>

        <ol className="linkedin-consent-list">
          <li>
            <strong>Risiko für dein LinkedIn-Konto.</strong> AVA wird im
            Hintergrund deinen LinkedIn-Feed lesen, um Vertriebssignale zu
            erkennen. LinkedIn untersagt solchen automatisierten Zugriff in
            den Nutzungsbedingungen. LinkedIn kann dein Konto deshalb sperren
            oder einschränken. Du nimmst dieses Risiko bewusst in Kauf.
          </li>
          <li>
            <strong>Daten bleiben lokal.</strong> Alle Beiträge, Bilder und
            abgeleiteten Signale werden ausschließlich auf diesem Gerät
            gespeichert. AVA überträgt diese Daten zu keinem Zeitpunkt an
            seinen Cloud-Dienst. Bei Cloud-Bildanalyse (separat zu aktivieren)
            werden Bilder an deinen konfigurierten LLM-Anbieter gesendet —
            das ist die einzige Ausnahme.
          </li>
          <li>
            <strong>DSGVO-Verantwortung.</strong> Der Feed enthält
            personenbezogene Daten anderer LinkedIn-Nutzer (Beitragsautoren,
            Kommentatoren, Personen auf Bildern). Mit der Aktivierung
            übernimmst du als Verantwortliche/r die DSGVO-Pflichten dafür:
            Rechtsgrundlage prüfen (i. d. R. berechtigtes Interesse),
            DSGVO-Folgenabschätzung empfohlen, Auskunfts- und Löschpflichten
            beachten.
          </li>
          <li>
            <strong>Jederzeit abschaltbar.</strong> Über den Notschalter in
            den Einstellungen löschst du mit einem Klick alle gespeicherten
            LinkedIn-Daten dieses Geräts.
          </li>
        </ol>

        <label className="linkedin-consent-check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            Ich habe gelesen und verstanden. Ich bin verantwortlich für die
            DSGVO-konforme Verarbeitung und nehme das Risiko für mein
            LinkedIn-Konto in Kauf.
          </span>
        </label>

        <div className="linkedin-consent-actions">
          <button
            type="button"
            className="link"
            onClick={onClose}
            disabled={busy}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void onAktivieren()}
            disabled={!acknowledged || busy}
          >
            {busy ? "Aktiviere…" : "Aktivieren"}
          </button>
        </div>
      </div>
    </div>
  );
}
