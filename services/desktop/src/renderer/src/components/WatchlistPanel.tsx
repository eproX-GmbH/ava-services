// WL4 (PLAN_LINKEDIN_WATCHLIST.md §4.5) — Personen-Watchlist-Panel.
//
// Gerendert in der LinkedIn-Route. BYOK: der Apify-Token wird nur
// GESETZT, nie angezeigt (hasKey). Datenschutz-Einordnung (§5) steht
// sichtbar im Panel, nicht nur in der Doku.

import { useCallback, useEffect, useState } from "react";

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
    lastRunAt: string | null;
    lastOutcome: string | null;
  };
  hasKey?: boolean;
  running?: boolean;
  monthItems?: number;
  limits?: { maxEintraege: number; maxFokus: number } | null;
  entries?: WlEntry[];
}

export function WatchlistPanel(): JSX.Element {
  const [state, setState] = useState<WlState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
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

  return (
    <div className="ct-card" style={{ padding: "1rem", marginTop: "1.5rem" }}>
      <h3 style={{ marginTop: 0 }}>Personen-Watchlist</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Beobachtet die <strong>öffentliche</strong> LinkedIn-Aktivität deiner
        Ansprechpartner (Reaktionen, Kommentare) über deinen eigenen
        Apify-Zugang und meldet relevante Signale. Du bist dabei
        datenschutzrechtlich Verantwortlicher: Beobachte nur Personen mit
        geschäftlichem Bezug, informiere spätestens bei der ersten
        Kontaktaufnahme (Art. 14 DSGVO). Sichtungen verfallen nach 90 Tagen;
        alles bleibt lokal auf deinem Rechner.
      </p>

      {gesperrt && (
        <p className="radar-lockbanner">
          🔒 Die Personen-Watchlist ist ab dem <strong>Starter-Plan</strong>{" "}
          enthalten (25 Personen, 5 im Fokus) — Einstellungen → Abo.
        </p>
      )}

      {!gesperrt && (
        <>
          {/* Key */}
          {!state.hasKey ? (
            <div className="telegram-row">
              <input
                type="password"
                className="telegram-input"
                placeholder="Apify-API-Token (apify.com → Settings → Integrations)"
                value={keyInput}
                disabled={busy}
                onChange={(e) => setKeyInput(e.target.value)}
              />
              <button
                type="button"
                className="btn"
                disabled={busy || keyInput.trim().length < 10}
                onClick={() =>
                  void run(async () => {
                    const r = await window.api.linkedin.watchlist.setKey(keyInput);
                    if (r.ok) setKeyInput("");
                    return r.ok ? "Token gespeichert." : { error: r.error };
                  })
                }
              >
                Speichern
              </button>
            </div>
          ) : (
            <div className="telegram-row">
              <span className="pill pill--connected">Apify-Token hinterlegt</span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await window.api.linkedin.watchlist.verifyKey();
                    return r.ok
                      ? `✓ ${r.detail ?? "Token gültig"}`
                      : { error: r.detail ?? "Token ungültig" };
                  })
                }
              >
                Key testen
              </button>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() =>
                  void run(() => window.api.linkedin.watchlist.clearKey())
                }
              >
                Token löschen
              </button>
            </div>
          )}

          {/* Automatik */}
          <label className="field-inline">
            <input
              type="checkbox"
              checked={cfg.enabled}
              disabled={busy || !state.hasKey}
              onChange={(e) =>
                void run(() =>
                  window.api.linkedin.watchlist.setConfig({
                    enabled: e.target.checked,
                  }),
                )
              }
            />
            <span>
              Automatik {state.hasKey ? "" : "(erst Token hinterlegen)"}
            </span>
          </label>
          <div className="telegram-row">
            <select
              value={cfg.intervalHours}
              disabled={busy}
              onChange={(e) =>
                void run(() =>
                  window.api.linkedin.watchlist.setConfig({
                    intervalHours: Number(e.target.value) === 168 ? 168 : 24,
                  }),
                )
              }
            >
              <option value={24}>täglich</option>
              <option value={168}>wöchentlich</option>
            </select>
            <label className="field-inline" title="Items je Person und Lauf — steuert deine Apify-Kosten">
              <span className="muted" style={{ fontSize: 12 }}>Items/Person:</span>
              <input
                type="number"
                min={1}
                max={100}
                value={cfg.maxItemsPerProfile}
                disabled={busy}
                style={{ width: 64 }}
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.watchlist.setConfig({
                      maxItemsPerProfile: Number(e.target.value),
                    }),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="proc-toggle"
              disabled={busy || !state.hasKey || state.running}
              onClick={() => void run(() => window.api.linkedin.watchlist.runNow())}
            >
              {state.running ? "Läuft…" : "Jetzt prüfen"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {cfg.lastRunAt
              ? `Letzter Lauf ${new Date(cfg.lastRunAt).toLocaleString("de-DE")}: ${cfg.lastOutcome ?? ""}`
              : "Noch kein Lauf."}
            {" · "}Verbrauch diesen Monat: {state.monthItems ?? 0} Items
            {limits ? ` · Plätze: ${entries.length}/${limits.maxEintraege} (Fokus ${entries.filter((e) => e.fokus).length}/${limits.maxFokus})` : ""}
          </p>

          {/* v0.1.479 — Bestands-Rotation: alle verarbeiteten Firmen
              wenigstens ab und zu beobachten. */}
          <label className="field-inline" title="Zusätzlich zur Watchlist rotieren pro Lauf einige Kontakte aus deinem gesamten Firmen-Bestand (am längsten ungeprüft zuerst) — kostet entsprechend mehr Items">
            <input
              type="checkbox"
              checked={cfg.bestandRotationEnabled === true}
              disabled={busy || !state.hasKey}
              onChange={(e) =>
                void run(() =>
                  window.api.linkedin.watchlist.setConfig({
                    bestandRotationEnabled: e.target.checked,
                  }),
                )
              }
            />
            <span>
              Bestands-Rotation: auch Kontakte aller verarbeiteten Firmen
              gelegentlich prüfen
            </span>
          </label>
          {cfg.bestandRotationEnabled === true && (
            <label className="field-inline" style={{ marginLeft: 24 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                Kontakte pro Lauf:
              </span>
              <input
                type="number"
                min={1}
                max={50}
                value={cfg.maxBestandPerRun ?? 5}
                disabled={busy}
                style={{ width: 64 }}
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.watchlist.setConfig({
                      maxBestandPerRun: Number(e.target.value),
                    }),
                  )
                }
              />
            </label>
          )}

          <details style={{ marginBottom: 8 }}>
            <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
              Actor-Konfiguration (für Fortgeschrittene)
            </summary>
            <div className="telegram-row" style={{ marginTop: 6 }}>
              <input
                className="telegram-input"
                value={cfg.reactionsActorId}
                disabled={busy}
                title="Reactions-Actor (Apify, Tilde-Form)"
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.watchlist.setConfig({
                      reactionsActorId: e.target.value,
                    }),
                  )
                }
              />
              <input
                className="telegram-input"
                value={cfg.commentsActorId}
                disabled={busy}
                title="Comments-Actor (leer = Kommentare überspringen)"
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.watchlist.setConfig({
                      commentsActorId: e.target.value,
                    }),
                  )
                }
              />
            </div>
          </details>

          {/* Hinzufuegen */}
          <div className="telegram-row">
            <input
              className="telegram-input"
              placeholder="https://www.linkedin.com/in/…"
              value={addUrl}
              disabled={busy}
              onChange={(e) => setAddUrl(e.target.value)}
            />
            <input
              className="telegram-input"
              placeholder="Name"
              style={{ maxWidth: 180 }}
              value={addLabel}
              disabled={busy}
              onChange={(e) => setAddLabel(e.target.value)}
            />
            <label className="field-inline" style={{ whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={addFokus}
                onChange={(e) => setAddFokus(e.target.checked)}
              />
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

          {/* Liste */}
          {entries.length > 0 && (
            <table className="radar-table" style={{ marginTop: 8 }}>
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
                        onChange={(ev) =>
                          void run(() =>
                            window.api.linkedin.watchlist.setFokus(
                              e.profileUrl,
                              ev.target.checked,
                            ),
                          )
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={e.aktiv}
                        disabled={busy}
                        onChange={(ev) =>
                          void run(() =>
                            window.api.linkedin.watchlist.setAktiv(
                              e.profileUrl,
                              ev.target.checked,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {e.lastCheckedAt
                        ? new Date(e.lastCheckedAt).toLocaleString("de-DE")
                        : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="link danger"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            window.api.linkedin.watchlist.remove(e.profileUrl),
                          )
                        }
                      >
                        Entfernen
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
      {notice && <p className="muted" style={{ marginTop: 8 }}>{notice}</p>}
    </div>
  );
}
