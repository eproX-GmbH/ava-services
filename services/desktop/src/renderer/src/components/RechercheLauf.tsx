// Manueller Recherche-Lauf je Firma (2026-09-24): Stellenanzeigen oder
// Ausschreibungen/Expansion gezielt anstossen — Standard oder Deep Research —
// unabhaengig von der globalen Stufe in den Einstellungen. Ohne OpenAI-
// Schluessel (eigener oder Organisation) gibt es statt der Knoepfe den
// Hinweis auf die Einstellungen; Deep Research ist komplett an OpenAI
// verdrahtet.

import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";

export type RechercheFeature = "jobs" | "expansion";
type Stand = { state: string | null; updatedAt: string | null; errorMessage: string | null };

const FEATURE_TEXT: Record<RechercheFeature, string> = { jobs: "Stellenanzeigen", expansion: "Ausschreibungen, Expansion & Beschaffung" };
const POLL_MS = 10_000;
const MAX_WAIT_MS = 35 * 60 * 1000;

export function RechercheLaufKnoepfe({ companyId, feature, kompakt = false }: { companyId: string; feature: RechercheFeature; kompakt?: boolean }) {
  const qc = useQueryClient();
  const stand = useQuery({
    queryKey: ["research", "manuellerStand"],
    queryFn: () => window.api.research.manuellerStand(),
    staleTime: 60_000,
  });
  const [laeuft, setLaeuft] = useState<{ seit: number; stufe: "standard" | "deep" } | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // Solange der Lauf laeuft, alle 10 s den Stand des Website-Producers holen;
  // am Ende die Website-Daten neu laden, damit die Treffer erscheinen.
  const beobachten = (seit: number): void => {
    timer.current = setTimeout(async () => {
      try {
        const s = await gatewayFetch<Stand>(`/v1/companies/${encodeURIComponent(companyId)}/research/stand`);
        const fertig = s.state !== "in_progress" && s.state !== "pending" && s.updatedAt !== null && Date.parse(s.updatedAt) >= seit - 5_000;
        if (fertig) {
          setLaeuft(null);
          setMeldung(s.state === "failed" ? `Lauf fehlgeschlagen: ${s.errorMessage ?? "unbekannter Fehler"}` : "Lauf abgeschlossen.");
          void qc.invalidateQueries({ queryKey: ["company", companyId, "website"] });
          void qc.invalidateQueries({ queryKey: ["company", companyId, "state"] });
          return;
        }
        if (Date.now() - seit > MAX_WAIT_MS) {
          setLaeuft(null);
          setMeldung("Der Lauf meldet sich nicht mehr — bitte später nachsehen.");
          return;
        }
      } catch {
        /* naechster Versuch */
      }
      beobachten(seit);
    }, POLL_MS);
  };

  const starten = async (stufe: "standard" | "deep"): Promise<void> => {
    const quelle = stand.data?.quelle === "organisation" ? "über den OpenAI-Schlüssel deiner Organisation (Verbrauch wird ihr zugerechnet)" : "über deinen eigenen OpenAI-Schlüssel";
    const kosten = stufe === "deep" ? "Deep Research: gründlicher, ca. 1–5 € je Firma, dauert mehrere Minuten." : "Standard: ca. 0,02–0,15 € je Firma, dauert etwa eine Minute.";
    if (!window.confirm(`${FEATURE_TEXT[feature]} jetzt suchen?\n\n${kosten}\nLäuft ${quelle}.`)) return;
    setMeldung(null);
    try {
      const r = await gatewayFetch<{ angestossen: boolean; grund?: string }>(`/v1/companies/${encodeURIComponent(companyId)}/research`, {
        method: "POST",
        body: { feature, stufe },
      });
      if (!r.angestossen) { setMeldung(r.grund ?? "Nicht gestartet."); return; }
      const seit = Date.now();
      setLaeuft({ seit, stufe });
      beobachten(seit);
    } catch (e) {
      setMeldung(e instanceof Error ? e.message : String(e));
    }
  };

  if (stand.isLoading) return null;
  if (!stand.data?.verfuegbar) {
    return (
      <p className="muted small rl__hinweis">
        Für die gezielte Suche fehlt ein OpenAI-Schlüssel. <Link to="/settings#provider-section">In den Einstellungen hinterlegen</Link>.
      </p>
    );
  }
  return (
    <div className={`rl ${kompakt ? "rl--kompakt" : ""}`}>
      {laeuft ? (
        <span className="rl__laeuft"><span className="rl__spinner" aria-hidden="true" /> {laeuft.stufe === "deep" ? "Deep Research läuft" : "Suche läuft"} … Ergebnisse erscheinen hier.</span>
      ) : (
        <>
          <button type="button" className="btn small" onClick={() => void starten("standard")} title="Günstige Suche, ca. 0,02–0,15 € je Firma">Jetzt suchen</button>
          <button type="button" className="btn small" onClick={() => void starten("deep")} title="Deep Research, gründlicher, ca. 1–5 € je Firma">Deep Research</button>
          <span className="muted small">{stand.data.quelle === "organisation" ? "über den Schlüssel der Organisation" : "über deinen OpenAI-Schlüssel"}</span>
        </>
      )}
      {meldung && <span className="small rl__meldung">{meldung}</span>}
    </div>
  );
}

/** Block in der Uebersicht: beide Funktionen, auch wenn noch nichts gefunden wurde. */
export function RechercheBlock({ companyId }: { companyId: string }) {
  return (
    <section className="rl-block">
      <h3 className="rl-block__titel">Gezielte Recherche</h3>
      <p className="muted small" style={{ marginTop: 0 }}>Für diese Firma jetzt suchen lassen, unabhängig von der globalen Einstellung.</p>
      <dl className="rl-block__liste">
        <dt>Ausschreibungen, Expansion &amp; Beschaffung</dt>
        <dd><RechercheLaufKnoepfe companyId={companyId} feature="expansion" kompakt /></dd>
        <dt>Stellenanzeigen</dt>
        <dd><RechercheLaufKnoepfe companyId={companyId} feature="jobs" kompakt /></dd>
      </dl>
    </section>
  );
}
