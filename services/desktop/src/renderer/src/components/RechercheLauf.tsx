// Gezielte Recherche je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion anstossen, plus Protokoll (wann, was, wie viele
// Ergebnisse). Der Laufzustand kommt aus dem Protokoll des Gateways, nicht
// aus dem Seitenzustand: Nach Seitenwechsel oder Neuladen steht der
// Indikator wieder da, solange der Lauf nicht abgeschlossen ist.
//
// Seit 2026-11-02 (Vorgabe Joyce) nur Stufe Standard ueber die Betreiber-Spur:
// kein Schluessel, keine Kosten fuer den Nutzer, kein Deep-Research-Knopf.
// Alte Laeufe mit Stufe Deep bleiben im Protokoll lesbar.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { bestaetigen } from "./Bestaetigung";

export type RechercheFeature = "jobs" | "expansion" | "themen";
type Stufe = "standard" | "deep";
interface Lauf {
  id: string; feature: RechercheFeature; stufe: Stufe;
  state: "laufend" | "fertig" | "fehler" | "unbekannt";
  ergebnisse: number | null; fehler: string | null;
  gestartetAt: string; beendetAt: string | null; eigener: boolean;
}

const FEATURE_TEXT: Record<RechercheFeature, string> = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion & Beschaffung", themen: "Fokus-Themen" };
const STUFE_TEXT: Record<Stufe, string> = { standard: "Standard", deep: "Deep Research" };
const POLL_MS = 10_000;

function zeit(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function RechercheBereich({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const verlauf = useQuery({
    queryKey: ["company", companyId, "research-verlauf"],
    queryFn: () => gatewayFetch<{ items: Lauf[] }>(`/v1/companies/${encodeURIComponent(companyId)}/research/verlauf`),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((l) => l.state === "laufend") ? POLL_MS : false),
  });
  const [meldung, setMeldung] = useState<string | null>(null);
  const [offen, setOffen] = useState(false);
  const items = verlauf.data?.items ?? [];
  const laufend = (f: RechercheFeature): Lauf | undefined => items.find((l) => l.feature === f && l.state === "laufend");

  // Sobald ein Lauf endet, die Website-Daten neu laden (Treffer erscheinen).
  const [vorher, setVorher] = useState<number>(0);
  const anzahlLaufend = items.filter((l) => l.state === "laufend").length;
  useEffect(() => {
    if (vorher > 0 && anzahlLaufend < vorher) {
      void qc.invalidateQueries({ queryKey: ["company", companyId, "website"] });
    }
    setVorher(anzahlLaufend);
  }, [anzahlLaufend, vorher, qc, companyId]);

  const starten = async (feature: RechercheFeature, stufe: Stufe): Promise<void> => {
    // Seit 2026-11-02 laeuft die Suche ueber AVA (Betreiber-Spur, Stufe Standard);
    // fuer den Nutzer fallen keine Kosten an, Deep Research ist nicht mehr waehlbar.
    const frage = feature === "themen"
      ? "Fokus-Themen für diese Firma jetzt prüfen?\n\nLäuft auf deinem allgemeinen KI-Modell, etwa eine Minute."
      : `${FEATURE_TEXT[feature]} jetzt suchen?\n\nDauert etwa eine Minute, Ergebnisse erscheinen hier in der Firmenansicht.`;
    if (!(await bestaetigen({ titel: FEATURE_TEXT[feature], text: frage, bestaetigen: "Starten" }))) return;
    setMeldung(null);
    try {
      const r = await gatewayFetch<{ angestossen: boolean; grund?: string }>(`/v1/companies/${encodeURIComponent(companyId)}/research`, {
        method: "POST",
        body: { feature, stufe },
      });
      if (!r.angestossen) setMeldung(r.grund ?? "Nicht gestartet.");
      await qc.invalidateQueries({ queryKey: ["company", companyId, "research-verlauf"] });
    } catch (e) {
      setMeldung(e instanceof Error ? e.message : String(e));
    }
  };

  const zeile = (feature: RechercheFeature) => {
    const l = laufend(feature);
    if (l) {
      return (
        <span className="rl__laeuft"><span className="rl__spinner" aria-hidden="true" /> {STUFE_TEXT[l.stufe]} läuft seit {zeit(l.gestartetAt)} …</span>
      );
    }
    if (feature === "themen") {
      return (
        <button type="button" className="btn small" onClick={() => void starten("themen", "standard")} title="Deine Fokus-Themen (Einstellungen → Datenquellen) auf dieser Website prüfen">Fokus prüfen</button>
      );
    }
    return (
      <button type="button" className="btn small" onClick={() => void starten(feature, "standard")} title="Sucht im Web nach aktuellen Treffern für diese Firma">Jetzt suchen</button>
    );
  };

  return (
    <section className="rl-block panel">
      <div className="rl-block__kopf">
        <div>
          <h3 className="rl-block__titel">Gezielte Recherche</h3>
          <p className="muted small" style={{ margin: 0 }}>
            Für diese Firma jetzt suchen lassen. Läuft über AVA, ohne Kosten für dich.
          </p>
        </div>
      </div>
      <dl className="rl-block__liste">
        <dt>Ausschreibungen, Expansion &amp; Beschaffung</dt>
        <dd><div className="rl rl--kompakt">{zeile("expansion")}</div></dd>
        <dt>Stellenanzeigen</dt>
        <dd><div className="rl rl--kompakt">{zeile("jobs")}</div></dd>
        <dt>Fokus-Themen <Link to="/settings/recherche#themen-section" className="muted small">(festlegen)</Link></dt>
        <dd><div className="rl rl--kompakt">{zeile("themen")}</div></dd>
      </dl>
      {meldung && <p className="small rl__meldung">{meldung}</p>}

      <details className="bc-verlauf rl-verlauf" open={offen} onToggle={(e) => setOffen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="bc-verlauf__kopf">
            <span>Verlauf{items.length ? ` (${items.length})` : ""}</span>
            {anzahlLaufend > 0 && <span className="bc-verlauf__status"><span className="rl__spinner" aria-hidden="true" /> {anzahlLaufend === 1 ? "ein Lauf" : `${anzahlLaufend} Läufe`} aktiv</span>}
          </span>
        </summary>
        {items.length === 0 ? (
          <p className="muted small" style={{ margin: "0.4rem 0 0" }}>Noch kein Lauf für diese Firma.</p>
        ) : (
          <ul className="bc-verlauf__liste">
            {items.map((l) => (
              <li key={l.id}>
                <span className="muted small">{zeit(l.gestartetAt)}</span>
                <span className="bc-verlauf__art">{FEATURE_TEXT[l.feature]} · {STUFE_TEXT[l.stufe]}</span>
                <span className="small">
                  {l.state === "laufend" && "läuft …"}
                  {l.state === "fertig" && (l.ergebnisse === null ? "abgeschlossen" : `${l.ergebnisse} ${l.ergebnisse === 1 ? "Ergebnis" : "Ergebnisse"}${l.beendetAt ? `, ${Math.max(1, Math.round((Date.parse(l.beendetAt) - Date.parse(l.gestartetAt)) / 60000))} Min.` : ""}`)}
                  {l.state === "fehler" && <span className="rl__fehler">Fehler: {l.fehler ?? "unbekannt"}</span>}
                  {l.state === "unbekannt" && <span className="muted">keine Rückmeldung (Lauf abgebrochen?)</span>}
                  {!l.eigener && <span className="muted"> · Kollege</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </section>
  );
}
