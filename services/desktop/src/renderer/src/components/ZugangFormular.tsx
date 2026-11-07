// Zugang zu einem Dienst eintragen und verbinden (docs/PLAN_CLOSE_MCP.md C2,
// docs/PLAN_LOESUNGSKARTEN.md L6). Gemeinsam fuer Einstellungen → Verbindungen →
// Weitere Dienste und die sichere Zugangskarte im Chat. Die Werte gehen direkt
// an den Hauptprozess (verschluesselt im Schluesselbund), nie an das Modell.
import { useEffect, useState } from "react";
import type { McpDienstAnzeige } from "../../../shared/types";
import { DIENST_VORLAGEN, type DienstZugangArt, type ZugangAnfrage } from "../../../shared/dienst-vorlagen";

type Art = "mcp" | "a2a";

const ZUGANG_TEXT: Record<DienstZugangArt, string> = {
  zugangscode: "Schlüssel oder Zugangscode",
  kopfzeilen: "Eigene Kopfzeilen",
  anmeldung: "Benutzername und Passwort",
  client: "Client-ID und Client-Secret",
  keine: "Ohne Zugang",
};

export function ZugangFormular(props: {
  vorbelegung?: ZugangAnfrage | null;
  /** In der Chat-Karte: keine Auswahl der Vorlage, schlanker. */
  kompakt?: boolean;
  onVerbunden: (d: McpDienstAnzeige) => void;
  onAbbrechen: () => void;
}) {
  const [vorlage, setVorlage] = useState<string>("");
  const [art, setArt] = useState<Art>("mcp");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [zugang, setZugang] = useState<DienstZugangArt>("zugangscode");
  const [zugangscode, setZugangscode] = useState("");
  const [kopfzeilen, setKopfzeilen] = useState<Array<{ name: string; wert: string }>>([{ name: "", wert: "" }]);
  const [benutzer, setBenutzer] = useState("");
  const [passwort, setPasswort] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [tokenAdresse, setTokenAdresse] = useState("");
  const [scope, setScope] = useState("");
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const vorlageWaehlen = (id: string) => {
    setVorlage(id);
    const v = DIENST_VORLAGEN.find((x) => x.id === id);
    if (!v) return;
    setArt(v.art);
    setName(v.name);
    setUrl(v.url);
    setZugang(v.zugang);
    setZugangscode("");
    setKopfzeilen(v.kopfzeilen ? v.kopfzeilen.map((k) => ({ name: k.name, wert: k.wert ?? "" })) : [{ name: "", wert: "" }]);
    setTokenAdresse(v.tokenAdresse ?? "");
    setScope(v.scope ?? "");
  };

  const vb = props.vorbelegung;
  useEffect(() => {
    if (!vb) return;
    if (vb.vorlage && DIENST_VORLAGEN.some((x) => x.id === vb.vorlage)) vorlageWaehlen(vb.vorlage);
    else if (vb.name) setName(vb.name.slice(0, 60));
    if (vb.url) setUrl(vb.url);
    if (vb.art) setArt(vb.art);
    if (vb.zugang) setZugang(vb.zugang);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vb?.vorlage, vb?.name, vb?.url, vb?.art, vb?.zugang]);

  const verbinden = async () => {
    setBusy(true);
    setFehler(null);
    try {
      const d = await window.api.mcpDienste.hinzufuegen({
        name,
        url,
        art,
        zugang,
        ...(zugang === "zugangscode" ? { zugangscode } : {}),
        ...(zugang === "kopfzeilen" ? { kopfzeilen: Object.fromEntries(kopfzeilen.filter((k) => k.name.trim()).map((k) => [k.name.trim(), k.wert])) } : {}),
        ...(zugang === "anmeldung" ? { benutzer, passwort } : {}),
        ...(zugang === "client" ? { clientId, clientSecret, tokenAdresse, scope } : {}),
      });
      props.onVerbunden(d);
    } catch (err) {
      setFehler(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(err));
    } finally {
      setBusy(false);
    }
  };

  const zugangOk =
    zugang === "keine" ||
    (zugang === "zugangscode" && zugangscode.trim().length >= 8) ||
    (zugang === "kopfzeilen" && kopfzeilen.some((k) => k.name.trim() && k.wert.trim())) ||
    (zugang === "anmeldung" && benutzer.trim().length > 0 && passwort.length > 0) ||
    (zugang === "client" && clientId.trim().length > 0 && clientSecret.trim().length > 0 && /^https?:\/\//.test(tokenAdresse.trim()));
  const kannVerbinden = !busy && name.trim().length >= 2 && /^https?:\/\//.test(url.trim()) && zugangOk;
  const vorlageInfo = DIENST_VORLAGEN.find((x) => x.id === vorlage);
  const ausVorlage = Boolean(props.kompakt && vorlageInfo);

  return (
    <div className="crm-card dienste-form">
      {!props.kompakt && (
        <label className="dienste-feld">
          <span className="muted small">Vorlage</span>
          <select value={vorlage} onChange={(e) => vorlageWaehlen(e.target.value)}>
            <option value="">Eigener Dienst</option>
            {DIENST_VORLAGEN.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </label>
      )}
      {vorlageInfo && <p className="muted small">{vorlageInfo.hinweis}</p>}
      {!ausVorlage && (
        <>
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
            <select value={zugang} onChange={(e) => setZugang(e.target.value as DienstZugangArt)} disabled={busy}>
              {(["zugangscode", "kopfzeilen", "anmeldung", "client", "keine"] as const).map((z) => (
                <option key={z} value={z}>{ZUGANG_TEXT[z]}</option>
              ))}
            </select>
          </label>
        </>
      )}
      {zugang === "zugangscode" && (
        <label className="dienste-feld">
          <span className="muted small">{ausVorlage ? `Zugangscode für ${name}` : "Schlüssel oder Zugangscode"}</span>
          <input type="password" value={zugangscode} onChange={(e) => setZugangscode(e.target.value)} autoComplete="off" disabled={busy} />
        </label>
      )}
      {zugang === "kopfzeilen" && (
        <div className="dienste-feld">
          <span className="muted small">{ausVorlage ? "Zugang" : "Kopfzeilen (Name und Wert)"}</span>
          {kopfzeilen.map((k, i) => (
            <div key={i} className="dienste-kopfzeile">
              <input
                type="text"
                value={k.name}
                placeholder="Name"
                onChange={(e) => setKopfzeilen((alt) => alt.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                disabled={busy || ausVorlage}
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
          {kopfzeilen.length < 4 && !ausVorlage && (
            <button type="button" className="link-button" onClick={() => setKopfzeilen((alt) => [...alt, { name: "", wert: "" }])} disabled={busy}>
              Weitere Kopfzeile
            </button>
          )}
        </div>
      )}
      {zugang === "anmeldung" && (
        <div className="dienste-kopfzeile">
          <label className="dienste-feld">
            <span className="muted small">Benutzername</span>
            <input type="text" value={benutzer} onChange={(e) => setBenutzer(e.target.value)} autoComplete="off" disabled={busy} />
          </label>
          <label className="dienste-feld">
            <span className="muted small">Passwort</span>
            <input type="password" value={passwort} onChange={(e) => setPasswort(e.target.value)} autoComplete="off" disabled={busy} />
          </label>
        </div>
      )}
      {zugang === "client" && (
        <>
          <div className="dienste-kopfzeile">
            <label className="dienste-feld">
              <span className="muted small">Client-ID</span>
              <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" disabled={busy} />
            </label>
            <label className="dienste-feld">
              <span className="muted small">Client-Secret</span>
              <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" disabled={busy} />
            </label>
          </div>
          <label className="dienste-feld">
            <span className="muted small">Adresse für die Anmeldung</span>
            <input type="url" value={tokenAdresse} onChange={(e) => setTokenAdresse(e.target.value)} placeholder="https://…/oauth/token" disabled={busy} />
          </label>
          <label className="dienste-feld">
            <span className="muted small">Berechtigungen (optional, mit Leerzeichen getrennt)</span>
            <input type="text" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="z. B. read write" disabled={busy} />
          </label>
        </>
      )}
      <div className="dienste-aktionen">
        <button type="button" className="primary" onClick={() => void verbinden()} disabled={!kannVerbinden}>
          {busy ? "Verbindet…" : "Verbinden"}
        </button>
        <button type="button" onClick={props.onAbbrechen} disabled={busy}>Abbrechen</button>
      </div>
      {fehler && <p className="crm-card-error">{fehler}</p>}
    </div>
  );
}
