// Einstellungen → Verbindungen → Weitere Dienste (docs/PLAN_CLOSE_MCP.md, C2):
// Dienste mit eigener Werkzeugschnittstelle verbinden. Zugangsdaten gehen
// einmal hinein und werden nie wieder angezeigt.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import type { McpDienstAnzeige } from "../../../../shared/types";
import { gatewayFetch } from "../../api/gateway";
import { ZugangFormular } from "../../components/ZugangFormular";
import type { ZugangAnfrage } from "../../../../shared/dienst-vorlagen";

export function DiensteSection() {
  const qc = useQueryClient();
  const liste = useQuery({ queryKey: ["mcp-dienste"], queryFn: () => window.api.mcpDienste.liste() });
  useEffect(() => window.api.mcpDienste.onChanged(() => void qc.invalidateQueries({ queryKey: ["mcp-dienste"] })), [qc]);

  const [offen, setOffen] = useState(false);
  // AVA oeffnet die Seite aus dem Chat mit ?vorlage=<id> oder ?name=<Dienst>
  // (Werkzeug app_oeffnen): Formular gleich offen und vorbelegt.
  const [suche] = useSearchParams();
  const vorbelegung = useMemo<ZugangAnfrage | null>(() => {
    const v = suche.get("vorlage");
    const n = suche.get("name");
    if (!v && !n) return null;
    return { ...(v ? { vorlage: v } : {}), ...(n ? { name: n } : {}) };
  }, [suche]);
  useEffect(() => {
    if (vorbelegung) setOffen(true);
  }, [vorbelegung]);

  return (
    <section className="provider-section" id="weitere-dienste-section">
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
        <ZugangFormular vorbelegung={vorbelegung} onVerbunden={() => setOffen(false)} onAbbrechen={() => setOffen(false)} />
      )}
      <details className="muted small dienste-details">
        <summary>Technische Details</summary>
        <p>
          Werkzeugdienste über das Model Context Protocol (MCP) per Streamable HTTP, bei älteren Diensten per SSE; Agenten über
          das Agent2Agent-Protokoll (A2A, Agentenkarte unter /.well-known/agent-card.json, JSON-RPC message/send und tasks/get).
          Der Zugang wird als Bearer-Token, als eigene Kopfzeilen, per HTTP-Basic oder als OAuth-2.0-Token (Client Credentials) mitgeschickt und verschlüsselt im Schlüsselbund dieses
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
