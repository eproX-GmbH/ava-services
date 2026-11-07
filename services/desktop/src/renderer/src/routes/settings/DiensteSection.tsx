// Einstellungen → Verbindungen → Weitere Dienste (docs/PLAN_CLOSE_MCP.md, C2):
// Dienste mit eigener Werkzeugschnittstelle verbinden. Zugangsdaten gehen
// einmal hinein und werden nie wieder angezeigt.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { McpDienstAnzeige } from "../../../../shared/types";
import { gatewayFetch } from "../../api/gateway";

type Zugang = "keine" | "zugangscode" | "kopfzeilen";
type Art = "mcp" | "a2a";

const VORLAGEN: Array<{ id: string; name: string; url: string; art: Art; zugang: Zugang; kopfzeilen?: Array<{ name: string; hinweis: string; wert?: string }>; hinweis: string }> = [
  {
    id: "close",
    art: "mcp",
    name: "Close",
    url: "https://mcp.close.com/mcp",
    zugang: "kopfzeilen",
    kopfzeilen: [
      { name: "Close-API-Key", hinweis: "Schlüssel aus Close (Einstellungen → Entwickler)" },
      { name: "Close-Scope", hinweis: "Zugriffsbereich laut Close; vorbelegt ist sicheres Schreiben", wert: ["mcp", "write_safe"].join(".") },
    ],
    hinweis: "Kontakte, Aktivitäten, Chancen und Aufgaben in Close. Vorbelegt ist Lesen und sicheres Schreiben; Löschen erlaubt erst der Zugriffsbereich für destruktives Schreiben (siehe Close-Dokumentation).",
  },
  {
    id: "compleadly",
    art: "mcp",
    name: "CompLeadly",
    url: "https://mcp.complead.ly/user/mcp",
    zugang: "zugangscode",
    hinweis: "LinkedIn-Sequenzen über dein CompLeadly-Konto. Zugangscode in CompLeadly unter Einstellungen → Eigene KI verbinden anlegen („Neuer Token“) und hier eintragen.",
  },
];

export function DiensteSection() {
  const qc = useQueryClient();
  const liste = useQuery({ queryKey: ["mcp-dienste"], queryFn: () => window.api.mcpDienste.liste() });
  useEffect(() => window.api.mcpDienste.onChanged(() => void qc.invalidateQueries({ queryKey: ["mcp-dienste"] })), [qc]);

  const [offen, setOffen] = useState(false);
  const [vorlage, setVorlage] = useState<string>("");
  const [art, setArt] = useState<Art>("mcp");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [zugang, setZugang] = useState<Zugang>("zugangscode");
  const [zugangscode, setZugangscode] = useState("");
  const [kopfzeilen, setKopfzeilen] = useState<Array<{ name: string; wert: string }>>([{ name: "", wert: "" }]);
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const vorlageWaehlen = (id: string) => {
    setVorlage(id);
    const v = VORLAGEN.find((x) => x.id === id);
    if (!v) return;
    setArt(v.art);
    setName(v.name);
    setUrl(v.url);
    setZugang(v.zugang);
    setZugangscode("");
    setKopfzeilen(v.kopfzeilen ? v.kopfzeilen.map((k) => ({ name: k.name, wert: k.wert ?? "" })) : [{ name: "", wert: "" }]);
  };

  // AVA oeffnet die Seite aus dem Chat mit ?vorlage=<id> oder ?name=<Dienst>
  // (Werkzeug app_oeffnen): Formular gleich offen und vorbelegt.
  const [suche] = useSearchParams();
  useEffect(() => {
    const v = suche.get("vorlage");
    const n = suche.get("name");
    if (!v && !n) return;
    setOffen(true);
    if (v && VORLAGEN.some((x) => x.id === v)) vorlageWaehlen(v);
    else if (n) setName(n.slice(0, 60));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suche]);

  const zuruecksetzen = () => {
    setOffen(false);
    setVorlage("");
    setArt("mcp");
    setName("");
    setUrl("");
    setZugang("zugangscode");
    setZugangscode("");
    setKopfzeilen([{ name: "", wert: "" }]);
    setFehler(null);
  };

  const verbinden = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await window.api.mcpDienste.hinzufuegen({
        name,
        url,
        art,
        zugang,
        ...(zugang === "zugangscode" ? { zugangscode } : {}),
        ...(zugang === "kopfzeilen" ? { kopfzeilen: Object.fromEntries(kopfzeilen.filter((k) => k.name.trim()).map((k) => [k.name.trim(), k.wert])) } : {}),
      });
      zuruecksetzen();
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const kannVerbinden =
    !busy && name.trim().length >= 2 && /^https?:\/\//.test(url.trim()) &&
    (zugang === "keine" || (zugang === "zugangscode" ? zugangscode.trim().length >= 8 : kopfzeilen.some((k) => k.name.trim() && k.wert.trim())));

  const vorlageInfo = VORLAGEN.find((x) => x.id === vorlage);

  return (
    <section className="provider-section" id="dienste-section">
      <h3>Weitere Dienste</h3>
      <p className="muted">
        Dienste mit eigener Werkzeugschnittstelle, zum Beispiel Close oder CompLeadly, und fremde Agenten, denen AVA Aufträge
        geben kann. AVA nutzt sie im Chat und in Workflows; was damit geschieht, bestimmst du mit deinen Anweisungen. Schreibende
        Aktionen fragen vorher nach. Läuft ein Zugang ab, siehst du es hier an der Karte und als Hinweis oben in der App.
      </p>
      {liste.isLoading ? (
        <p className="muted small">Lädt …</p>
      ) : (liste.data ?? []).length === 0 ? (
        <p className="muted small">Noch kein Dienst verbunden.</p>
      ) : (
        <ul className="crm-cards">
          {(liste.data ?? []).map((d) => (
            <DienstKarte key={d.id} dienst={d} />
          ))}
        </ul>
      )}

      {!offen ? (
        <button type="button" onClick={() => setOffen(true)}>Dienst verbinden</button>
      ) : (
        <div className="crm-card dienste-form">
          <label className="dienste-feld">
            <span className="muted small">Vorlage</span>
            <select value={vorlage} onChange={(e) => vorlageWaehlen(e.target.value)}>
              <option value="">Eigener Dienst</option>
              {VORLAGEN.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </label>
          {vorlageInfo && <p className="muted small">{vorlageInfo.hinweis}</p>}
          <label className="dienste-feld">
            <span className="muted small">Art des Dienstes</span>
            <select value={art} onChange={(e) => setArt(e.target.value as Art)} disabled={busy}>
              <option value="mcp">Werkzeugdienst (stellt einzelne Werkzeuge bereit)</option>
              <option value="a2a">Agent (nimmt Aufträge in Textform an)</option>
            </select>
          </label>
          <label className="dienste-feld">
            <span className="muted small">Name</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name des Dienstes" disabled={busy} />
          </label>
          <label className="dienste-feld">
            <span className="muted small">Adresse</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={art === "a2a" ? "https://… (Adresse des Agenten oder seiner Agentenkarte)" : "https://…"} disabled={busy} />
          </label>
          <label className="dienste-feld">
            <span className="muted small">Zugang</span>
            <select value={zugang} onChange={(e) => setZugang(e.target.value as Zugang)} disabled={busy}>
              <option value="zugangscode">Zugangscode</option>
              <option value="kopfzeilen">Eigene Kopfzeilen</option>
              <option value="keine">Ohne Zugang</option>
            </select>
          </label>
          {zugang === "zugangscode" && (
            <label className="dienste-feld">
              <span className="muted small">Zugangscode</span>
              <input type="password" value={zugangscode} onChange={(e) => setZugangscode(e.target.value)} autoComplete="off" disabled={busy} />
            </label>
          )}
          {zugang === "kopfzeilen" && (
            <div className="dienste-feld">
              <span className="muted small">Kopfzeilen (Name und Wert)</span>
              {kopfzeilen.map((k, i) => (
                <div key={i} className="dienste-kopfzeile">
                  <input
                    type="text"
                    value={k.name}
                    placeholder="Name"
                    onChange={(e) => setKopfzeilen((alt) => alt.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    disabled={busy}
                  />
                  <input
                    type="password"
                    value={k.wert}
                    placeholder={vorlageInfo?.kopfzeilen?.[i]?.hinweis ?? "Wert"}
                    autoComplete="off"
                    onChange={(e) => setKopfzeilen((alt) => alt.map((x, j) => (j === i ? { ...x, wert: e.target.value } : x)))}
                    disabled={busy}
                  />
                </div>
              ))}
              {kopfzeilen.length < 4 && (
                <button type="button" className="link-button" onClick={() => setKopfzeilen((alt) => [...alt, { name: "", wert: "" }])} disabled={busy}>
                  Weitere Kopfzeile
                </button>
              )}
            </div>
          )}
          <div className="dienste-aktionen">
            <button type="button" className="primary" onClick={() => void verbinden()} disabled={!kannVerbinden}>
              {busy ? "Verbindet…" : "Verbinden"}
            </button>
            <button type="button" onClick={zuruecksetzen} disabled={busy}>Abbrechen</button>
          </div>
          {fehler && <p className="crm-card-error">{fehler}</p>}
        </div>
      )}
      <details className="muted small dienste-details">
        <summary>Technische Details</summary>
        <p>
          Werkzeugdienste über das Model Context Protocol (MCP) per Streamable HTTP, bei älteren Diensten per SSE; Agenten über
          das Agent2Agent-Protokoll (A2A, Agentenkarte unter /.well-known/agent-card.json, JSON-RPC message/send und tasks/get).
          Der Zugang wird als Bearer-Token oder als eigene Kopfzeilen mitgeschickt und verschlüsselt im Schlüsselbund dieses
          Rechners abgelegt. Werkzeuge erscheinen im Chat als <code>mcp_&lt;dienst&gt;_&lt;werkzeug&gt;</code> bzw.{" "}
          <code>a2a_&lt;agent&gt;_auftrag</code>.
        </p>
      </details>
    </section>
  );
}

/** Dezente Rückkanal-Zeile: Empfangsadresse für Ereignisse des Dienstes (nur Werkzeugdienste). */
function Rueckkanal({ dienst }: { dienst: McpDienstAnzeige }) {
  const qc = useQueryClient();
  const liste = useQuery({ queryKey: ["dienst-webhooks"], queryFn: () => gatewayFetch<{ empfaenger: Array<{ id: string; dienst: string; url: string; anzahl: number; zuletztAt: string | null }> }>("/v1/dienste/webhooks") });
  const [busy, setBusy] = useState(false);
  const [kopiert, setKopiert] = useState(false);
  const eintrag = (liste.data?.empfaenger ?? []).find((e) => e.dienst === dienst.slug);
  const anlegen = async () => {
    setBusy(true);
    try {
      await gatewayFetch("/v1/dienste/webhooks", { method: "POST", body: { dienst: dienst.slug } });
      await qc.invalidateQueries({ queryKey: ["dienst-webhooks"] });
    } finally {
      setBusy(false);
    }
  };
  const kopieren = async () => {
    if (!eintrag) return;
    try {
      await navigator.clipboard.writeText(eintrag.url);
      setKopiert(true);
      setTimeout(() => setKopiert(false), 1500);
    } catch {
      /* Adresse ist markierbar */
    }
  };
  const istCompleadly = dienst.slug === "compleadly" || /compleadly|complead/i.test(dienst.url);
  return (
    <div className="dienste-rueckkanal">
      <span className="dienste-rueckkanal__label">Rückkanal</span>
      {eintrag ? (
        <>
          <code className="dienste-rueckkanal__url" title={eintrag.url}>{eintrag.url}</code>
          <button type="button" className="link-button" onClick={() => void kopieren()}>{kopiert ? "Kopiert" : "Kopieren"}</button>
          <span className="dienste-rueckkanal__stand">
            {eintrag.anzahl > 0 ? `${eintrag.anzahl} Ereignisse, zuletzt ${eintrag.zuletztAt ? new Date(eintrag.zuletztAt).toLocaleString("de-DE") : "–"}` : "noch nichts eingegangen"}
          </span>
        </>
      ) : (
        <button type="button" className="link-button" onClick={() => void anlegen()} disabled={busy || liste.isLoading}>
          {busy ? "Legt an…" : "Adresse anlegen"}
        </button>
      )}
      <span className="dienste-rueckkanal__hinweis">
        {istCompleadly
          ? "In CompLeadly unter Einstellungen → Webhooks eintragen, dort ab Premium. Ohne Rückkanal fragt AVA den Stand über die Werkzeuge ab."
          : "Beim Dienst als Webhook-Adresse eintragen, wenn er Ereignisse senden kann. Ohne Rückkanal fragt AVA den Stand über die Werkzeuge ab."}
      </span>
    </div>
  );
}

function DienstKarte({ dienst }: { dienst: McpDienstAnzeige }) {
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const pruefen = async () => {
    setBusy(true);
    setFehler(null);
    try {
      await window.api.mcpDienste.pruefen(dienst.id);
    } catch (err) {
      setFehler(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const entfernen = async () => {
    setBusy(true);
    try {
      await window.api.mcpDienste.entfernen(dienst.id);
    } finally {
      setBusy(false);
    }
  };
  const tone = dienst.verbunden ? "ok" : "muted";
  return (
    <li className="crm-card">
      <div className="crm-card-header">
        <div className="crm-card-title">
          <span>{dienst.name}</span>
          <span className={`status-dot ${tone}`}>{dienst.verbunden ? (dienst.art === "a2a" ? "Agent erreichbar" : `${dienst.werkzeuge} Werkzeuge`) : "nicht verbunden"}</span>
        </div>
        <div className="crm-card-actions">
          <button type="button" onClick={() => void pruefen()} disabled={busy}>{busy ? "Prüft…" : "Neu verbinden"}</button>
          <button type="button" onClick={() => void entfernen()} disabled={busy}>Entfernen</button>
        </div>
      </div>
      <div className="crm-card-meta">
        <span>{dienst.url}</span>
        {dienst.zuletztVerbunden && <span>Zuletzt verbunden: {new Date(dienst.zuletztVerbunden).toLocaleString("de-DE")}</span>}
      </div>
      {(fehler ?? dienst.fehler) && <p className="crm-card-error">{fehler ?? dienst.fehler}</p>}
      {dienst.art !== "a2a" && <Rueckkanal dienst={dienst} />}
    </li>
  );
}
