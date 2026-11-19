// §8 Personen-Radar (PLAN_LINKEDIN_WATCHLIST.md) — Quellen-UI (PR4).
//
// Quellen v1: konkrete Post-URLs. Wer darauf reagiert/kommentiert,
// wird zur Firma aufgeloest und landet als Kandidat im
// normalen Firmen-Radar. Teilt sich den Apify-Key mit der Watchlist.

import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { linkedinLimitSicherstellen } from "./LinkedinLimitDialog";
import { bestaetigen } from "./Bestaetigung";

interface PrState {
  error?: string;
  config?: {
    enabled: boolean;
    postUrls: string[];
    intervalHours: 24 | 168;
    maxItemsPerPost: number;
    lastRunAt: string | null;
    lastOutcome: string | null;
    postStand?: Record<string, { vollGeladenAt: string | null; letzterAbrufAt: string | null }>;
  };
  offen?: Record<string, number>;
  fortschritt?: { phase: "kommentare" | "zuordnen"; gesamt: number; erledigt: number; leads: number; seit: string } | null;
  hasKey?: boolean;
  apifyVerfuegbar?: boolean;
  running?: boolean;
  unklar?: Array<{
    profileUrl: string;
    name: string | null;
    headline: string | null;
    grund: string | null;
    firstSeen: string;
  }>;
}

/** PM-2026-0052 — alle Kommentare eines Posts nachladen, mit Kostenhinweis vorab. */
export async function kommentareNachladen(postUrl: string): Promise<string | null> {
  const hinweis = await window.api.linkedin.personenRadar.nachladenHinweis(postUrl);
  const ok = await bestaetigen({ titel: "Alle Kommentare nachladen?", text: hinweis, bestaetigen: "Nachladen" });
  if (!ok) return null;
  return window.api.linkedin.personenRadar.nachladen(postUrl);
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
  // PM-2026-0053: waehrend eines Laufs den Stand alle paar Sekunden nachladen.
  useEffect(() => {
    if (!state?.running) return;
    const t = setInterval(() => void reload(), 4000);
    return () => clearInterval(t);
  }, [state?.running, reload]);

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
    <div className="ct-card wl">
      <p className="muted small">
        AVA löst reagierende Personen zu ihrer Firma auf — über Berufserfahrung und
        Unternehmensseite, nie geraten. Jede Person erscheint mit Anlass, Kommentar und
        Firma im Reiter „Leads“; der Firmen-Radar bleibt davon unberührt.
      </p>

      {!(state.apifyVerfuegbar ?? state.hasKey) ? (
        <p className="wl__hinweis">
          Der Apify-Zugang wird von AVA zentral bereitgestellt und ist gerade nicht erreichbar.
          Bitte anmelden bzw. später erneut versuchen.
        </p>
      ) : (
        <>
          <h4 className="wl__titel">Beobachtete Posts</h4>
          <label className="field" style={{ display: "block" }}>
            <span className="muted small">
              Eine URL je Zeile — z. B. deine eigenen Posts oder relevante Branchen-Posts.
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

          {cfg.postUrls.length > 0 && (
            <ul className="wl__posts" style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
              {cfg.postUrls.map((u) => {
                const stand = cfg.postStand?.[u];
                const offen = state.offen?.[u] ?? 0;
                return (
                  <li key={u} style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "space-between", minWidth: 0 }}>
                    <span className="muted small" style={{ flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={u}>
                      {u.replace(/^https?:\/\/(www\.)?linkedin\.com\//, "").split("?")[0]}
                      {" · "}
                      {stand?.vollGeladenAt ? `alle Kommentare geholt am ${new Date(stand.vollGeladenAt).toLocaleDateString("de-DE")}` : "nur die ersten Kommentare"}
                      {offen > 0 ? ` · ${offen} warten auf Zuordnung` : ""}
                    </span>
                    <button type="button" className="btn" style={{ flexShrink: 0 }} disabled={busy || state.running} onClick={() => void run(() => kommentareNachladen(u))}>
                      {stand?.vollGeladenAt ? (offen > 0 ? "Weiter zuordnen" : "Neue nachladen") : "Alle Kommentare nachladen"}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <h4 className="wl__titel">Automatik</h4>
          <div className="wl__zeile">
            <label className="field-inline">
              <input
                type="checkbox"
                checked={cfg.enabled}
                disabled={busy || cfg.postUrls.length === 0}
                onChange={(e) => {
                  const an = e.target.checked;
                  void (async () => {
                    // P6: Beobachtung nach Verbrauch braucht ein Monatslimit.
                    if (an && !(await linkedinLimitSicherstellen())) return;
                    await run(() => window.api.linkedin.personenRadar.setConfig({ enabled: an }));
                  })();
                }}
              />
              <span>Regelmäßig prüfen</span>
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
            <button
              type="button"
              className="btn"
              disabled={busy || state.running || cfg.postUrls.length === 0}
              onClick={() => void run(() => window.api.linkedin.personenRadar.runNow())}
            >
              {state.running ? "Läuft…" : "Jetzt prüfen"}
            </button>
          </div>
          {state.running && state.fortschritt && (
            <p className="small" style={{ margin: "4px 0" }}>
              {state.fortschritt.phase === "kommentare"
                ? `Läuft seit ${new Date(state.fortschritt.seit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}: Kommentare holen …`
                : `Läuft seit ${new Date(state.fortschritt.seit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}: ${state.fortschritt.erledigt} von ${state.fortschritt.gesamt} Personen zugeordnet, ${state.fortschritt.leads} Leads gespeichert`}
            </p>
          )}
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
