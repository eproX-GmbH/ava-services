// M4 (docs/PLAN_EMAIL_MUSTER.md) — Einstellungen: lokale E-Mail-Ableitung.
import { useEffect, useState } from "react";

interface Status {
  enabled: boolean;
  laeuft: boolean;
  lastRunAt: string | null;
  lastOutcome: string | null;
  netz: { erreichbar: boolean; grund: string; at: string } | null;
  tag: { day: string; count: number };
  domains: Record<string, { at: string; muster: string | null; belege: number; catchAll: boolean }>;
  stats: { firmen: number; geprueft: number; verifiziert: number; abgelehnt: number; unbekannt: number; catchAll: number };
}

export function EmailMusterSection() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = () => void window.api.emailMuster.status().then(setS);
  useEffect(() => {
    reload();
    const off = window.api.emailMuster.onChanged(() => reload());
    return () => off();
  }, []);
  if (!s) {
    return (
      <section className="provider-section" id="email-muster-section">
        <h3>E-Mail-Ableitung</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–");
  return (
    <section className="provider-section alerts-prefs" id="email-muster-section">
      <h3>E-Mail-Ableitung</h3>
      <p className="muted">
        Kennt AVA von einer Firma eine persönliche E-Mail-Adresse, leitet sie daraus das Adressmuster ab und bildet Adressen für Kontakte ohne E-Mail.
        Jede Adresse wird per Mail-Server-Anfrage auf Existenz geprüft, ohne eine E-Mail zu senden. Nur geprüfte Adressen werden gespeichert und als
        „abgeleitet · verifiziert“ angezeigt. Läuft lokal auf diesem Rechner, eine Firma alle 15 Minuten, nicht während eines Chats und nicht im Akkubetrieb.
      </p>
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.enabled} onChange={(e) => void window.api.emailMuster.setConfig({ enabled: e.target.checked }).then(() => reload())} />
          <span>E-Mail-Ableitung aktiv</span>
        </label>
        <button
          type="button"
          className="proc-toggle"
          disabled={busy || s.laeuft}
          onClick={() => {
            setBusy(true);
            setNotice(null);
            void window.api.emailMuster.runNow().then((r) => {
              setNotice(r.ergebnis);
              setBusy(false);
              reload();
            });
          }}
        >
          {busy || s.laeuft ? "Läuft …" : "Jetzt eine Firma prüfen"}
        </button>
      </div>
      <dl className="tx-summary">
        <dt>Mail-Prüfung</dt>
        <dd>{s.netz ? (s.netz.erreichbar ? "in diesem Netz möglich" : `in diesem Netz nicht möglich (${s.netz.grund})`) : "noch nicht geprüft"}</dd>
        <dt>Letzter Durchgang</dt>
        <dd>
          {fmt(s.lastRunAt)}
          {s.lastOutcome ? ` — ${s.lastOutcome}` : ""}
        </dd>
        <dt>Heute geprüft</dt>
        <dd>{s.tag.count} von 50</dd>
        <dt>Gesamt</dt>
        <dd>
          {s.stats.verifiziert} verifiziert · {s.stats.abgelehnt} abgelehnt · {s.stats.unbekannt} unklar · {s.stats.catchAll} Catch-all-Domains · {Object.keys(s.domains).length} Domains geprüft
        </dd>
      </dl>
      {notice && <p className="muted small">{notice}</p>}
    </section>
  );
}
