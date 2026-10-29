// I1 ICP-Assistent (docs/PLAN_ICP_ASSISTENT.md) — Fragenkatalog-Formular.
//
// In I1 ist das der manuelle Pfad (B6: Review/Handeingabe sind dasselbe
// Formular). In I2 wird derselbe Screen vom URL-Analyse-Stepper mit dem
// generierten Entwurf vorbefuellt.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

/** Dritter Weg (2026-10-14): bestehendes ICP aus Datei (PDF, Word, Text, Markdown)
 *  oder Freitext. AVA verdichtet es EINMAL in das Formular, damit das grosse
 *  Dokument nie im Kontext mitlaufen muss. Laeuft ueber das Modell des Nutzers. */
const IMPORT_MAX_ZEICHEN = 200_000;
const IMPORT_DATEITYPEN = ".pdf,.docx,.txt,.md,.markdown";

async function dateiZuText(file: File): Promise<{ text: string; hinweis: string | null }> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || name.endsWith(".docx")) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await window.api.agent.extractPdfText({ filename: file.name, bytes });
    return { text: r.text, hinweis: r.truncated ? "Die Datei war sehr lang; nur der Anfang wurde gelesen." : r.numPages > 1 ? `${r.numPages} Seiten gelesen.` : null };
  }
  return { text: await file.text(), hinweis: null };
}

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

type Mode = "intro" | "import" | "analyzing" | "form";

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
  // Import eines bestehenden ICP.
  const [importText, setImportText] = useState("");
  const [importDatei, setImportDatei] = useState<{ name: string; hinweis: string | null } | null>(null);
  const [importLaedt, setImportLaedt] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importFehlend, setImportFehlend] = useState<string[]>([]);
  const dateiInput = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  const dateiUebernehmen = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setNotice(null);
    setImportLaedt(true);
    try {
      const r = await dateiZuText(file);
      const text = r.text.trim();
      if (text.length < 80) {
        setNotice(`Aus „${file.name}“ liess sich kein Text lesen (gescanntes PDF?). Füge den Inhalt dann bitte als Text ein.`);
        return;
      }
      setImportText(text.slice(0, IMPORT_MAX_ZEICHEN));
      setImportDatei({ name: file.name, hinweis: r.hinweis });
    } catch (err) {
      setNotice(`Datei konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setImportLaedt(false);
    }
  };

  const startImport = async (): Promise<void> => {
    setMode("analyzing");
    setProgress([]);
    setNotice(null);
    setAnalysisNotes([]);
    setRadiusHint(null);
    setImportFehlend([]);
    const result = await window.api.discovery.icpAusText({ text: importText, quelle: importDatei?.name ?? "eingefügter Text" });
    if ("error" in result) {
      setNotice(result.error);
      setMode("import");
      return;
    }
    const d = result.icp;
    setForm((f) => ({
      beschreibung: d.beschreibung || f.beschreibung,
      angebot: d.angebot || f.angebot,
      nutzen: d.nutzen || f.nutzen,
      branchen: (d.branchen ?? []).length ? (d.branchen ?? []).join(", ") : f.branchen,
      orte: (d.orte ?? []).length ? (d.orte ?? []).join(", ") : f.orte,
      radiusKm: d.radiusKm ?? f.radiusKm,
      groesse: d.groesse || f.groesse,
      merkmale: (d.merkmale ?? []).length ? (d.merkmale ?? []).join(", ") : f.merkmale,
      ausschluesse: d.ausschluesse || f.ausschluesse,
      kundenUrls: (d.kundenBeispiele ?? []).length ? (d.kundenBeispiele ?? []).map((k) => k.domain).join("\n") : f.kundenUrls,
    }));
    setAnalysisNotes(result.hinweise);
    setImportFehlend(result.fehlend);
    setQuelle("dokument");
    const umfang = result.abschnitte > 1 ? `${result.abschnitte} Abschnitte, ${Math.round(result.zeichen / 1000)}k Zeichen` : `${Math.round(result.zeichen / 1000)}k Zeichen`;
    setNotice(
      `Entwurf aus ${importDatei ? `„${importDatei.name}“` : "deinem Text"} übernommen (${umfang}). ` +
        (result.fehlend.length > 0 ? `Im Dokument nicht belegt: ${result.fehlend.join(", ")}. ` : "") +
        "Bitte prüfen und anpassen — gespeichert wird erst mit „ICP übernehmen“.",
    );
    setMode("form");
  };

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
    const parts: string[] = [];
    if (result.kunden.length > 0) {
      parts.push(
        `Eingeflossen: ${result.kunden.map((k) => k.name).join(", ")}.`,
      );
    }
    if (result.kundenFehlgeschlagen.length > 0) {
      parts.push(
        `NICHT eingeflossen: ${result.kundenFehlgeschlagen
          .map((f) => `${f.domain} (${f.grund})`)
          .join("; ")}.`,
      );
    }
    setNotice(
      `Entwurf aus deiner Website erstellt. ${parts.join(" ")} Bitte prüfen und anpassen — gespeichert wird erst mit „ICP übernehmen“.`,
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
        quelle: quelle === "dokument" ? "dokument" : radiusHint !== null || analysisNotes.length > 0 ? "assistent" : "manuell",
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
        const teile: string[] = [];
        if (saved.profilErgaenzt && saved.profilErgaenzt.length > 0) {
          teile.push(`Dein Nutzerprofil wurde aktualisiert (${saved.profilErgaenzt.join(", ")}).`);
        }
        const beibehalten = (saved as { profilBeibehalten?: string[] }).profilBeibehalten ?? [];
        if (beibehalten.length > 0) {
          teile.push(
            `Beibehalten, weil von dir selbst bearbeitet: ${beibehalten.join(", ")} — unter Einstellungen → Profil anpassbar.`,
          );
        }
        const profilInfo = teile.length > 0 ? ` ${teile.join(" ")}` : "";
        const fehlend = (saved as { fehlend?: string[] }).fehlend ?? [];
        setNotice(
          fehlend.length > 0
            ? `ICP gespeichert. Für den Radar fehlt noch: ${fehlend.join("; ")}.${profilInfo}`
            : `ICP gespeichert — der Radar nutzt es ab dem nächsten Match.${profilInfo}`,
        );
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

  if (mode === "import") {
    const zeichen = importText.length;
    return (
      <div className="radar-page icp-page">
        <h1>Bestehendes Idealkundenprofil übernehmen</h1>
        <p className="radar-sub">
          Du hast dein ICP schon beschrieben, etwa in Confluence, Word oder als PDF? Gib es AVA einmal
          komplett. Sie verdichtet es in ihr Formular, damit das große Dokument nie im Chat mitlaufen muss.
          Die Auswertung läuft über dein eigenes KI-Modell; das Dokument bleibt auf deinem Rechner.
        </p>
        <div className="icp-form">
          <div
            className={`icp-drop${dragOver ? " icp-drop--over" : ""}${importDatei ? " icp-drop--datei" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => dateiInput.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") dateiInput.current?.click();
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void dateiUebernehmen(e.dataTransfer.files?.[0]);
            }}
          >
            <input
              ref={dateiInput}
              type="file"
              accept={IMPORT_DATEITYPEN}
              hidden
              onChange={(e) => {
                void dateiUebernehmen(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              <path d="M12 16V4m0 0l-4 4m4-4l4 4M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {importLaedt ? (
              <span>Datei wird gelesen …</span>
            ) : importDatei ? (
              <span>
                <strong>{importDatei.name}</strong> gelesen{importDatei.hinweis ? ` · ${importDatei.hinweis}` : ""} · andere Datei wählen
              </span>
            ) : (
              <span>
                <strong>PDF, Word, Text oder Markdown</strong> hierher ziehen oder klicken
              </span>
            )}
          </div>
          <div className="icp-oder">oder einfügen</div>
          <label className="icp-field">
            <span>Dein bestehendes ICP als Text</span>
            <textarea
              value={importText}
              onChange={(e) => {
                setImportText(e.target.value.slice(0, IMPORT_MAX_ZEICHEN));
                if (importDatei) setImportDatei(null);
              }}
              rows={14}
              placeholder={"Füge hier dein komplettes ICP-Dokument ein: Zielbranchen, Firmengröße, Regionen, Merkmale, Ausschlüsse, Beispielkunden …"}
            />
            <span className="icp-zaehler">
              {zeichen.toLocaleString("de-DE")} Zeichen
              {zeichen > 24_000 ? ` · wird in ${Math.min(12, Math.ceil(zeichen / 12_000))} Abschnitten gelesen` : ""}
              {zeichen >= IMPORT_MAX_ZEICHEN ? " · Obergrenze erreicht" : ""}
            </span>
          </label>
          {notice && <div className="radar-error">{notice}</div>}
          <div className="icp-actions">
            <button className="proc-toggle radar-import" disabled={importText.trim().length < 80 || importLaedt} onClick={() => void startImport()}>
              ICP ableiten
            </button>
            <button
              className="proc-toggle"
              onClick={() => {
                setNotice(null);
                setMode("intro");
              }}
            >
              Zurück
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "intro") {
    return (
      <div className="radar-page icp-page">
        <h1>Idealkundenprofil in 2 Minuten</h1>
        <p className="radar-sub">
          Drei Wege, ein Formular: AVA schreibt dir den Entwurf aus deinen Websites, übernimmt dein
          bestehendes ICP aus einem Dokument, oder du füllst es von Hand. Gespeichert wird erst,
          wenn du den Entwurf geprüft hast.
        </p>
        <div className="icp-wege">
          <button type="button" className="icp-weg icp-weg--aktiv" aria-pressed>
            <strong>Aus deinen Websites</strong>
            <span>Deine Website und bis zu 5 Kunden-Websites. AVA liest Angebot, Standort und Gemeinsamkeiten.</span>
          </button>
          <button
            type="button"
            className="icp-weg"
            onClick={() => {
              setNotice(null);
              setMode("import");
            }}
          >
            <strong>Bestehendes ICP übernehmen</strong>
            <span>PDF, Word oder Text aus Confluence und Co. AVA verdichtet es einmal in ihr Formular.</span>
          </button>
          <button type="button" className="icp-weg" onClick={() => setMode("form")}>
            <strong>Von Hand ausfüllen</strong>
            <span>Neun kurze Fragen. Du kannst jederzeit später einen der anderen Wege nutzen.</span>
          </button>
        </div>
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
          {importText && progress.some((p) => /Abschnitt|Formular/.test(p.text))
            ? "Dein bestehendes ICP wird mit deinem Modell verdichtet — bei langen Dokumenten dauert das ein bis zwei Minuten."
            : "Websites werden analysiert — das dauert je nach Anzahl 1–3 Minuten."}
        </p>
        <div className="icp-progress">
          {progress.map((p, i) => {
            // ✗-Zeilen sind Fehlschlaege aus der Engine — die bekommen
            // KEINEN Haken (vorher wirkte jeder Schritt erfolgreich).
            const failed = p.text.startsWith("✗");
            const active = i === progress.length - 1 && !failed;
            return (
              <div
                key={i}
                className={
                  failed
                    ? "icp-step icp-step-failed"
                    : active
                      ? "icp-step icp-step-active"
                      : "icp-step icp-step-done"
                }
              >
                {failed ? "" : active ? "⏳ " : "✓ "}
                {p.text}
              </div>
            );
          })}
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
                : quelle === "dokument"
                  ? "aus deinem bestehenden ICP übernommen"
                  : "von Hand gepflegt"}
            .
          </>
        )}{" "}
        <button className="icp-linkbtn" onClick={() => setMode("intro")}>
          Neu aus Websites erstellen
        </button>
        {" · "}
        <button
          className="icp-linkbtn"
          onClick={() => {
            setNotice(null);
            setMode("import");
          }}
        >
          Bestehendes ICP übernehmen
        </button>
      </p>
      {importFehlend.length > 0 && (
        <div className="radar-hint">Im Dokument nicht belegt, bitte ergänzen: {importFehlend.join(", ")}.</div>
      )}
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
            <input value={form.orte} onChange={upd("orte")} placeholder="z. B. Hannover, Wien (AT), Zürich (CH), Manchester (UK), Oslo (NO), Helsinki (FI)" />
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
