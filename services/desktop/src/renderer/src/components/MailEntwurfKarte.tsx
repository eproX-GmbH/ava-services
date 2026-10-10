// Mail-Entwurf im Chat (docs/PLAN_MAIL_ENTWURF.md): zeigt Empfänger, Betreff,
// Text und Anhänge eines ```mail-entwurf-Blocks und öffnet ihn im Mail-Programm.
// Den Weg wählt der Hauptprozess (Outlook → .eml, sonst mailto:, ohne Programm Webmail).

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { mailEntwurfAlsText, mailEntwurfLesen, ZIEL_TEXT, type MailEntwurfZiel } from "../../../shared/mail-entwurf";
import { ChevronDownIcon, CopyIcon, MailIcon, PaperclipIcon } from "./icons";

type Ergebnis = Awaited<ReturnType<typeof window.api.mailEntwurf.oeffnen>>;

const WEG_TEXT: Record<string, string> = { gmail: "Gmail", "outlook-web": "Outlook im Web", "outlook-live": "Outlook.com" };
const ANDERE: MailEntwurfZiel[] = ["programm", "eml", "postfach", "gmail", "outlook-web", "outlook-live"];

async function kopieren(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
}

export function MailEntwurfKarte({ raw }: { raw: string }) {
  const r = mailEntwurfLesen(raw);
  const hatAnhaenge = "entwurf" in r && r.entwurf.anhaenge.length > 0;
  const stand = useQuery({ queryKey: ["mail-entwurf-stand", hatAnhaenge], queryFn: () => window.api.mailEntwurf.stand(hatAnhaenge), staleTime: 60_000 });
  const [laeuft, setLaeuft] = useState(false);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [menue, setMenue] = useState(false);
  const menueRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menue) return;
    const zu = (ev: MouseEvent) => {
      if (!menueRef.current?.contains(ev.target as Node)) setMenue(false);
    };
    document.addEventListener("mousedown", zu);
    return () => document.removeEventListener("mousedown", zu);
  }, [menue]);

  if ("fehler" in r) {
    return (
      <div className="chart-fallback">
        <div className="hint">Der Mail-Entwurf konnte nicht angezeigt werden: {r.fehler}</div>
        <details className="chart-fallback-details">
          <summary>Rohdaten</summary>
          <pre>{raw}</pre>
        </details>
      </div>
    );
  }
  const e = r.entwurf;

  const oeffnen = async (weg?: MailEntwurfZiel) => {
    setMenue(false);
    setLaeuft(true);
    setMeldung(null);
    try {
      const x = await window.api.mailEntwurf.oeffnen({ raw, weg });
      setErgebnis(x);
      if (x.fehler) setMeldung(x.fehler);
      else if (x.weg === "postfach") setMeldung(`Der Entwurf liegt in deinem Postfach im Ordner „${x.ordner ?? "Entwürfe"}“ – dort öffnen und senden.`);
    } catch (err) {
      setMeldung(err instanceof Error ? err.message : String(err));
    } finally {
      setLaeuft(false);
    }
  };
  const ordnerZeigen = async () => {
    const x = await window.api.mailEntwurf.anhaengeZeigen({ raw });
    setMeldung(x.ok ? `${x.anzahl === 1 ? "Der Anhang liegt" : `${x.anzahl} Anhänge liegen`} im geöffneten Ordner – zum Anhängen in die Mail ziehen.` : x.fehler);
  };
  const textKopieren = async () => {
    try {
      await kopieren(mailEntwurfAlsText(e));
      setMeldung("Entwurf kopiert.");
    } catch {
      setMeldung("Kopieren ging nicht.");
    }
  };

  const s = stand.data;
  const keinProgramm = s?.weg === "keins";
  const hauptText =
    s?.weg === "eml" || s?.weg === "mailto"
      ? `In ${s.programm ?? "Mail-Programm"} öffnen`
      : s?.weg === "postfach"
        ? "In meine Entwürfe legen"
        : s && WEG_TEXT[s.weg]
          ? `In ${WEG_TEXT[s.weg]} öffnen`
          : "Im Mail-Programm öffnen";
  const festName = new Map((s?.festeAnhaenge ?? []).map((a) => [a.id, a.name]));
  const andere = ANDERE.filter((z) => z !== "postfach" || s?.postfach);

  return (
    <div className="mail-entwurf">
      <div className="mail-entwurf__kopf">
        <MailIcon width={16} height={16} />
        <span>E-Mail-Entwurf</span>
      </div>
      <dl className="mail-entwurf__felder">
        <dt>An</dt>
        <dd>{e.an.length ? e.an.join(", ") : <span className="mail-entwurf__fehlt">Adresse fehlt – im Mail-Programm ergänzen</span>}</dd>
        {e.cc.length > 0 && (
          <>
            <dt>Cc</dt>
            <dd>{e.cc.join(", ")}</dd>
          </>
        )}
        <dt>Betreff</dt>
        <dd>{e.betreff || <span className="mail-entwurf__fehlt">ohne Betreff</span>}</dd>
      </dl>
      <div className="mail-entwurf__text">{e.text}</div>
      {e.anhaenge.length > 0 && (
        <ul className="mail-entwurf__anhaenge">
          {e.anhaenge.map((a) => (
            <li key={a}>
              <PaperclipIcon width={13} height={13} /> {festName.get(a) ?? a}
            </li>
          ))}
        </ul>
      )}

      <div className="mail-entwurf__aktionen">
        {keinProgramm ? (
          <>
            <button type="button" className="mail-entwurf__haupt" disabled={laeuft} onClick={() => void oeffnen("gmail")}>
              <MailIcon width={15} height={15} /> In Gmail öffnen
            </button>
            <button type="button" className="btn small" disabled={laeuft} onClick={() => void oeffnen("outlook-web")}>
              In Outlook im Web öffnen
            </button>
          </>
        ) : (
          <button type="button" className="mail-entwurf__haupt" disabled={laeuft || stand.isLoading} onClick={() => void oeffnen()}>
            <MailIcon width={15} height={15} /> {hauptText}
          </button>
        )}
        <button type="button" className="btn small" onClick={() => void textKopieren()}>
          <CopyIcon width={14} height={14} /> Kopieren
        </button>
        <div className="mail-entwurf__menue" ref={menueRef}>
          <button type="button" className="btn small" aria-haspopup="menu" aria-expanded={menue} onClick={() => setMenue((m) => !m)}>
            Anders öffnen <ChevronDownIcon width={14} height={14} />
          </button>
          {menue && (
            <div className="mail-entwurf__liste" role="menu">
              {andere.map((z) => (
                <button key={z} type="button" role="menuitem" onClick={() => void oeffnen(z)}>
                  {z === "programm" ? `${s?.programm ?? "Mail-Programm"} (ohne Anhänge)` : z === "postfach" ? `Entwürfe-Ordner (${s?.postfach?.absender ?? "Postfach"})` : ZIEL_TEXT[z]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {keinProgramm && <p className="mail-entwurf__hinweis">Auf diesem Rechner ist kein Mail-Programm eingerichtet.</p>}
      {ergebnis?.anhaengeFehlen && !ergebnis.fehler && (
        <div className="mail-entwurf__hinweis">
          <span>Dieser Weg kann keine Anhänge mitgeben.</span>
          {s?.postfach && (
            <button type="button" className="btn small" onClick={() => void oeffnen("postfach")}>
              In meine Entwürfe legen
            </button>
          )}
          <button type="button" className="btn small" onClick={() => void oeffnen("eml")}>
            Mit Anhängen als Datei öffnen
          </button>
          <button type="button" className="btn small" onClick={() => void ordnerZeigen()}>
            Anhänge im Ordner zeigen
          </button>
        </div>
      )}
      {ergebnis?.weg === "eml" && !ergebnis.fehler && !/outlook/i.test(ergebnis.programm ?? "") && (
        <p className="mail-entwurf__hinweis">Öffnet sich die Mail nur zum Lesen, dort „Erneut senden“ bzw. „Als neu bearbeiten“ wählen.</p>
      )}
      {meldung && <p className={ergebnis?.fehler ? "mail-entwurf__hinweis mail-entwurf__hinweis--fehler" : "mail-entwurf__hinweis"}>{meldung}</p>}
    </div>
  );
}
