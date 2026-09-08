// Phase 3 Firmen-Discovery (docs/PLAN_FIRMEN_DISCOVERY.md) — Radar.
//
// Kandidaten-Tabelle (Zielbild A10): alle OFFENEN Discovery-Kandidaten,
// heisseste zuerst (ICP-Match-Score + Warum-Kurztext), Checkbox-Auswahl
// → Bulk-Import (volle Pipeline, eine Transaktion) ODER Ignorieren.
// Entschiedene Firmen verschwinden aus der Tabelle.

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useUsage } from "../api/usage";
import type { OrgShareRow } from "../../../shared/types";

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

/** v0.1.474 — Blur-Gate: so viele bewertete Treffer sieht der
 *  Free-Plan KLAR; der Rest ist geblurred (Score bleibt sichtbar). */
const FREE_VISIBLE_MATCHES = 2;

export function DiscoveryRadar(): JSX.Element {
  const [rows, setRows] = useState<RadarRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<"decide" | "match" | "profile" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastImportTx, setLastImportTx] = useState<string | null>(null);
  const [icpGesetzt, setIcpGesetzt] = useState<boolean>(true);
  // v0.1.574 — Radar-Lauf nur mit vollstaendigem ICP.
  const [icpVollstaendig, setIcpVollstaendig] = useState<boolean>(true);
  const [icpFehlend, setIcpFehlend] = useState<string[]>([]);
  const [radarConfig, setRadarConfig] = useState<{
    enabled: boolean;
    intervalHours: 6 | 24 | 168;
    profileSofort?: boolean;
    lastRunAt: string | null;
    lastOutcome: string | null;
  } | null>(null);
  const [radarRunning, setRadarRunning] = useState(false);
  // O9 — Freigaben aus der Organisation (unabhaengig vom eigenen ICP).
  const [geteilt, setGeteilt] = useState<OrgShareRow[]>([]);
  const [shareBusy, setShareBusy] = useState<string | null>(null);
  const ladeGeteilt = async (): Promise<void> => {
    try {
      const items = await window.api.org.shares("radar_company");
      setGeteilt(items);
      for (const x of items) if (!x.seenAt) void window.api.org.markShare(x.id, "seen");
    } catch {
      setGeteilt([]);
    }
  };
  useEffect(() => {
    void ladeGeteilt();
    return window.api.org.onRequestsChanged(() => void ladeGeteilt());
  }, []);
  const teilen = async (): Promise<void> => {
    if (selected.size === 0 || busy) return;
    setBusy("decide");
    setNotice(null);
    try {
      const r = await window.api.org.shareRadar([...selected]);
      setNotice(`${r.geteilt} Firma${r.geteilt === 1 ? "" : "n"} mit der Organisation geteilt.${r.unbekannt.length ? ` ${r.unbekannt.length} unbekannt.` : ""}`);
      setSelected(new Set());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  const geteiltEntscheiden = async (x: OrgShareRow, decision: "imported" | "dismissed" | "hide"): Promise<void> => {
    setShareBusy(x.id);
    try {
      if (decision !== "hide") {
        const result = await window.api.discovery.decide([{ discoveryId: x.refId, decision }]);
        if ("error" in result) {
          setNotice(result.error);
          return;
        }
        if (decision === "imported") {
          setNotice(result.importiert > 0 ? "Firma importiert — Verarbeitung läuft" : result.ohneOrt.length > 0 ? "Nicht importierbar (kein Ort)" : "Keine Änderung.");
          setLastImportTx(result.transactionId);
        }
      }
      await window.api.org.markShare(x.id, "dismiss");
      setGeteilt((g) => g.filter((y) => y.id !== x.id));
      if (decision !== "hide") await reload();
    } finally {
      setShareBusy(null);
    }
  };

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
      setIcpVollstaendig(icp.vollstaendig !== false);
      setIcpFehlend(icp.fehlend ?? []);
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

  const runProfile = async (): Promise<void> => {
    if (busy) return;
    setBusy("profile");
    setNotice(null);
    try {
      const result = await window.api.discovery.profile();
      if ("error" in result) {
        setNotice(result.error);
      } else {
        setNotice(
          `Profil-Lauf: ${result.profiliert} von ${result.betrachtet} Kandidaten profiliert` +
            (result.crawlFehler > 0 ? `, ${result.crawlFehler} Website(s) nicht erreichbar` : "") +
            (result.llmFehler > 0 ? `, ${result.llmFehler} KI-Fehler` : "") +
            ` (${result.dauerSek}s).`,
        );
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

  // v0.1.474 — Blur-Gate fuer den Free-Plan: Matches laufen fuer alle
  // gleich oft und frisch, aber Free sieht nur die Top-Treffer klar.
  // Der Score bleibt sichtbar ("es GIBT 12 weitere ab 70"), Name,
  // Website und Begruendung sind geblurred. Reines UI-Gate.
  const usage = useUsage();
  const lockedIds = useMemo(() => {
    if (usage.data?.tier !== "free") return new Set<string>();
    const scored = rows
      .filter((r) => r.matchScore !== null)
      .sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
    return new Set(scored.slice(FREE_VISIBLE_MATCHES).map((r) => r.discoveryId));
  }, [rows, usage.data?.tier]);

  // v0.1.575 — "Alle" meint nur die frei sichtbaren Zeilen; gesperrte
  // (Free-Plan) haben ohnehin keine aktive Checkbox.
  const waehlbar = rows.filter((r) => !lockedIds.has(r.discoveryId));
  const allSelected = waehlbar.length > 0 && waehlbar.every((r) => selected.has(r.discoveryId));
  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(waehlbar.map((r) => r.discoveryId)));
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
            onClick={() => void runProfile()}
            disabled={busy !== null}
            title="Fehlende Mini-Profile jetzt erstellen (kompletter Backlog; läuft sonst automatisch im Hintergrund) — ICP-Branchen zuerst"
          >
            {busy === "profile" ? "Profiliert…" : "Mini-Profile erstellen"}
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
          <label
            className="radar-auto-toggle"
            title="Alle offenen Kandidaten so schnell wie möglich profilieren: mehr parallel, Minutentakt. Der Chat behält Vorrang. Braucht entsprechend mehr KI-Aufrufe in kurzer Zeit."
          >
            <input
              type="checkbox"
              checked={radarConfig.profileSofort === true}
              onChange={(e) =>
                void window.api.discovery
                  .setRadarConfig({ profileSofort: e.target.checked })
                  .then((c) => setRadarConfig(c))
              }
            />
            <strong>Sofortige Mini-Profil-Verarbeitung</strong> — Backlog ohne Schonung abarbeiten
          </label>
          <select
            value={radarConfig.intervalHours}
            disabled={!radarConfig.enabled}
            onChange={(e) =>
              void window.api.discovery
                .setRadarConfig({
                  intervalHours:
                    Number(e.target.value) === 168
                      ? 168
                      : Number(e.target.value) === 6
                        ? 6
                        : 24,
                })
                .then((c) => setRadarConfig(c))
            }
          >
            <option value={6}>4x täglich (Pro)</option>
            <option value={24}>täglich</option>
            <option value={168}>wöchentlich</option>
          </select>
          <button
            className="proc-toggle"
            disabled={radarRunning || busy !== null || !icpVollstaendig}
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

      {!icpGesetzt ? (
        <div className="radar-hint">
          Der Radar startet erst mit deinem <strong>Idealkundenprofil</strong> (Ort, Zielbranchen, Beschreibung) —{" "}
          <Link to="/icp-assistent">jetzt einrichten</Link> (Formular) oder
          einfach im <Link to="/chat">Chat</Link> beschreiben, welche Firmen
          deine perfekten Kunden sind.
        </div>
      ) : !icpVollstaendig ? (
        <div className="radar-hint">
          Der Radar startet erst mit vollständigem <strong>Idealkundenprofil</strong>. Es fehlt noch: {icpFehlend.join("; ")} —{" "}
          <Link to="/icp-assistent">ICP ergänzen</Link>.
        </div>
      ) : null}
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
          <button
            className="proc-toggle"
            onClick={() => void teilen()}
            disabled={busy !== null}
            title="Die ausgewählten Firmen erscheinen bei allen Mitgliedern deiner Organisation im Radar"
          >
            Mit Organisation teilen ({selected.size})
          </button>
        </div>
      )}

      {geteilt.length > 0 && (
        <section className="provider-section" style={{ marginTop: "1rem" }}>
          <h3>Von der Organisation geteilt</h3>
          <p className="muted small">
            Kolleginnen und Kollegen empfehlen dir diese Firmen. Sie erscheinen unabhängig von deinem ICP; importieren legt wie
            gewohnt einen Vorgang an.
          </p>
          <div className="org-list">
            {geteilt.map((x) => {
              const k = x.candidate;
              const ort = k ? [k.plz, k.city].filter(Boolean).join(" ") : "";
              return (
                <div key={x.id} className="org-row">
                  <div className="org-row__main">
                    <span className="org-row__title">{k?.name ?? x.refId}</span>
                    <span className="org-row__meta">
                      {[ort, k?.domain, k?.category].filter(Boolean).join(" · ")}
                      {" · geteilt von "}
                      {x.sharedByName ?? `${x.sharedBy.slice(0, 8)}…`}
                      {x.note ? ` · „${x.note}"` : ""}
                    </span>
                  </div>
                  <div className="org-row__actions">
                    <button type="button" className="primary" disabled={shareBusy !== null} onClick={() => void geteiltEntscheiden(x, "imported")}>
                      Importieren
                    </button>
                    <button type="button" className="btn" disabled={shareBusy !== null} onClick={() => void geteiltEntscheiden(x, "dismissed")}>
                      Ignorieren
                    </button>
                    <button type="button" className="btn" disabled={shareBusy !== null} onClick={() => void geteiltEntscheiden(x, "hide")} title="Nur für mich ausblenden">
                      Ausblenden
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
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
            {rows.filter((r) => !r.profiliert).length > 0
              ? ` · ${rows.filter((r) => !r.profiliert).length} ohne Mini-Profil (⧗) — „Mini-Profile erstellen" arbeitet den Rückstand in 25er-Schritten ab`
              : ""}
          </div>
          {lockedIds.size > 0 && (
            <div className="radar-lockbanner">
              🔒 {lockedIds.size} weitere bewertete Treffer{hotCount > FREE_VISIBLE_MATCHES ? ` (davon ${hotCount - FREE_VISIBLE_MATCHES} heiß)` : ""} — im{" "}
              <Link to="/settings#plan-section">Starter-Plan</Link> siehst du
              alle Namen und Begründungen. Die Scores unten zeigen, was da ist.
            </div>
          )}
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
                {rows.map((r) => {
                  const locked = lockedIds.has(r.discoveryId);
                  return (
                  <tr
                    key={r.discoveryId}
                    className={
                      ((r.matchScore ?? 0) >= 70 ? "radar-row radar-hot" : "radar-row") +
                      (locked ? " radar-locked-row" : "")
                    }
                  >
                    <td className="radar-check">
                      <input
                        type="checkbox"
                        checked={!locked && selected.has(r.discoveryId)}
                        disabled={locked}
                        onChange={() => toggle(r.discoveryId)}
                        aria-label={`${r.name} auswählen`}
                      />
                    </td>
                    <td>
                      <div className={locked ? "radar-name radar-blur" : "radar-name"}>
                        {r.name}
                        {!locked && r.bereitsInAva && (
                          <span
                            className="radar-badge radar-known"
                            title="Diese Firma ist in AVA bereits bekannt"
                          >
                            bekannt
                          </span>
                        )}
                      </div>
                      <button
                        className={locked ? "radar-domain radar-blur" : "radar-domain"}
                        disabled={locked}
                        onClick={() =>
                          locked
                            ? undefined
                            : void window.api.shell.openExternal(`https://${r.website}`)
                        }
                        title={
                          locked
                            ? "Im Starter-Plan sichtbar"
                            : `https://${r.website} im Browser öffnen`
                        }
                      >
                        {r.website}
                      </button>
                    </td>
                    <td className={locked ? "radar-blur" : undefined}>
                      {[r.plz, r.ort].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className={locked ? "radar-blur" : undefined}>{r.kategorie ?? "—"}</td>
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
                    <td
                      className={locked ? "radar-why radar-blur" : "radar-why"}
                      title={locked ? "Im Starter-Plan sichtbar" : (r.matchBegruendung ?? undefined)}
                    >
                      {r.matchBegruendung ?? "—"}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
