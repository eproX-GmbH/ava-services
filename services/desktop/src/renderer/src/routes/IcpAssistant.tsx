// I1 ICP-Assistent (docs/PLAN_ICP_ASSISTENT.md) — Fragenkatalog-Formular.
//
// In I1 ist das der manuelle Pfad (B6: Review/Handeingabe sind dasselbe
// Formular). In I2 wird derselbe Screen vom URL-Analyse-Stepper mit dem
// generierten Entwurf vorbefuellt.

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

interface FormState {
  beschreibung: string;
  angebot: string;
  nutzen: string;
  branchen: string;
  orte: string;
  radiusKm: number;
  groesse: string;
  merkmale: string;
  ausschluesse: string;
  kundenUrls: string;
}

const EMPTY: FormState = {
  beschreibung: "",
  angebot: "",
  nutzen: "",
  branchen: "",
  orte: "",
  radiusKm: 50,
  groesse: "",
  merkmale: "",
  ausschluesse: "",
  kundenUrls: "",
};

function splitList(v: string): string[] {
  return v
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/** URL → Kern-Domain (grobe Renderer-Variante; die harte Normierung
 *  macht der Main-Prozess beim Speichern erneut). */
function toDomain(v: string): string | null {
  try {
    const u = new URL(v.startsWith("http") ? v : `https://${v}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

type Mode = "intro" | "analyzing" | "form";

export function IcpAssistant(): JSX.Element {
  const [mode, setMode] = useState<Mode>("intro");
  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [quelle, setQuelle] = useState<string | null>(null);
  // I2 — URL-Analyse.
  const [ownUrl, setOwnUrl] = useState("");
  const [customerUrls, setCustomerUrls] = useState("");
  const [progress, setProgress] = useState<
    { step: number; total: number; text: string }[]
  >([]);
  const [analysisNotes, setAnalysisNotes] = useState<string[]>([]);
  const [radiusHint, setRadiusHint] = useState<string | null>(null);
  const [showAutoCta, setShowAutoCta] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    void window.api.discovery.getIcp().then((icp) => {
      setForm({
        beschreibung: icp.beschreibung,
        angebot: icp.angebot,
        nutzen: icp.nutzen,
        branchen: icp.branchen.join(", "),
        orte: icp.orte.join(", "),
        radiusKm: icp.radiusKm,
        groesse: icp.groesse,
        merkmale: icp.merkmale.join(", "),
        ausschluesse: icp.ausschluesse,
        kundenUrls: icp.kundenBeispiele.map((k) => k.domain).join("\n"),
      });
      setQuelle(icp.quelle);
      // Existiert schon ein ICP, direkt ins Formular; sonst Intro.
      if (icp.gesetzt) setMode("form");
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    return window.api.discovery.onIcpProgress((p) => {
      setProgress((prev) => [...prev, p]);
    });
  }, []);

  const startAnalysis = async (): Promise<void> => {
    setMode("analyzing");
    setProgress([]);
    setNotice(null);
    setAnalysisNotes([]);
    setRadiusHint(null);
    const result = await window.api.discovery.icpAnalyze({
      eigeneUrl: ownUrl,
      kundenUrls: splitList(customerUrls),
    });
    if ("error" in result) {
      setNotice(result.error);
      setMode("intro");
      return;
    }
    const d = result.icp;
    setForm({
      beschreibung: d.beschreibung ?? "",
      angebot: d.angebot ?? "",
      nutzen: d.nutzen ?? "",
      branchen: (d.branchen ?? []).join(", "),
      orte: (d.orte ?? []).join(", "),
      radiusKm: d.radiusKm ?? 50,
      groesse: d.groesse ?? "",
      merkmale: (d.merkmale ?? []).join(", "),
      ausschluesse: "",
      kundenUrls: (d.kundenBeispiele ?? []).map((k) => k.domain).join("\n"),
    });
    setAnalysisNotes(result.hinweise);
    setRadiusHint(result.radiusBegruendung);
    setNotice(
      `Entwurf aus deiner Website${result.kunden.length > 0 ? ` und ${result.kunden.length} Kunden-Websites` : ""} erstellt — bitte prüfen und anpassen, gespeichert wird erst mit „ICP übernehmen“.`,
    );
    setMode("form");
  };

  const upd =
    (key: keyof FormState) =>
    (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ): void => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    };

  const save = async (): Promise<void> => {
    setSaving(true);
    setNotice(null);
    try {
      const kunden = splitList(form.kundenUrls)
        .map(toDomain)
        .filter((d): d is string => d !== null)
        .slice(0, 5)
        .map((domain) => ({ domain }));
      const saved = await window.api.discovery.setIcp({
        quelle: radiusHint !== null || analysisNotes.length > 0 ? "assistent" : "manuell",
        beschreibung: form.beschreibung,
        angebot: form.angebot,
        nutzen: form.nutzen,
        branchen: splitList(form.branchen),
        orte: splitList(form.orte),
        radiusKm: Number(form.radiusKm) || 50,
        groesse: form.groesse,
        merkmale: splitList(form.merkmale),
        ausschluesse: form.ausschluesse,
        kundenBeispiele: kunden,
      });
      if (saved.gesetzt) {
        setNotice("ICP gespeichert — der Radar nutzt es ab dem nächsten Match.");
        // I3 — Abschluss-CTA: Automatik nur anbieten, wenn sie noch aus ist.
        const cfg = await window.api.discovery.getRadarConfig();
        setShowAutoCta(cfg !== null && !cfg.enabled);
      } else {
        setNotice(
          "Gespeichert, aber noch zu dünn für den Radar: Bitte mindestens die Beschreibung oder Branchen füllen.",
        );
      }
      setQuelle(saved.quelle);
    } catch (err) {
      setNotice(
        `Speichern fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return <div className="radar-page">Lade…</div>;

  if (mode === "intro") {
    return (
      <div className="radar-page icp-page">
        <h1>Idealkundenprofil in 2 Minuten</h1>
        <p className="radar-sub">
          Keine Fragebogen-Folter: Gib nur <strong>deine Website</strong> und
          bis zu <strong>5 Websites deiner besten Kunden</strong> an — AVA
          liest daraus Angebot, Standort und was deine Top-Kunden gemeinsam
          haben, und schreibt dir einen ICP-Entwurf zum Prüfen. Die
          Kunden-Angaben bleiben ausschließlich auf deinem Rechner.
        </p>
        <div className="icp-form">
          <label className="icp-field">
            <span>Deine Website</span>
            <input
              value={ownUrl}
              onChange={(e) => setOwnUrl(e.target.value)}
              placeholder="z. B. meine-firma.de"
            />
          </label>
          <label className="icp-field">
            <span>Websites deiner besten Bestandskunden (eine pro Zeile, optional, max 5)</span>
            <textarea
              value={customerUrls}
              onChange={(e) => setCustomerUrls(e.target.value)}
              rows={5}
              placeholder={"kunde-a.de\nkunde-b.de\nkunde-c.de"}
            />
          </label>
          {notice && <div className="radar-error">{notice}</div>}
          <div className="icp-actions">
            <button
              className="proc-toggle radar-import"
              disabled={ownUrl.trim().length < 4}
              onClick={() => void startAnalysis()}
            >
              Analysieren &amp; ICP erstellen
            </button>
            <button className="proc-toggle" onClick={() => setMode("form")}>
              Lieber von Hand ausfüllen
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "analyzing") {
    const last = progress[progress.length - 1];
    return (
      <div className="radar-page icp-page">
        <h1>AVA liest mit …</h1>
        <p className="radar-sub">
          Websites werden analysiert — das dauert je nach Anzahl 1–3 Minuten.
        </p>
        <div className="icp-progress">
          {progress.map((p, i) => (
            <div
              key={i}
              className={
                i === progress.length - 1 ? "icp-step icp-step-active" : "icp-step icp-step-done"
              }
            >
              {i === progress.length - 1 ? "⏳" : "✓"} {p.text}
            </div>
          ))}
          {last && (
            <div className="icp-progress-meta">
              Schritt {last.step} von {last.total}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="radar-page icp-page">
      <h1>Idealkundenprofil (ICP)</h1>
      <p className="radar-sub">
        Beschreibe, welche Firmen deine perfekten Kunden sind — der{" "}
        <Link to="/radar">Radar</Link> priorisiert danach.
        {quelle && (
          <>
            {" "}
            Zuletzt{" "}
            {quelle === "assistent"
              ? "per Assistent erstellt"
              : quelle === "chat"
                ? "im Chat erfasst"
                : "von Hand gepflegt"}
            .
          </>
        )}{" "}
        <button className="icp-linkbtn" onClick={() => setMode("intro")}>
          Neu aus Websites erstellen
        </button>
      </p>
      {radiusHint && <div className="radar-hint">{radiusHint}</div>}
      {analysisNotes.length > 0 && (
        <div className="radar-hint">{analysisNotes.join(" ")}</div>
      )}

      <div className="icp-form">
        <label className="icp-field">
          <span>K1 · Was bietest du an? (Produkte/Leistungen)</span>
          <input value={form.angebot} onChange={upd("angebot")} maxLength={600} placeholder="z. B. RAG-Engineering und KI-Integrationen für Softwareprodukte" />
        </label>
        <label className="icp-field">
          <span>K2 · Welches Problem löst du / welcher Nutzen?</span>
          <input value={form.nutzen} onChange={upd("nutzen")} maxLength={600} placeholder="z. B. Fachwissen aus Dokumenten wird produktiv durchsuchbar" />
        </label>
        <div className="icp-row">
          <label className="icp-field">
            <span>K3/K6 · Standort(e) für den Radar</span>
            <input value={form.orte} onChange={upd("orte")} placeholder="z. B. Hannover" />
          </label>
          <label className="icp-field icp-field-narrow">
            <span>Umkreis (km)</span>
            <input
              type="number"
              min={1}
              max={200}
              value={form.radiusKm}
              onChange={(e) =>
                setForm((f) => ({ ...f, radiusKm: Number(e.target.value) }))
              }
            />
          </label>
        </div>
        <label className="icp-field">
          <span>K4 · Zielbranchen (Komma-getrennt)</span>
          <input value={form.branchen} onChange={upd("branchen")} placeholder="z. B. Maschinenbau, Logistik, Software" />
        </label>
        <label className="icp-field">
          <span>K5 · Größe idealer Kunden</span>
          <input value={form.groesse} onChange={upd("groesse")} maxLength={200} placeholder="z. B. 20–500 Mitarbeiter, Mittelstand" />
        </label>
        <label className="icp-field">
          <span>K7 · Weitere Merkmale perfekter Kunden (Komma-getrennt)</span>
          <input value={form.merkmale} onChange={upd("merkmale")} placeholder="z. B. eigene Produktion, Digitalisierungsdruck, inhabergeführt" />
        </label>
        <label className="icp-field">
          <span>K8 · Wer passt explizit NICHT?</span>
          <input value={form.ausschluesse} onChange={upd("ausschluesse")} maxLength={500} placeholder="z. B. keine Agenturen, kein Einzelhandel" />
        </label>
        <label className="icp-field">
          <span>K9 · Deine besten Bestandskunden (Website-URLs, eine pro Zeile, max 5 — bleiben lokal)</span>
          <textarea
            value={form.kundenUrls}
            onChange={upd("kundenUrls")}
            rows={4}
            placeholder={"kunde-a.de\nkunde-b.de"}
          />
        </label>
        <label className="icp-field">
          <span>Zusammenfassung in deinen Worten (fließt am stärksten ins Matching)</span>
          <textarea
            value={form.beschreibung}
            onChange={upd("beschreibung")}
            rows={5}
            maxLength={2000}
            placeholder="Meine perfekten Kunden sind …"
          />
        </label>

        {notice && <div className="radar-notice">{notice}</div>}
        {showAutoCta && (
          <div className="radar-hint icp-auto-cta">
            Soll der <strong>Radar automatisch</strong> nach neuen passenden
            Firmen suchen und dich bei Treffern benachrichtigen?{" "}
            <button
              className="proc-toggle radar-import"
              onClick={() => {
                void window.api.discovery
                  .setRadarConfig({ enabled: true, intervalHours: 24 })
                  .then(() => navigate("/radar"));
              }}
            >
              Automatik aktivieren (täglich)
            </button>{" "}
            <button className="proc-toggle" onClick={() => setShowAutoCta(false)}>
              Nicht jetzt
            </button>
          </div>
        )}
        <div className="icp-actions">
          <button
            className="proc-toggle radar-import"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? "Speichert…" : "ICP übernehmen"}
          </button>
          <button className="proc-toggle" onClick={() => navigate("/radar")}>
            Zum Radar
          </button>
        </div>
      </div>
    </div>
  );
}
