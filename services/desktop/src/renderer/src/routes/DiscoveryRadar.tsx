// Phase 3 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Radar.
//
// Kandidaten-Tabelle (Zielbild A10): alle OFFENEN Discovery-Kandidaten,
// heisseste zuerst (ICP-Match-Score + Warum-Kurztext), Checkbox-Auswahl
// → Bulk-Import (volle Pipeline, eine Transaktion) ODER Ignorieren.
// Entschiedene Firmen verschwinden aus der Tabelle.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

interface RadarRow {
  discoveryId: string;
  name: string;
  ort: string | null;
  plz: string | null;
  website: string;
  kategorie: string | null;
  quelle: string;
  bereitsInAva: boolean;
  profiliert: boolean;
  matchScore: number | null;
  matchBegruendung: string | null;
}

export function DiscoveryRadar(): JSX.Element {
  const [rows, setRows] = useState<RadarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"decide" | "match" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastImportTx, setLastImportTx] = useState<string | null>(null);
  const [icpGesetzt, setIcpGesetzt] = useState<boolean>(true);
  const [radarConfig, setRadarConfig] = useState<{
    enabled: boolean;
    intervalHours: 24 | 168;
    lastRunAt: string | null;
    lastOutcome: string | null;
  } | null>(null);
  const [radarRunning, setRadarRunning] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, icp, cfg] = await Promise.all([
        window.api.discovery.candidates(),
        window.api.discovery.getIcp(),
        window.api.discovery.getRadarConfig(),
      ]);
      setIcpGesetzt(icp.gesetzt);
      setRadarConfig(cfg);
      if (!r.ok || !r.candidates) {
        setError(r.error ?? "Kandidaten konnten nicht geladen werden.");
        setRows([]);
      } else {
        setRows(r.candidates);
        setSelected((prev) => {
          const ids = new Set(r.candidates!.map((c) => c.discoveryId));
          return new Set([...prev].filter((id) => ids.has(id)));
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.discoveryId)));
  };

  const decide = async (decision: "imported" | "dismissed"): Promise<void> => {
    if (selected.size === 0 || busy) return;
    setBusy("decide");
    setNotice(null);
    setLastImportTx(null);
    try {
      const result = await window.api.discovery.decide(
        [...selected].map((discoveryId) => ({ discoveryId, decision })),
      );
      if ("error" in result) {
        setNotice(result.error);
      } else {
        const parts: string[] = [];
        if (result.importiert > 0)
          parts.push(`${result.importiert} Firmen importiert — Verarbeitung läuft`);
        if (result.ignoriert > 0) parts.push(`${result.ignoriert} ignoriert`);
        if (result.ohneOrt.length > 0)
          parts.push(
            `nicht importierbar (kein Ort): ${result.ohneOrt.join(", ")}`,
          );
        setNotice(parts.join(" · ") || "Keine Änderung.");
        setLastImportTx(result.transactionId);
        setSelected(new Set());
        await reload();
      }
    } finally {
      setBusy(null);
    }
  };

  const runMatch = async (): Promise<void> => {
    if (busy) return;
    setBusy("match");
    setNotice(null);
    try {
      const result = await window.api.discovery.match();
      if ("error" in result) {
        setNotice(result.error);
      } else {
        setNotice(
          `Match abgeschlossen: ${result.bewertet} von ${result.kandidatenMitProfil} profilierten Kandidaten bewertet.` +
            (result.hinweise.length > 0 ? ` ${result.hinweise.join(" ")}` : ""),
        );
        await reload();
      }
    } finally {
      setBusy(null);
    }
  };

  const hotCount = useMemo(
    () => rows.filter((r) => (r.matchScore ?? 0) >= 70).length,
    [rows],
  );

  return (
    <div className="radar-page">
      <div className="radar-head">
        <div>
          <h1>Firmen-Radar</h1>
          <p className="radar-sub">
            Neue Firmen aus deiner Region, die noch nicht in AVA sind —
            heißeste Kandidaten oben. Import startet die volle Verarbeitung,
            Ignorieren blendet dauerhaft aus.
          </p>
        </div>
        <div className="radar-actions">
          <Link to="/icp-assistent" className="proc-toggle radar-icplink">
            ICP bearbeiten
          </Link>
          <button
            className="proc-toggle"
            onClick={() => void reload()}
            disabled={loading || busy !== null}
          >
            Aktualisieren
          </button>
          <button
            className="proc-toggle"
            onClick={() => void runMatch()}
            disabled={busy !== null || !icpGesetzt}
            title={
              icpGesetzt
                ? "Profilierte Kandidaten gegen dein ICP bewerten"
                : "Erst ICP festlegen (im Chat beschreiben)"
            }
          >
            {busy === "match" ? "Matcht…" : "ICP-Match aktualisieren"}
          </button>
        </div>
      </div>

      {radarConfig && (
        <div className="radar-auto">
          <label className="radar-auto-toggle">
            <input
              type="checkbox"
              checked={radarConfig.enabled}
              onChange={(e) =>
                void window.api.discovery
                  .setRadarConfig({ enabled: e.target.checked })
                  .then((c) => setRadarConfig(c))
              }
            />
            <strong>Automatik</strong> — Radar läuft selbstständig
          </label>
          <select
            value={radarConfig.intervalHours}
            disabled={!radarConfig.enabled}
            onChange={(e) =>
              void window.api.discovery
                .setRadarConfig({
                  intervalHours: Number(e.target.value) === 168 ? 168 : 24,
                })
                .then((c) => setRadarConfig(c))
            }
          >
            <option value={24}>täglich</option>
            <option value={168}>wöchentlich</option>
          </select>
          <button
            className="proc-toggle"
            disabled={radarRunning || busy !== null || !icpGesetzt}
            onClick={() => {
              setRadarRunning(true);
              setNotice(null);
              void window.api.discovery
                .radarRunNow()
                .then((r) => {
                  setNotice(r.outcome ?? r.error ?? null);
                  return reload();
                })
                .finally(() => setRadarRunning(false));
            }}
            title="Voller Lauf: Scan → Profile → Match → Alerts (dauert einige Minuten)"
          >
            {radarRunning ? "Radar läuft…" : "Jetzt komplett laufen lassen"}
          </button>
          <span className="radar-auto-meta">
            {radarConfig.lastRunAt
              ? `Letzter Lauf: ${new Date(radarConfig.lastRunAt).toLocaleString("de-DE")}${radarConfig.lastOutcome ? ` — ${radarConfig.lastOutcome}` : ""}`
              : "Noch kein Lauf."}
          </span>
        </div>
      )}

      {!icpGesetzt && (
        <div className="radar-hint">
          Für die Priorisierung fehlt dein <strong>Idealkundenprofil</strong> —{" "}
          <Link to="/icp-assistent">jetzt einrichten</Link> (Formular) oder
          einfach im <Link to="/chat">Chat</Link> beschreiben, welche Firmen
          deine perfekten Kunden sind.
        </div>
      )}
      {notice && (
        <div className="radar-notice">
          {notice}
          {lastImportTx && (
            <>
              {" "}
              <Link to={`/transactions/${lastImportTx}`}>Zum Vorgang</Link>
            </>
          )}
        </div>
      )}
      {error && <div className="radar-error">{error}</div>}

      {selected.size > 0 && (
        <div className="radar-bulkbar">
          <span>{selected.size} ausgewählt</span>
          <button
            className="proc-toggle radar-import"
            onClick={() => void decide("imported")}
            disabled={busy !== null}
          >
            {busy === "decide" ? "Läuft…" : `Importieren (${selected.size})`}
          </button>
          <button
            className="proc-toggle"
            onClick={() => void decide("dismissed")}
            disabled={busy !== null}
          >
            Ignorieren ({selected.size})
          </button>
        </div>
      )}

      {loading ? (
        <div className="radar-empty">Lade Kandidaten…</div>
      ) : rows.length === 0 ? (
        <div className="radar-empty">
          Keine offenen Kandidaten. Starte im <Link to="/chat">Chat</Link>{" "}
          einen Scan: <em>„Finde neue Firmen im Umkreis von 30 km um …"</em> —
          danach Mini-Profile erstellen lassen und hier priorisieren.
        </div>
      ) : (
        <>
          <div className="radar-meta">
            {rows.length} offene Kandidaten
            {hotCount > 0 ? ` · ${hotCount} heiß (Score ≥ 70)` : ""}
          </div>
          <div className="radar-tablewrap">
            <table className="radar-table">
              <thead>
                <tr>
                  <th className="radar-check">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      aria-label="Alle auswählen"
                    />
                  </th>
                  <th>Firma</th>
                  <th>Ort</th>
                  <th>Kategorie</th>
                  <th>Score</th>
                  <th>Warum passt sie?</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.discoveryId}
                    className={
                      (r.matchScore ?? 0) >= 70 ? "radar-row radar-hot" : "radar-row"
                    }
                  >
                    <td className="radar-check">
                      <input
                        type="checkbox"
                        checked={selected.has(r.discoveryId)}
                        onChange={() => toggle(r.discoveryId)}
                        aria-label={`${r.name} auswählen`}
                      />
                    </td>
                    <td>
                      <div className="radar-name">
                        {r.name}
                        {r.bereitsInAva && (
                          <span
                            className="radar-badge radar-known"
                            title="Diese Firma ist in AVA bereits bekannt"
                          >
                            bekannt
                          </span>
                        )}
                      </div>
                      <button
                        className="radar-domain"
                        onClick={() =>
                          void window.api.shell.openExternal(`https://${r.website}`)
                        }
                        title={`https://${r.website} im Browser öffnen`}
                      >
                        {r.website}
                      </button>
                    </td>
                    <td>{[r.plz, r.ort].filter(Boolean).join(" ") || "—"}</td>
                    <td>{r.kategorie ?? "—"}</td>
                    <td>
                      {r.matchScore !== null ? (
                        <span
                          className={
                            r.matchScore >= 70
                              ? "radar-score radar-score-hot"
                              : r.matchScore >= 40
                                ? "radar-score radar-score-mid"
                                : "radar-score radar-score-low"
                          }
                        >
                          {r.matchScore}
                        </span>
                      ) : r.profiliert ? (
                        <span className="radar-score radar-score-none" title="Noch nicht gematcht — „ICP-Match aktualisieren“">
                          –
                        </span>
                      ) : (
                        <span
                          className="radar-score radar-score-none"
                          title="Noch kein Mini-Profil — im Chat „Erstelle Mini-Profile“"
                        >
                          ⧗
                        </span>
                      )}
                    </td>
                    <td className="radar-why" title={r.matchBegruendung ?? undefined}>
                      {r.matchBegruendung ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
