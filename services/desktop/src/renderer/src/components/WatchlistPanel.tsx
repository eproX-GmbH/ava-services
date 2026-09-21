// WL4 (PLAN_LINKEDIN_WATCHLIST.md §4.5) — Personen-Watchlist-Panel.
//
// Gerendert im Reiter "Personen-Watchlist" der LinkedIn-Route.
//
// 2026-09-21 — Aufgeraeumt: Der Apify-Token wird hier nicht mehr gesetzt
// (das gehoert zu "wo kommen Daten her": Einstellungen → Datenquellen);
// oben steht nur noch der Stand als Zeile. Die Personen kommen zuerst,
// dann die Automatik, alles Seltene (Bestands-Rotation, Suchfenster,
// Actor-Kennungen) liegt zugeklappt unter "Erweitert".
// Datenschutz-Einordnung (§5) bleibt sichtbar, aber kurz.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface WlEntry {
  profileUrl: string;
  label: string;
  quelle: string;
  companyId: string | null;
  aktiv: boolean;
  fokus: boolean;
  addedAt: string;
  lastCheckedAt: string | null;
}

interface WlState {
  error?: string;
  config?: {
    enabled: boolean;
    reactionsActorId: string;
    commentsActorId: string;
    intervalHours: 24 | 168;
    maxItemsPerProfile: number;
    bestandRotationEnabled?: boolean;
    maxBestandPerRun?: number;
    companyWindow?: number;
    lastRunAt: string | null;
    lastOutcome: string | null;
  };
  hasKey?: boolean;
  apifyQuelle?: "eigen" | "organisation" | null;
  apifyVerfuegbar?: boolean;
  eigenerTokenErlaubt?: boolean;
  running?: boolean;
  monthItems?: number;
  limits?: { maxEintraege: number; maxFokus: number } | null;
  entries?: WlEntry[];
}

export function WatchlistPanel(): JSX.Element {
  const [state, setState] = useState<WlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [addUrl, setAddUrl] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addFokus, setAddFokus] = useState(false);

  const reload = useCallback(async () => {
    setState(await window.api.linkedin.watchlist.getState());
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "error" in (r as object)) {
        setNotice(String((r as { error?: string }).error));
      } else if (typeof r === "string") {
        setNotice(r);
      }
      await reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p className="muted">Lädt…</p>;
  if (state.error) return <p className="muted">{state.error}</p>;
  const cfg = state.config!;
  const entries = state.entries ?? [];
  const limits = state.limits;
  const gesperrt = limits !== null && limits !== undefined && limits.maxEintraege === 0;
  // v0.1.580 — Apify-Zugang: eigener Token oder Organisationsschluessel.
  const zugang = state.apifyVerfuegbar ?? state.hasKey ?? false;
  const ueberOrg = state.apifyQuelle === "organisation";
  const fokusAnzahl = entries.filter((e) => e.fokus).length;
  const setzeConfig = (patch: Record<string, unknown>) =>
    void run(() => window.api.linkedin.watchlist.setConfig(patch as never));

  if (gesperrt) {
    return (
      <div className="ct-card wl">
        <p className="radar-lockbanner">
          🔒 Die Personen-Watchlist ist ab dem <strong>Starter-Plan</strong>{" "}
          enthalten (25 Personen, 5 im Fokus) — Einstellungen → Abo.
        </p>
      </div>
    );
  }

  return (
    <div className="ct-card wl">
      {/* Stand auf einen Blick: Zugang, Automatik, letzter Lauf, Plaetze. */}
      <div className="wl__stand">
        <span className={`ct-pill ${zugang ? "ct-pill--accent" : "ct-pill--muted"}`}>
          {zugang ? (ueberOrg ? "Apify über Organisation" : "Apify: eigener Token") : "Kein Apify-Zugang"}
        </span>
        <Link to="/settings#apify-section" className="link small">Zugang in den Einstellungen</Link>
        <span className="wl__stand-trenner" aria-hidden="true" />
        <span className={`ct-pill ${cfg.enabled ? "ct-pill--accent" : "ct-pill--muted"}`}>
          {cfg.enabled ? `Automatik ${cfg.intervalHours === 168 ? "wöchentlich" : "täglich"}` : "Automatik aus"}
        </span>
        <span className="muted small">
          {cfg.lastRunAt
            ? `Letzter Lauf ${new Date(cfg.lastRunAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })}${cfg.lastOutcome ? `: ${cfg.lastOutcome}` : ""}`
            : "Noch kein Lauf"}
        </span>
        <span className="muted small">· {state.monthItems ?? 0} Items diesen Monat</span>
        {limits && (
          <span className="muted small">· Plätze {entries.length}/{limits.maxEintraege}, Fokus {fokusAnzahl}/{limits.maxFokus}</span>
        )}
      </div>

      {!zugang && (
        <p className="wl__hinweis">
          Ohne Apify-Zugang läuft die Watchlist nicht. Hinterlege einen eigenen Token unter{" "}
          <Link to="/settings#apify-section" className="link">Einstellungen → Datenquellen</Link>
          {" "}oder lass dir den Organisationsschlüssel freischalten.
        </p>
      )}

      {/* ---- Personen ------------------------------------------------------ */}
      <h4 className="wl__titel">Personen</h4>
      <div className="wl__aufnahme">
        <input
          className="telegram-input"
          placeholder="https://www.linkedin.com/in/…"
          value={addUrl}
          disabled={busy}
          onChange={(e) => setAddUrl(e.target.value)}
        />
        <input
          className="telegram-input wl__aufnahme-name"
          placeholder="Name"
          value={addLabel}
          disabled={busy}
          onChange={(e) => setAddLabel(e.target.value)}
        />
        <label className="field-inline" title="Fokus-Personen werden bei jedem Lauf geprüft und mindestens als Warnung gemeldet">
          <input type="checkbox" checked={addFokus} onChange={(e) => setAddFokus(e.target.checked)} />
          <span>Fokus</span>
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || addUrl.trim().length < 10}
          onClick={() =>
            void run(async () => {
              const r = await window.api.linkedin.watchlist.add({
                profileUrl: addUrl,
                label: addLabel.trim() || undefined,
                fokus: addFokus,
              });
              if (!("error" in r && r.error)) {
                setAddUrl("");
                setAddLabel("");
                setAddFokus(false);
              }
              return r;
            })
          }
        >
          Aufnehmen
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="muted small">Noch niemand auf der Watchlist. Im Chat geht es auch: „Setz Anna Meier auf die Watchlist“.</p>
      ) : (
        <table className="radar-table wl__tabelle">
          <thead>
            <tr>
              <th>Person</th>
              <th>Fokus</th>
              <th>Aktiv</th>
              <th>Letzte Prüfung</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.profileUrl}>
                <td>
                  <div className="radar-name">{e.label}</div>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {e.profileUrl.replace("https://www.linkedin.com", "")}
                    {e.companyId ? " · verknüpft" : ""}
                  </span>
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={e.fokus}
                    disabled={busy}
                    onChange={(ev) => void run(() => window.api.linkedin.watchlist.setFokus(e.profileUrl, ev.target.checked))}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={e.aktiv}
                    disabled={busy}
                    onChange={(ev) => void run(() => window.api.linkedin.watchlist.setAktiv(e.profileUrl, ev.target.checked))}
                  />
                </td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {e.lastCheckedAt ? new Date(e.lastCheckedAt).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" }) : "—"}
                </td>
                <td>
                  <button
                    type="button"
                    className="link danger"
                    disabled={busy}
                    onClick={() => void run(() => window.api.linkedin.watchlist.remove(e.profileUrl))}
                  >
                    Entfernen
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ---- Automatik ----------------------------------------------------- */}
      <h4 className="wl__titel">Automatik</h4>
      <div className="wl__zeile">
        <label className="field-inline">
          <input
            type="checkbox"
            checked={cfg.enabled}
            disabled={busy || !zugang}
            onChange={(e) => setzeConfig({ enabled: e.target.checked })}
          />
          <span>Regelmäßig prüfen</span>
        </label>
        <select
          value={cfg.intervalHours}
          disabled={busy}
          onChange={(e) => setzeConfig({ intervalHours: Number(e.target.value) === 168 ? 168 : 24 })}
        >
          <option value={24}>täglich</option>
          <option value={168}>wöchentlich</option>
        </select>
        <label className="field-inline" title="Items je Person und Lauf — steuert deine Apify-Kosten">
          <span className="muted small">Items je Person</span>
          <input
            type="number"
            min={1}
            max={100}
            value={cfg.maxItemsPerProfile}
            disabled={busy}
            style={{ width: 64 }}
            onChange={(e) => setzeConfig({ maxItemsPerProfile: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className="btn"
          disabled={busy || !zugang || state.running}
          onClick={() => void run(() => window.api.linkedin.watchlist.runNow())}
        >
          {state.running ? "Läuft…" : "Jetzt prüfen"}
        </button>
      </div>

      {/* ---- Erweitert (selten gebraucht, deshalb zu) ---------------------- */}
      <details className="wl__erweitert">
        <summary className="muted small">Erweitert: Bestands-Rotation, Kontakt-Suchfenster, Actor-Kennungen</summary>
        <label className="field-inline" title="Zusätzlich zur Watchlist rotieren pro Lauf einige Kontakte aus deinem gesamten Firmen-Bestand (am längsten ungeprüft zuerst) — kostet entsprechend mehr Items">
          <input
            type="checkbox"
            checked={cfg.bestandRotationEnabled === true}
            disabled={busy || !zugang}
            onChange={(e) => setzeConfig({ bestandRotationEnabled: e.target.checked })}
          />
          <span>Bestands-Rotation: auch Kontakte aller verarbeiteten Firmen gelegentlich prüfen</span>
        </label>
        {cfg.bestandRotationEnabled === true && (
          <label className="field-inline wl__eingerueckt">
            <span className="muted small">Kontakte je Lauf</span>
            <input
              type="number"
              min={1}
              max={50}
              value={cfg.maxBestandPerRun ?? 5}
              disabled={busy}
              style={{ width: 64 }}
              onChange={(e) => setzeConfig({ maxBestandPerRun: Number(e.target.value) })}
            />
          </label>
        )}
        <label
          className="field-inline"
          title="Wie viele Profile die Kontakt-Verarbeitung je Firma maximal vom LinkedIn-Firmenprofil bezieht. Persistiert werden die relevantesten nach Rollen-Ranking."
        >
          <span className="muted small">Kontakt-Suchfenster je Firma</span>
          <input
            type="number"
            min={25}
            max={1000}
            step={25}
            value={cfg.companyWindow ?? 100}
            disabled={busy || !zugang}
            style={{ width: 72 }}
            onChange={(e) => setzeConfig({ companyWindow: Number(e.target.value) })}
          />
          <span className="muted small">
            Profile · im Extremfall ~
            {(((cfg.companyWindow ?? 100) * 4) / 1000).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            {" $ je Firmenlauf (4 $ je 1.000 Profile)"}
          </span>
        </label>
        <div className="wl__zeile">
          <label className="field-inline">
            <span className="muted small">Reactions-Actor</span>
            <input
              className="telegram-input"
              value={cfg.reactionsActorId}
              disabled={busy}
              title="Reactions-Actor (Apify, Tilde-Form)"
              onChange={(e) => setzeConfig({ reactionsActorId: e.target.value })}
            />
          </label>
          <label className="field-inline">
            <span className="muted small">Comments-Actor</span>
            <input
              className="telegram-input"
              value={cfg.commentsActorId}
              disabled={busy}
              title="Comments-Actor (leer = Kommentare überspringen)"
              onChange={(e) => setzeConfig({ commentsActorId: e.target.value })}
            />
          </label>
        </div>
      </details>

      <p className="muted small wl__datenschutz">
        Beobachtet wird nur <strong>öffentliche</strong> Aktivität (Reaktionen, Kommentare). Du bist datenschutzrechtlich
        verantwortlich: nur Personen mit geschäftlichem Bezug, Information spätestens beim ersten Kontakt (Art. 14 DSGVO).
        Sichtungen verfallen nach 90 Tagen; alles bleibt lokal auf deinem Rechner.
      </p>

      {notice && <p className="muted small" style={{ marginTop: 8 }}>{notice}</p>}
    </div>
  );
}
