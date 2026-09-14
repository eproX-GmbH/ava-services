// Register-Delta S6 — Einstellungen: Stammdaten mitpflegen (Mithelfen).
import { useEffect, useState } from "react";
import type { MithelfenStatus, MithelfenVerlauf } from "../../../../shared/register-delta-types";

const GRUND_TEXT: Record<string, string> = {
  aus: "Ausgeschaltet.",
  organisation: "Deine Organisation hat das Mithelfen abgeschaltet.",
  abgemeldet: "Du bist nicht angemeldet.",
  akku: "Pausiert im Akkubetrieb.",
  nicht_installiert: "Der Worker ist in dieser Installation nicht enthalten.",
  gesperrt: "Das Registerportal hat die Abfragen vorübergehend gesperrt, es geht automatisch weiter.",
};

const ART_TEXT: Record<string, string> = { front: "Neue Firmen (Nummernfront)", bekanntmachungen: "Registerbekanntmachungen", refresh: "Auffrischung bekannter Firmen" };

export function MithelfenSection() {
  const [s, setS] = useState<MithelfenStatus | null>(null);
  const [queue, setQueue] = useState<Record<string, unknown> | null>(null);
  const [verlauf, setVerlauf] = useState<MithelfenVerlauf | null>(null);
  const [alleZeigen, setAlleZeigen] = useState(false);
  useEffect(() => {
    void window.api.registerDelta.status().then(setS);
    const off = window.api.registerDelta.onStatus(setS);
    void window.api.registerDelta.verlauf().then(setVerlauf);
    const offV = window.api.registerDelta.onVerlauf(setVerlauf);
    void window.api.registerDelta.queue().then(setQueue).catch(() => setQueue(null));
    const t = setInterval(() => void window.api.registerDelta.queue().then(setQueue).catch(() => undefined), 30_000);
    return () => {
      off();
      offV();
      clearInterval(t);
    };
  }, []);
  if (!s) return null;
  const setze = (patch: { aktiv?: boolean; nurNetzbetrieb?: boolean }) => void window.api.registerDelta.setSettings(patch).then(setS);
  const jobs = (queue?.jobs as Record<string, Record<string, number>> | undefined) ?? undefined;
  const offen = jobs ? Object.values(jobs).reduce((n, j) => n + (j.offen ?? 0), 0) : null;
  return (
    <section className="provider-section alerts-prefs" id="mithelfen-section">
      <h3>Stammdaten mitpflegen</h3>
      <p className="muted">
        Die Firmenstammdaten stammen aus dem Handelsregister. Neue Eintragungen, Löschungen und Änderungen holt AVA laufend nach. Wenn du mithilfst,
        fragt dein Rechner im Hintergrund das Registerportal ab: höchstens 60 Abfragen je Stunde, mit einem unsichtbaren Chrome-Fenster, nur
        handelsregister.de, keine Downloads. Die Ergebnisse landen im geteilten Bestand aller Nutzer.
      </p>
      {!s.orgErlaubt && <p className="muted small">Deine Organisation hat das Mithelfen abgeschaltet.</p>}
      {s.pausenGrund === "nicht_installiert" && <p className="muted small">{GRUND_TEXT.nicht_installiert}</p>}
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.aktiv} disabled={!s.orgErlaubt || s.pausenGrund === "nicht_installiert"} onChange={(e) => setze({ aktiv: e.target.checked })} />
          <span>Mithelfen: Register-Jobs auf diesem Rechner abarbeiten</span>
        </label>
      </div>
      <div className="alerts-prefs__row">
        <label className="alerts-prefs__check">
          <input type="checkbox" checked={s.nurNetzbetrieb} disabled={!s.orgErlaubt || !s.aktiv} onChange={(e) => setze({ nurNetzbetrieb: e.target.checked })} />
          <span>Nur im Netzbetrieb, im Akkubetrieb pausieren</span>
        </label>
      </div>
      {s.aktiv && (
        <div className="alerts-prefs__row">
          <span className={`status-dot ${s.laeuft && !s.pausenGrund ? "ok" : "muted"}`} />
          <span className="small">
            {s.pausenGrund
              ? GRUND_TEXT[s.pausenGrund]
              : s.aktuellerJob
                ? `Arbeitet: ${ART_TEXT[s.aktuellerJob.art] ?? s.aktuellerJob.art}`
                : "Wartet auf Jobs."}{" "}
            Erledigt seit Start: {s.jobsErledigt}. Abfragen in der letzten Stunde: {s.abfragenLetzteStunde} von 60.
            {s.letzterFehler ? ` Letzter Fehler: ${s.letzterFehler}` : ""}
          </span>
        </div>
      )}
      {queue && (
        <p className="muted small">
          Geteilte Queue: {offen ?? 0} offene Jobs, {String(queue.erledigtHeute ?? 0)} heute erledigt, {String(queue.workerAktiv ?? 0)} Rechner in der letzten Stunde aktiv.
        </p>
      )}
      {verlauf && verlauf.summe.jobs > 0 && (
        <>
          <h4 style={{ marginTop: "1rem", marginBottom: "0.25rem" }}>Was dieser Rechner beigetragen hat</h4>
          <p className="muted small">
            Seit {verlauf.summe.seit ? new Date(verlauf.summe.seit).toLocaleDateString("de-DE") : "Start"}: {verlauf.summe.jobs} Jobs, {verlauf.summe.abfragen} Abfragen,{" "}
            {verlauf.summe.treffer} Registerblätter gelesen, {verlauf.summe.neu} Firmen neu, {verlauf.summe.geaendert} geändert.
          </p>
          <div className="wf-runs__tablewrap">
            <table className="small">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Art</th>
                  <th>Was</th>
                  <th>Abfragen</th>
                  <th>Treffer</th>
                  <th>Neu</th>
                  <th>Geändert</th>
                </tr>
              </thead>
              <tbody>
                {(alleZeigen ? verlauf.eintraege : verlauf.eintraege.slice(0, 10)).map((e) => (
                  <tr key={e.id + e.at}>
                    <td>{new Date(e.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td>{ART_TEXT[e.art] ?? e.art}</td>
                    <td>{e.was}{e.art === "bekanntmachungen" ? ` (${e.bekanntmachungen} Einträge)` : ""}</td>
                    <td>{e.abfragen}</td>
                    <td>{e.treffer}</td>
                    <td>{e.neu}</td>
                    <td>{e.geaendert}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {verlauf.eintraege.length > 10 && (
            <button type="button" className="btn" onClick={() => setAlleZeigen((v) => !v)}>
              {alleZeigen ? "Weniger anzeigen" : `Alle ${verlauf.eintraege.length} anzeigen`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
