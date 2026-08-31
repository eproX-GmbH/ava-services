// §8 Personen-Radar (PLAN_LINKEDIN_WATCHLIST.md) — Quellen-UI (PR4).
//
// Quellen v1: konkrete Post-URLs. Wer darauf reagiert/kommentiert,
// wird (budgetiert) zur Firma aufgeloest und landet als Kandidat im
// normalen Firmen-Radar. Teilt sich den Apify-Key mit der Watchlist.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

interface PrState {
  error?: string;
  config?: {
    enabled: boolean;
    postUrls: string[];
    intervalHours: 24 | 168;
    maxItemsPerPost: number;
    maxResolvesPerRun: number;
    lastRunAt: string | null;
    lastOutcome: string | null;
  };
  hasKey?: boolean;
  running?: boolean;
  unklar?: Array<{
    profileUrl: string;
    name: string | null;
    headline: string | null;
    grund: string | null;
    firstSeen: string;
  }>;
}

export function PersonenRadarPanel(): JSX.Element {
  const [state, setState] = useState<PrState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlsText, setUrlsText] = useState("");

  const reload = useCallback(async () => {
    const s = await window.api.linkedin.personenRadar.getState();
    setState(s);
    if (s.config) setUrlsText(s.config.postUrls.join("\n"));
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const r = await fn();
      if (typeof r === "string") setNotice(r);
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

  return (
    <div className="ct-card" style={{ padding: "1rem", marginTop: "1.5rem" }}>
      <h3 style={{ marginTop: 0 }}>Personen-Radar (Engagement)</h3>
      <p className="muted" style={{ fontSize: 13 }}>
        Wer auf beobachtete LinkedIn-Posts reagiert oder kommentiert, hat
        Interesse am Thema gezeigt. AVA löst diese Personen (budgetiert) zu
        ihrer Firma auf — über die Berufserfahrung und die Website der
        Unternehmensseite, nie geraten — und legt passende Firmen als
        Kandidaten in dein <Link to="/radar">Firmen-Radar</Link>, samt
        Auslöser-Person. Kosten: ~1 Cent pro aufgelöster Person (dein
        Apify-Guthaben).
      </p>

      {!state.hasKey ? (
        <p className="muted">
          Erst den Apify-Token in der Personen-Watchlist oben hinterlegen —
          der Personen-Radar nutzt denselben Zugang.
        </p>
      ) : (
        <>
          <label className="field" style={{ display: "block" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              Beobachtete Posts (eine URL pro Zeile — z. B. deine eigenen
              Posts oder relevante Branchen-Posts):
            </span>
            <textarea
              className="telegram-input"
              style={{ width: "100%", minHeight: 80, fontFamily: "monospace", fontSize: 12 }}
              placeholder="https://www.linkedin.com/posts/…"
              value={urlsText}
              disabled={busy}
              onChange={(e) => setUrlsText(e.target.value)}
              onBlur={() =>
                void run(() =>
                  window.api.linkedin.personenRadar.setConfig({
                    postUrls: urlsText
                      .split("\n")
                      .map((l) => l.trim())
                      .filter((l) => l.includes("linkedin.com")),
                  }),
                )
              }
            />
          </label>

          <div className="telegram-row">
            <label className="field-inline">
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={busy || cfg.postUrls.length === 0}
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.personenRadar.setConfig({
                      enabled: e.target.checked,
                    }),
                  )
                }
              />
              <span>Automatik</span>
            </label>
            <select
              value={cfg.intervalHours}
              disabled={busy}
              onChange={(e) =>
                void run(() =>
                  window.api.linkedin.personenRadar.setConfig({
                    intervalHours: Number(e.target.value) === 24 ? 24 : 168,
                  }),
                )
              }
            >
              <option value={168}>wöchentlich</option>
              <option value={24}>täglich</option>
            </select>
            <label className="field-inline" title="Personen-Auflösungen je Lauf — der teuerste Schritt (~1 Cent/Person)">
              <span className="muted" style={{ fontSize: 12 }}>Auflösungen/Lauf:</span>
              <input
                type="number"
                min={1}
                max={50}
                value={cfg.maxResolvesPerRun}
                disabled={busy}
                style={{ width: 64 }}
                onChange={(e) =>
                  void run(() =>
                    window.api.linkedin.personenRadar.setConfig({
                      maxResolvesPerRun: Number(e.target.value),
                    }),
                  )
                }
              />
            </label>
            <button
              type="button"
              className="proc-toggle"
              disabled={busy || state.running || cfg.postUrls.length === 0}
              onClick={() => void run(() => window.api.linkedin.personenRadar.runNow())}
            >
              {state.running ? "Läuft…" : "Jetzt prüfen"}
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>
            {cfg.lastRunAt
              ? `Letzter Lauf ${new Date(cfg.lastRunAt).toLocaleString("de-DE")}: ${cfg.lastOutcome ?? ""}`
              : "Noch kein Lauf."}
          </p>

          {(state.unklar?.length ?? 0) > 0 && (
            <details>
              <summary className="muted" style={{ fontSize: 12, cursor: "pointer" }}>
                Ungeklärt ({state.unklar!.length}) — Personen ohne belastbare
                Firma (verfallen nach 14 Tagen)
              </summary>
              <ul style={{ fontSize: 12, margin: "6px 0" }}>
                {state.unklar!.slice(0, 20).map((u) => (
                  <li key={u.profileUrl}>
                    {u.name ?? u.profileUrl}
                    {u.headline ? ` — ${u.headline.slice(0, 60)}` : ""}
                    <span className="muted"> ({u.grund ?? "kein Beleg"})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {notice && <p className="muted" style={{ marginTop: 8 }}>{notice}</p>}
    </div>
  );
}
