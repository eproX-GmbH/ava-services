// Mail-Entwürfe (docs/PLAN_MAIL_ENTWURF.md): wohin der Knopf an Entwürfen öffnet,
// das Entwurfs-Postfach (Stufe 3: Entwurf direkt in den Entwürfe-Ordner) und feste
// Anhänge (Firmenprofil, Referenzen), die AVA an Outreach-Mails hängen kann.

import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MAIL_ENTWURF_ZIELE, ZIEL_TEXT, type MailEntwurfPostfachEingabe, type MailEntwurfZiel } from "../../../../shared/mail-entwurf";

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function MailEntwurfSection() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["mail-entwurf-einstellungen"], queryFn: () => window.api.mailEntwurf.einstellungen() });
  const programm = useQuery({ queryKey: ["mail-entwurf-stand", false], queryFn: () => window.api.mailEntwurf.stand(false) });
  const neuLaden = () => {
    void qc.invalidateQueries({ queryKey: ["mail-entwurf-einstellungen"] });
    void qc.invalidateQueries({ queryKey: ["mail-entwurf-stand"] });
  };
  const d = q.data;
  if (!d) return null;
  const ziele = MAIL_ENTWURF_ZIELE.filter((z) => z !== "postfach" || d.postfach.eingerichtet);

  return (
    <section id="mail-entwurf-section" className="provider-section">
      <h3>Mail-Entwürfe</h3>
      <p className="muted">
        Unter jeder Mail, die AVA für dich formuliert, steht ein Knopf, der den Entwurf fertig öffnet: mit Empfänger, Betreff, Text und Anhängen.
      </p>

      <div className="mail-form__row">
        <label>
          <span>Öffnen in</span>
          <select
            value={d.ziel}
            onChange={async (e) => {
              await window.api.mailEntwurf.zielSetzen(e.target.value);
              neuLaden();
            }}
          >
            {ziele.map((z) => (
              <option key={z} value={z}>
                {z === "auto" ? "Automatisch (empfohlen)" : ZIEL_TEXT[z as MailEntwurfZiel]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        {programm.data?.programm ? `Standard-Mailprogramm: ${programm.data.programm}. ` : "Kein Standard-Mailprogramm gefunden. "}
        Automatisch heißt: Outlook bekommt einen fertigen Entwurf mit Anhängen; mit Anhängen und eingerichtetem Entwurfs-Postfach landet der Entwurf dort; sonst
        öffnet sich das Mail-Programm (ohne Anhänge) oder, ohne Mail-Programm, Gmail bzw. Outlook im Web.
      </p>

      <Postfach d={d} onGeaendert={neuLaden} />
      <FesteAnhaenge liste={d.festeAnhaenge} onGeaendert={neuLaden} />
    </section>
  );
}

type Einstellungen = Awaited<ReturnType<typeof window.api.mailEntwurf.einstellungen>>;

function Postfach({ d, onGeaendert }: { d: Einstellungen; onGeaendert: () => void }) {
  const p = d.postfach;
  const [bearbeiten, setBearbeiten] = useState(false);
  const start = (): MailEntwurfPostfachEingabe =>
    p.eingerichtet
      ? { anbieter: p.anbieter, host: p.host, port: p.port, secure: p.secure, benutzer: p.benutzer, absender: p.absender, name: p.name }
      : { anbieter: "ionos", host: "imap.ionos.de", port: 993, secure: true, benutzer: "", absender: "", name: null };
  const [f, setF] = useState<MailEntwurfPostfachEingabe>(start);
  const [passwort, setPasswort] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState<{ ok: boolean; text: string } | null>(null);
  const anbieter = d.anbieter.find((a) => a.id === f.anbieter);
  const formular = bearbeiten || !p.eingerichtet;

  const speichern = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setLaeuft(true);
    setMeldung(null);
    const r = await window.api.mailEntwurf.postfachEinrichten({ ...f, benutzer: f.benutzer || f.absender }, passwort);
    setLaeuft(false);
    if (r.ok) {
      setPasswort("");
      setBearbeiten(false);
      setMeldung({ ok: true, text: "Verbunden. Entwürfe landen ab jetzt bei Bedarf im Entwürfe-Ordner." });
      onGeaendert();
    } else setMeldung({ ok: false, text: r.fehler });
  };

  return (
    <div className="mail-entwurf-einst">
      <h4>Entwurfs-Postfach</h4>
      <p className="muted small">
        Optional: AVA legt Entwürfe mit Anhängen direkt in den Entwürfe-Ordner deines Postfachs. Dort findest du sie in jedem Mail-Programm, im Webmail und auf dem
        Handy. AVA schreibt nur in diesen Ordner und liest keine Mails. Das Passwort liegt verschlüsselt auf diesem Gerät.
      </p>
      {p.eingerichtet && !bearbeiten && (
        <div className="mail-account-summary">
          <div>
            <div>
              <strong>{p.absender}</strong> <span className="pill pill--connected">verbunden</span>
            </div>
            <div className="muted small">
              {p.host} · Ordner „{p.ordner ?? "Entwürfe"}“{p.geprueft ? ` · geprüft ${new Date(p.geprueft).toLocaleDateString("de-DE")}` : ""}
            </div>
          </div>
          <div className="mail-account-summary__actions">
            <button type="button" className="btn small" onClick={() => { setF(start()); setBearbeiten(true); }}>
              Ändern
            </button>
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                await window.api.mailEntwurf.postfachEntfernen();
                setMeldung(null);
                onGeaendert();
              }}
            >
              Entfernen
            </button>
          </div>
        </div>
      )}
      {formular && (
        <form className="mail-form" onSubmit={(e) => void speichern(e)}>
          <div className="mail-form__row">
            <label>
              <span>Anbieter</span>
              <select
                value={f.anbieter}
                onChange={(e) => {
                  const a = d.anbieter.find((x) => x.id === e.target.value);
                  setF({ ...f, anbieter: e.target.value, ...(a && a.host ? { host: a.host, port: a.port, secure: a.port === 993 } : {}) });
                }}
              >
                {d.anbieter.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {anbieter?.hinweis && <p className={anbieter.gesperrt ? "warn small" : "muted small"}>{anbieter.hinweis}</p>}
          {!anbieter?.gesperrt && (
            <>
              <div className="mail-form__row">
                <label>
                  <span>E-Mail-Adresse</span>
                  <input type="email" required value={f.absender} onChange={(e) => setF({ ...f, absender: e.target.value })} placeholder="vorname.nachname@firma.de" />
                </label>
                <label>
                  <span>Anzeigename</span>
                  <input type="text" value={f.name ?? ""} onChange={(e) => setF({ ...f, name: e.target.value || null })} placeholder="Vorname Nachname" />
                </label>
              </div>
              <div className="mail-form__row">
                <label>
                  <span>Benutzername (meist die Adresse)</span>
                  <input type="text" value={f.benutzer} onChange={(e) => setF({ ...f, benutzer: e.target.value })} placeholder={f.absender || "wie die Adresse"} />
                </label>
                <label>
                  <span>{p.eingerichtet ? "Passwort (leer lassen = unverändert)" : "Passwort bzw. App-Passwort"}</span>
                  <input type="password" required={!p.eingerichtet} value={passwort} onChange={(e) => setPasswort(e.target.value)} autoComplete="new-password" />
                </label>
              </div>
              {f.anbieter === "andere" && (
                <div className="mail-form__row">
                  <label>
                    <span>IMAP-Server</span>
                    <input type="text" required value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="imap.firma.de" />
                  </label>
                  <label>
                    <span>Port</span>
                    <input type="number" required value={f.port} onChange={(e) => setF({ ...f, port: parseInt(e.target.value, 10) || 993 })} />
                  </label>
                  <label className="mail-form__checkbox">
                    <input type="checkbox" checked={f.secure} onChange={(e) => setF({ ...f, secure: e.target.checked })} />
                    <span>TLS</span>
                  </label>
                </div>
              )}
              <div className="mail-form__actions">
                <button type="submit" className="btn" disabled={laeuft}>
                  {laeuft ? "Verbinde …" : "Verbinden und speichern"}
                </button>
                {p.eingerichtet && (
                  <button type="button" className="btn" onClick={() => setBearbeiten(false)}>
                    Abbrechen
                  </button>
                )}
              </div>
            </>
          )}
        </form>
      )}
      {meldung && <p className={meldung.ok ? "mail-form__ok" : "mail-form__error"}>{meldung.text}</p>}
    </div>
  );
}

function FesteAnhaenge({ liste, onGeaendert }: { liste: Einstellungen["festeAnhaenge"]; onGeaendert: () => void }) {
  const datei = useRef<HTMLInputElement>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const hochladen = async (files: FileList | null) => {
    setFehler(null);
    for (const f of Array.from(files ?? [])) {
      const r = await window.api.mailEntwurf.festHinzufuegen({ name: f.name, mimeType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
      if (!r.ok) {
        setFehler(r.fehler);
        break;
      }
    }
    if (datei.current) datei.current.value = "";
    onGeaendert();
  };
  return (
    <div className="mail-entwurf-einst">
      <h4>Feste Anhänge</h4>
      <p className="muted small">
        Dateien, die du immer wieder mitschickst (Firmenprofil, Referenzen, Preisliste). AVA hängt sie passend an Entwürfe; die mit „An jede Outreach-Mail“ immer.
        Bis zu 10 Dateien, je höchstens 10 MB. Eine Datei mit gleichem Namen ersetzt die alte Fassung.
      </p>
      {liste.length > 0 && (
        <ul className="mail-entwurf-einst__liste">
          {liste.map((a) => (
            <li key={a.id}>
              <div className="mail-entwurf-einst__datei">
                <strong>{a.name}</strong>
                <span className="muted small">{kb(a.sizeBytes)}</span>
              </div>
              <input
                type="text"
                className="mail-entwurf-einst__beschreibung"
                defaultValue={a.beschreibung ?? ""}
                placeholder="Wofür? z. B. „Firmenprofil für Erstkontakt“"
                onBlur={async (e) => {
                  if ((e.target.value || null) !== a.beschreibung) {
                    await window.api.mailEntwurf.festAendern({ id: a.id, beschreibung: e.target.value || null });
                    onGeaendert();
                  }
                }}
              />
              <label className="mail-form__checkbox">
                <input
                  type="checkbox"
                  checked={a.immer}
                  onChange={async (e) => {
                    await window.api.mailEntwurf.festAendern({ id: a.id, immer: e.target.checked });
                    onGeaendert();
                  }}
                />
                <span>An jede Outreach-Mail</span>
              </label>
              <button
                type="button"
                className="btn small"
                onClick={async () => {
                  await window.api.mailEntwurf.festEntfernen(a.id);
                  onGeaendert();
                }}
              >
                Entfernen
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={datei} type="file" multiple hidden onChange={(e) => void hochladen(e.target.files)} />
      <button type="button" className="btn small" disabled={liste.length >= 10} onClick={() => datei.current?.click()}>
        Datei hinzufügen
      </button>
      {fehler && <p className="mail-form__error">{fehler}</p>}
    </div>
  );
}
