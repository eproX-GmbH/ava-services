// Gezielte Recherche je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion anstossen — Standard oder Deep Research —
// unabhaengig von der globalen Stufe, plus Protokoll (wann, was, wie viele
// Ergebnisse). Der Laufzustand kommt aus dem Protokoll des Gateways, nicht
// aus dem Seitenzustand: Nach Seitenwechsel oder Neuladen steht der
// Indikator wieder da, solange der Lauf nicht abgeschlossen ist.
//
// Ohne OpenAI-Schluessel (eigener oder Organisation) gibt es statt der
// Knoepfe den Hinweis auf die Einstellungen; Deep Research ist komplett an
// OpenAI verdrahtet.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";

export type RechercheFeature = "jobs" | "expansion";
type Stufe = "standard" | "deep";
interface Lauf {
  id: string; feature: RechercheFeature; stufe: Stufe;
  state: "laufend" | "fertig" | "fehler" | "unbekannt";
  ergebnisse: number | null; fehler: string | null;
  gestartetAt: string; beendetAt: string | null; eigener: boolean;
}

const FEATURE_TEXT: Record<RechercheFeature, string> = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion & Beschaffung" };
const STUFE_TEXT: Record<Stufe, string> = { standard: "Standard", deep: "Deep Research" };
const POLL_MS = 10_000;

function zeit(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function RechercheBereich({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const stand = useQuery({
    queryKey: ["research", "manuellerStand"],
    queryFn: () => window.api.research.manuellerStand(),
    staleTime: 60_000,
  });
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
    const quelle = stand.data?.quelle === "organisation" ? "über den OpenAI-Schlüssel deiner Organisation (Verbrauch wird ihr zugerechnet)" : "über deinen eigenen OpenAI-Schlüssel";
    const kosten = stufe === "deep" ? "Deep Research: gründlicher, ca. 1–5 € je Firma, dauert mehrere Minuten." : "Standard: ca. 0,02–0,15 € je Firma, dauert etwa eine Minute.";
    if (!window.confirm(`${FEATURE_TEXT[feature]} jetzt suchen?\n\n${kosten}\nLäuft ${quelle}.`)) return;
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
    if (!stand.data?.verfuegbar) return <span className="muted small">Kein OpenAI-Schlüssel hinterlegt.</span>;
    return (
      <>
        <button type="button" className="btn small" onClick={() => void starten(feature, "standard")} title="Günstige Suche, ca. 0,02–0,15 € je Firma">Jetzt suchen</button>
        <button type="button" className="btn small" onClick={() => void starten(feature, "deep")} title="Deep Research, gründlicher, ca. 1–5 € je Firma">Deep Research</button>
      </>
    );
  };

  return (
    <section className="rl-block panel">
      <div className="rl-block__kopf">
        <div>
          <h3 className="rl-block__titel">Gezielte Recherche</h3>
          <p className="muted small" style={{ margin: 0 }}>
            Für diese Firma jetzt suchen lassen, unabhängig von der globalen Einstellung.
            {stand.data?.verfuegbar && <> Läuft {stand.data.quelle === "organisation" ? "über den Schlüssel der Organisation" : "über deinen OpenAI-Schlüssel"}.</>}
            {stand.data && !stand.data.verfuegbar && <> Dafür fehlt ein OpenAI-Schlüssel: <Link to="/settings#provider-section">in den Einstellungen hinterlegen</Link>.</>}
          </p>
        </div>
      </div>
      <dl className="rl-block__liste">
        <dt>Ausschreibungen, Expansion &amp; Beschaffung</dt>
        <dd><div className="rl rl--kompakt">{zeile("expansion")}</div></dd>
        <dt>Stellenanzeigen</dt>
        <dd><div className="rl rl--kompakt">{zeile("jobs")}</div></dd>
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
