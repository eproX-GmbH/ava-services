import { useEffect, useState } from "react";

// v0.1.424 — Einstellungen → Modelle → Publikations-Analyse (PB1).
//
// Steuert, wie tief Jahresabschluesse (Bundesanzeiger) per LLM
// durchleuchtet werden. Default "Sparsam": nur trend-relevante Bloecke.
// "Vollstaendig" ist das alte Verhalten — jeder Block einzeln.

export function PublicationAnalysisSection(): JSX.Element {
  const [mode, setMode] = useState<"lazy" | "eager" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.api.publication.getAnalysisMode().then(setMode);
  }, []);

  const update = async (next: "lazy" | "eager"): Promise<void> => {
    setBusy(true);
    try {
      setMode(await window.api.publication.setAnalysisMode(next));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="publication-analysis" className="provider-section">
      <h3>Publikations-Analyse</h3>
      <p className="muted">
        Wie gründlich sollen Jahresabschlüsse (Bundesanzeiger) analysiert
        werden? Große Abschlüsse haben über 1.000 Textblöcke — im Modus
        „Vollständig" geht <strong>jeder</strong> einzeln durchs KI-Modell.
        Da die Daten bei Veröffentlichung meist 1–2 Jahre alt sind, reicht
        für die Trend-Erkennung fast immer der sparsame Modus.
      </p>
      <label className="field-inline">
        <input
          type="radio"
          name="pub-analysis"
          checked={mode === "lazy"}
          disabled={busy || mode === null}
          onChange={() => void update("lazy")}
        />
        <span>
          <strong>Sparsam</strong> (empfohlen) — nur Lagebericht, Prognosen,
          Risiken und Bilanz-Tabellen werden analysiert (~2 % der Kosten).
          Trend-Aussagen und Kennzahlen des aktuellen Jahres bleiben erhalten.
        </span>
      </label>
      <label className="field-inline">
        <input
          type="radio"
          name="pub-analysis"
          checked={mode === "eager"}
          disabled={busy || mode === null}
          onChange={() => void update("eager")}
        />
        <span>
          <strong>Vollständig</strong> — jeder Block, auch historische
          Jahres-KPIs. Deutlich teurer und langsamer; sinnvoll, wenn jedes
          Detail der Abschlüsse vorab extrahiert sein soll.
        </span>
      </label>
      <p className="muted small">
        Die Änderung gilt für künftige Verarbeitungen; der Dienst startet
        automatisch neu.
      </p>
    </section>
  );
}
