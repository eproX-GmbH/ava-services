// v0.1.636 — Aktivitaets-Indikator des Firmen-Radars mit Live-Popup.
//
// Ein Punkt neben der Ueberschrift: grau = nichts in Arbeit, gruen
// pulsierend = Scan / Mini-Profile / ICP-Match laeuft, rot = letzter
// Schritt fehlgeschlagen. Klick oeffnet ein Popup mit Suchbegriffen,
// Zaehlern, Firmen in Arbeit und den juengsten Ereignissen; alles live
// ueber discovery:activity:changed.
import { useEffect, useRef, useState } from "react";
import type { RadarActivityState } from "../../../shared/radar-activity-types";

const PHASE_LABEL: Record<RadarActivityState["phase"], string> = {
  idle: "Nichts in Arbeit",
  scan: "Scan läuft",
  profile: "Mini-Profile werden erstellt",
  match: "ICP-Match läuft",
  fehler: "Fehler",
};

function seit(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `seit ${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `seit ${m} min` : `seit ${Math.floor(m / 60)} h ${m % 60} min`;
}

function uhr(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function RadarActivityIndicator() {
  const [s, setS] = useState<RadarActivityState | null>(null);
  const [offen, setOffen] = useState(false);
  const [, tick] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.api.discovery.activity().then(setS);
    const off = window.api.discovery.onActivity(setS);
    return () => off();
  }, []);
  // "seit …" im Popup weiterlaufen lassen.
  useEffect(() => {
    if (!offen) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [offen]);
  useEffect(() => {
    if (!offen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOffen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOffen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [offen]);

  if (!s) return null;
  const aktiv = s.phase !== "idle";
  const fehler = !aktiv && s.letzterFehler !== null && (!s.letzterLauf || Date.parse(s.letzterFehler.at) > Date.parse(s.letzterLauf.at));
  const zustand = aktiv ? "aktiv" : fehler ? "fehler" : "ruhe";
  const label = aktiv ? `${PHASE_LABEL[s.phase]}${s.schritt ? `: ${s.schritt}` : ""}` : fehler ? `Fehler: ${s.letzterFehler!.text}` : PHASE_LABEL.idle;

  return (
    <div className="radar-act" ref={ref}>
      <button
        type="button"
        className={`radar-act__btn radar-act__btn--${zustand}`}
        onClick={() => setOffen((o) => !o)}
        title={label}
        aria-expanded={offen}
        aria-label={`Radar-Aktivität: ${label}`}
      >
        <span className="radar-act__dot" aria-hidden="true" />
        <span className="radar-act__text">{aktiv ? PHASE_LABEL[s.phase] : fehler ? "Fehler" : "Ruhe"}</span>
      </button>
      {offen && (
        <div className="radar-act__pop" role="dialog" aria-label="Radar-Aktivität">
          <div className="radar-act__head">
            <strong>{PHASE_LABEL[s.phase]}</strong>
            <span className="muted small">{aktiv ? seit(s.seit) : s.letzterLauf ? `letzter Lauf ${new Date(s.letzterLauf.at).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}` : "noch kein Lauf"}</span>
          </div>
          {s.schritt && aktiv && <p className="radar-act__step">{s.schritt}</p>}
          {fehler && <p className="radar-act__err">{s.letzterFehler!.text}</p>}

          {(s.scan.laeuft || s.scan.queries.length > 0) && (
            <section className="radar-act__sec">
              <h4>Scan</h4>
              <p className="small">
                Karte {s.scan.gefunden.osm} · Google {s.scan.gefunden.serp} · Register {s.scan.gefunden.register}
                {s.scan.hochgeladen > 0 ? ` · ${s.scan.hochgeladen} gespeichert` : ""}
              </p>
              {s.scan.queries.length > 0 && (
                <ul className="radar-act__list">
                  {s.scan.queries.map((q) => (
                    <li key={q} className={q === s.scan.aktuelleQuery ? "radar-act__now" : undefined}>
                      {q === s.scan.aktuelleQuery ? "▸ " : ""}
                      {q}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          <section className="radar-act__sec">
            <h4>
              Mini-Profile
              {s.profile.laeuft ? <span className="radar-act__live">live</span> : null}
              {s.profile.pausiert ? <span className="muted small"> · pausiert, Chat hat Vorrang</span> : null}
            </h4>
            <p className="small">
              {s.profile.fertig} fertig · {s.profile.offen} offen{s.profile.fehler > 0 ? ` · ${s.profile.fehler} fehlgeschlagen` : ""}
            </p>
            {s.profile.aktuell.length > 0 && (
              <ul className="radar-act__list">
                {s.profile.aktuell.map((n) => (
                  <li key={n} className="radar-act__now">
                    ▸ {n}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="radar-act__sec">
            <h4>
              ICP-Match
              {s.match.laeuft ? <span className="radar-act__live">live</span> : null}
            </h4>
            <p className="small">
              {s.match.bewertet} bewertet · {s.match.offen} offen
            </p>
            {s.match.aktuell.length > 0 && (
              <ul className="radar-act__list">
                {s.match.aktuell.map((n) => (
                  <li key={n} className="radar-act__now">
                    ▸ {n}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {s.ereignisse.length > 0 && (
            <section className="radar-act__sec">
              <h4>Verlauf</h4>
              <ul className="radar-act__log">
                {s.ereignisse.slice(0, 12).map((e, i) => (
                  <li key={`${e.at}-${i}`}>
                    <span className="muted">{uhr(e.at)}</span> {e.text}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
