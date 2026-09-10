// M4 (docs/PLAN_EMAIL_MUSTER.md) — Einstellungen: lokale E-Mail-Ableitung.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { EmailMusterConfig, VerlaufEintrag, VerlaufErgebnis } from "../../../../shared/email-muster-types";

type Status = EmailMusterConfig & { laeuft: boolean };
type Filter = "alle" | "gespeichert" | VerlaufErgebnis;

const ERGEBNIS_LABEL: Record<VerlaufErgebnis, string> = {
  verifiziert: "verifiziert",
  abgelehnt: "abgelehnt",
  unklar: "unklar",
  catch_all: "Catch-all",
  gesperrt: "Netz gesperrt",
};
const ERGEBNIS_PILL: Record<VerlaufErgebnis, string> = {
  verifiziert: "pill--active",
  abgelehnt: "pill--error",
  unklar: "pill--paused",
  catch_all: "pill--paused",
  gesperrt: "pill--error",
};

export function EmailMusterSection() {
  const [s, setS] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("alle");
  const [zeige, setZeige] = useState(25);
  const [domainsOffen, setDomainsOffen] = useState(false);
  const reload = () => void window.api.emailMuster.status().then(setS);
  useEffect(() => {
    reload();
    const off = window.api.emailMuster.onChanged(() => reload());
    return () => off();
  }, []);
  const verlauf = useMemo<VerlaufEintrag[]>(() => {
    const rows = s?.verlauf ?? [];
    if (filter === "alle") return rows;
    if (filter === "gespeichert") return rows.filter((r) => r.gespeichert);
    return rows.filter((r) => r.ergebnis === filter);
  }, [s, filter]);
  if (!s) {
    return (
      <section className="provider-section" id="email-muster-section">
        <h3>E-Mail-Ableitung</h3>
        <p className="muted">Lädt…</p>
      </section>
    );
  }
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "–");
  const domains = Object.entries(s.domains).sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  const anzahl = (f: Filter) => (f === "alle" ? s.verlauf.length : f === "gespeichert" ? s.verlauf.filter((r) => r.gespeichert).length : s.verlauf.filter((r) => r.ergebnis === f).length);
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
        <div>
          <dt>Mail-Prüfung</dt>
          <dd>{s.netz ? (s.netz.erreichbar ? "in diesem Netz möglich" : `in diesem Netz nicht möglich (${s.netz.grund})`) : "noch nicht geprüft"}</dd>
        </div>
        <div>
          <dt>Letzter Durchgang</dt>
          <dd>
            {fmt(s.lastRunAt)}
            {s.lastOutcome ? ` — ${s.lastOutcome}` : ""}
          </dd>
        </div>
        <div>
          <dt>Heute geprüft</dt>
          <dd>{s.tag.count} von 50</dd>
        </div>
        <div>
          <dt>Gesamt</dt>
          <dd>
            {s.stats.verifiziert} verifiziert · {s.stats.abgelehnt} abgelehnt · {s.stats.unbekannt} unklar · {s.stats.catchAll} Catch-all-Domains · {domains.length} Domains geprüft
          </dd>
        </div>
      </dl>
      {notice && <p className="muted small">{notice}</p>}

      <h4 className="em-verlauf__h">Verlauf der Adressprüfungen</h4>
      {s.verlauf.length === 0 ? (
        <p className="muted small">Noch keine Adresse geprüft. Der Verlauf füllt sich, sobald der Hintergrund-Job eine Firma mit Kontakten ohne E-Mail bearbeitet hat.</p>
      ) : (
        <>
          <div className="em-verlauf__filter" role="tablist" aria-label="Verlauf filtern">
            {(["alle", "gespeichert", "verifiziert", "abgelehnt", "unklar", "catch_all", "gesperrt"] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={`em-verlauf__chip${filter === f ? " em-verlauf__chip--on" : ""}`}
                onClick={() => {
                  setFilter(f);
                  setZeige(25);
                }}
              >
                {f === "alle" ? "Alle" : f === "gespeichert" ? "Gespeichert" : ERGEBNIS_LABEL[f]} <span className="muted">{anzahl(f)}</span>
              </button>
            ))}
          </div>
          <div className="wf-runs__tablewrap">
            <table className="em-verlauf">
              <thead>
                <tr>
                  <th>Geprüft am</th>
                  <th>Firma</th>
                  <th>Person</th>
                  <th>Adresse</th>
                  <th>Muster</th>
                  <th>Ergebnis</th>
                  <th>Gespeichert</th>
                </tr>
              </thead>
              <tbody>
                {verlauf.slice(0, zeige).map((r, i) => (
                  <tr key={`${r.at}-${r.email}-${i}`}>
                    <td className="em-verlauf__when">{fmt(r.at)}</td>
                    <td>
                      <Link to={`/companies/${encodeURIComponent(r.companyId)}`} title="Firmendetail öffnen">
                        {r.firma}
                      </Link>
                    </td>
                    <td>{r.fullName}</td>
                    <td className="em-verlauf__mail">{r.email}</td>
                    <td>
                      <code>{r.muster}</code>
                    </td>
                    <td>
                      <span className={`pill ${ERGEBNIS_PILL[r.ergebnis]}`} title={r.smtpCode ? `Mail-Server-Antwort ${r.smtpCode}${r.mx ? ` (${r.mx})` : ""}` : undefined}>
                        {ERGEBNIS_LABEL[r.ergebnis]}
                      </span>
                    </td>
                    <td>
                      {r.gespeichert ? (
                        <span title="Als Kontakt-E-Mail gespeichert, sichtbar auf der Kontaktkarte">✓ ja</span>
                      ) : r.fehler ? (
                        <span className="em-verlauf__err" title={r.fehler}>
                          Fehler
                        </span>
                      ) : (
                        <span className="muted">–</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {verlauf.length > zeige && (
            <button type="button" className="proc-toggle" onClick={() => setZeige((z) => z + 50)}>
              Mehr anzeigen ({verlauf.length - zeige} weitere)
            </button>
          )}
        </>
      )}

      {domains.length > 0 && (
        <details className="em-domains" open={domainsOffen} onToggle={(e) => setDomainsOffen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>Geprüfte Domains ({domains.length})</summary>
          <div className="wf-runs__tablewrap">
            <table className="em-verlauf">
              <thead>
                <tr>
                  <th>Domain</th>
                  <th>Muster</th>
                  <th>Belege</th>
                  <th>Zuletzt geprüft</th>
                  <th>Nächste Prüfung</th>
                </tr>
              </thead>
              <tbody>
                {domains.map(([d, st]) => {
                  const frist = st.catchAll ? 90 : 30;
                  const next = new Date(Date.parse(st.at) + frist * 86_400_000);
                  return (
                    <tr key={d}>
                      <td>{d}</td>
                      <td>{st.catchAll ? <span className="pill pill--paused">Catch-all</span> : st.muster ? <code>{st.muster}</code> : <span className="muted">kein Muster erkannt</span>}</td>
                      <td>{st.belege}</td>
                      <td>{fmt(st.at)}</td>
                      <td className="muted">frühestens {next.toLocaleDateString("de-DE")} oder bei neuen Belegen</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
