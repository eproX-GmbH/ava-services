// docs/PLAN_PROBLEM_MELDEN.md M2 — „Problem melden“: Dialog mit Kategorie, Titel,
// Beschreibung, Dateien, Liste dessen, was mitgeht (Protokolle, Angaben zum
// Geraet), Haken fuer Chat-Auszug und Bildschirmfoto; danach Kennung. Zweite
// Ansicht „Meine Problemmeldungen“ mit Verlauf und Antwort an das AVA-Team.
// Einmal in der AppShell einhaengen; oeffnen ueber problemMeldenOeffnen().
import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, Mail, ChevronLeft, LifeBuoy, X } from "lucide-react";
import { PROBLEM_KATEGORIEN, PROBLEM_STATUS_TEXT, type MeldungDetail, type MeineMeldungen, type ProblemEingabe, type ProblemErgebnis } from "../../../shared/problem";

export interface ProblemOeffnenDetail {
  ansicht?: "neu" | "liste";
  conversationId?: string | null;
  chatAuszug?: ProblemEingabe["chatAuszug"];
  companyId?: string | null;
  vorgabe?: { kategorie?: string; titel?: string; beschreibung?: string };
}

export function problemMeldenOeffnen(detail: ProblemOeffnenDetail = {}): void {
  window.dispatchEvent(new CustomEvent<ProblemOeffnenDetail>("ava:problem-melden", { detail }));
}

/** Zaehler ungelesener Antworten des AVA-Teams (fuer den Knopf im Chat). */
export function useProblemUngelesen(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    window.api.problem.ungelesen().then((x) => { if (alive) setN(x); }).catch(() => undefined);
    const ab = window.api.problem.onUngelesen((x) => setN(x));
    return () => { alive = false; ab(); };
  }, []);
  return n;
}

const MAX_DATEIEN = 3;
const MAX_BYTES = 5 * 1024 * 1024;
const kb = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

async function dateiLesen(f: File): Promise<{ name: string; mime: string; base64: string }> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { name: f.name, mime: f.type || "application/octet-stream", base64: btoa(bin) };
}

export function ProblemDialogHost() {
  const [offen, setOffen] = useState<ProblemOeffnenDetail | null>(null);
  useEffect(() => {
    const h = (e: Event) => setOffen((e as CustomEvent<ProblemOeffnenDetail>).detail ?? {});
    window.addEventListener("ava:problem-melden", h);
    return () => window.removeEventListener("ava:problem-melden", h);
  }, []);
  if (!offen) return null;
  return <ProblemDialog detail={offen} onSchliessen={() => setOffen(null)} />;
}

function ProblemDialog({ detail, onSchliessen }: { detail: ProblemOeffnenDetail; onSchliessen: () => void }) {
  const [ansicht, setAnsicht] = useState<"neu" | "liste" | "detail">(detail.ansicht ?? "neu");
  const [detailId, setDetailId] = useState<string | null>(null);
  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={onSchliessen}>
      <div className="ek-dialog ek-dialog--breit problem-dialog" role="dialog" aria-modal="true" aria-labelledby="problem-titel" onClick={(e) => e.stopPropagation()}>
        <div className="problem-dialog__kopf">
          {ansicht === "detail" ? (
            <button type="button" className="problem-dialog__zurueck" onClick={() => setAnsicht("liste")}>
              <ChevronLeft className="ct-icon-sm" aria-hidden="true" /> Meine Meldungen
            </button>
          ) : (
            <h4 id="problem-titel"><LifeBuoy className="ct-icon-sm" aria-hidden="true" /> {ansicht === "neu" ? "Problem melden" : "Meine Problemmeldungen"}</h4>
          )}
          <div className="problem-dialog__kopf-rechts">
            {ansicht !== "detail" && (
              <div className="problem-dialog__tabs" role="tablist">
                <button type="button" role="tab" aria-selected={ansicht === "neu"} className={`ct-pill${ansicht === "neu" ? " ct-pill--aktiv" : ""}`} onClick={() => setAnsicht("neu")}>Neu</button>
                <button type="button" role="tab" aria-selected={ansicht === "liste"} className={`ct-pill${ansicht === "liste" ? " ct-pill--aktiv" : ""}`} onClick={() => setAnsicht("liste")}>Meine Meldungen</button>
              </div>
            )}
            <button type="button" className="problem-dialog__schliessen" onClick={onSchliessen} aria-label="Schließen" title="Schließen">
              <X className="ct-icon-sm" aria-hidden="true" />
            </button>
          </div>
        </div>
        {ansicht === "neu" && <NeueMeldung detail={detail} onFertig={() => setAnsicht("liste")} onSchliessen={onSchliessen} />}
        {ansicht === "liste" && <MeldungsListe onOeffnen={(id) => { setDetailId(id); setAnsicht("detail"); }} />}
        {ansicht === "detail" && detailId && <MeldungAnsicht id={detailId} onZurueck={() => setAnsicht("liste")} />}
      </div>
    </div>
  );
}

function NeueMeldung({ detail, onFertig, onSchliessen }: { detail: ProblemOeffnenDetail; onFertig: () => void; onSchliessen: () => void }) {
  const [kategorie, setKategorie] = useState(detail.vorgabe?.kategorie ?? "fehler");
  const [titel, setTitel] = useState(detail.vorgabe?.titel ?? "");
  const [beschreibung, setBeschreibung] = useState(detail.vorgabe?.beschreibung ?? "");
  const [dateien, setDateien] = useState<File[]>([]);
  const [chatAuszug, setChatAuszug] = useState(false);
  const [bildschirmfoto, setBildschirmfoto] = useState(true);
  const [inhalt, setInhalt] = useState<Array<{ datei: string; was: string }>>([]);
  const [zeigeInhalt, setZeigeInhalt] = useState(false);
  const [laeuft, setLaeuft] = useState<"nein" | "senden" | "mail">("nein");
  const [ergebnis, setErgebnis] = useState<ProblemErgebnis | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);
  useEffect(() => { window.api.problem.inhalt().then(setInhalt).catch(() => undefined); }, []);
  const hatChat = (detail.chatAuszug?.length ?? 0) > 0;

  const dateienWaehlen = (liste: FileList | null) => {
    if (!liste) return;
    const neu = [...dateien];
    for (const f of Array.from(liste)) {
      if (neu.length >= MAX_DATEIEN) { setFehler(`Höchstens ${MAX_DATEIEN} Dateien.`); break; }
      if (f.size > MAX_BYTES) { setFehler(`„${f.name}“ ist größer als 5 MB.`); continue; }
      neu.push(f);
    }
    setDateien(neu);
  };
  const absenden = async (alsMail: boolean) => {
    if (titel.trim().length < 3 || beschreibung.trim().length < 10) { setFehler("Bitte einen Titel und eine Beschreibung (mindestens ein Satz) angeben."); return; }
    setFehler(null);
    setLaeuft(alsMail ? "mail" : "senden");
    try {
      const r = await window.api.problem.melden({
        kategorie, titel: titel.trim(), beschreibung: beschreibung.trim(), quelle: "dialog",
        conversationId: detail.conversationId ?? null, companyId: detail.companyId ?? null,
        dateien: await Promise.all(dateien.map(dateiLesen)),
        chatAuszug: chatAuszug && hatChat ? detail.chatAuszug : null,
        bildschirmfoto, alsMail,
      });
      setErgebnis(r);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : String(e));
    } finally {
      setLaeuft("nein");
    }
  };

  if (ergebnis) {
    return (
      <div className="problem-dialog__ergebnis">
        {ergebnis.weg === "gateway" && (
          <>
            <p><strong>Danke, deine Meldung ist angekommen.</strong></p>
            <p>Kennung <code>{ergebnis.kennung}</code>. Wir melden uns hier in AVA; du siehst Antworten unter „Meine Meldungen“ und als Meldung oben rechts.</p>
          </>
        )}
        {ergebnis.weg === "mail" && (
          <>
            <p><strong>E-Mail vorbereitet.</strong></p>
            <p>{ergebnis.hinweis}</p>
          </>
        )}
        {ergebnis.weg === "fehler" && <p className="error">{ergebnis.fehler}</p>}
        <div className="ek-dialog__aktionen">
          {ergebnis.weg === "gateway" && <button type="button" className="btn" onClick={onFertig}>Meine Meldungen</button>}
          <button type="button" className="btn btn--primaer" onClick={onSchliessen}>Schließen</button>
        </div>
      </div>
    );
  }

  return (
    <div className="problem-dialog__formular">
      <div className="problem-dialog__kategorien" role="radiogroup" aria-label="Kategorie">
        {PROBLEM_KATEGORIEN.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kategorie === k.id} className={`ct-pill${kategorie === k.id ? " ct-pill--aktiv" : ""}`} onClick={() => setKategorie(k.id)}>{k.label}</button>
        ))}
      </div>
      <label className="problem-dialog__feld">
        <span>Titel</span>
        <input type="text" value={titel} maxLength={120} onChange={(e) => setTitel(e.target.value)} placeholder="Kurz: was ist das Problem?" autoFocus />
      </label>
      <label className="problem-dialog__feld">
        <span>Beschreibung</span>
        <textarea value={beschreibung} rows={5} maxLength={6000} onChange={(e) => setBeschreibung(e.target.value)} placeholder="Was hast du getan, was ist passiert, was hast du erwartet? Firmennamen oder Schritte helfen uns." />
      </label>
      <div className="problem-dialog__dateien">
        <button type="button" className="btn" onClick={() => dateiRef.current?.click()} disabled={dateien.length >= MAX_DATEIEN}>
          <Paperclip className="ct-icon-sm" aria-hidden="true" /> Bild oder Datei anhängen
        </button>
        <input ref={dateiRef} type="file" hidden multiple accept="image/*,.pdf,.txt,.csv,.json,.md" onChange={(e) => { dateienWaehlen(e.target.files); e.currentTarget.value = ""; }} />
        {dateien.map((f) => (
          <span key={f.name} className="ct-pill ct-pill--muted">
            {f.name} · {kb(f.size)}
            <button type="button" className="btn btn--leise" aria-label={`${f.name} entfernen`} onClick={() => setDateien(dateien.filter((x) => x !== f))}>×</button>
          </span>
        ))}
        <span className="muted small">bis zu {MAX_DATEIEN} Dateien, je 5 MB</span>
      </div>
      <div className="problem-dialog__mitgeht">
        <div className="problem-dialog__mitgeht-kopf">
          <strong>Was automatisch mitgeht</strong>
          <button type="button" className="link is-inline" onClick={() => setZeigeInhalt((v) => !v)}>{zeigeInhalt ? "weniger" : "Einzelheiten"}</button>
        </div>
        <p className="muted small">Protokolle der App und der Verarbeitungsschritte, Versionen, dein Plan und Kontingent, Hintergrundaufgaben. Schlüssel, Passwörter und Tokens werden vorher maskiert. Wir nutzen das nur zur Fehlerbehebung und löschen Anhänge 90 Tage nach Abschluss.</p>
        {zeigeInhalt && (
          <ul className="problem-dialog__inhalt">
            {inhalt.map((i) => (<li key={i.datei}><code>{i.datei}</code> <span className="muted">{i.was}</span></li>))}
          </ul>
        )}
        <label className="problem-dialog__haken"><input type="checkbox" checked={bildschirmfoto} onChange={(e) => setBildschirmfoto(e.target.checked)} /> Bildschirmfoto des AVA-Fensters beilegen</label>
        <label className={`problem-dialog__haken${hatChat ? "" : " muted"}`}><input type="checkbox" disabled={!hatChat} checked={chatAuszug && hatChat} onChange={(e) => setChatAuszug(e.target.checked)} /> Die letzten Schritte dieses Gesprächs beilegen{hatChat ? "" : " (kein Gespräch offen)"}</label>
      </div>
      {fehler && <p className="error">{fehler}</p>}
      <div className="ek-dialog__aktionen problem-dialog__aktionen">
        <button type="button" className="btn" onClick={onSchliessen} disabled={laeuft !== "nein"}>Abbrechen</button>
        <button type="button" className="btn" onClick={() => void absenden(true)} disabled={laeuft !== "nein"} title="Fertige E-Mail an info@eprox-gmbh.de mit allem als Anhang; du musst nur noch senden">
          <Mail className="ct-icon-sm" aria-hidden="true" /> {laeuft === "mail" ? "Wird vorbereitet …" : "Als E-Mail vorbereiten"}
        </button>
        <button type="button" className="btn btn--primaer" onClick={() => void absenden(false)} disabled={laeuft !== "nein"}>
          <Send className="ct-icon-sm" aria-hidden="true" /> {laeuft === "senden" ? "Wird gesendet …" : "Senden"}
        </button>
      </div>
    </div>
  );
}

function MeldungsListe({ onOeffnen }: { onOeffnen: (id: string) => void }) {
  const [daten, setDaten] = useState<MeineMeldungen | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  useEffect(() => { window.api.problem.meine().then(setDaten).catch((e) => setFehler(e instanceof Error ? e.message : String(e))); }, []);
  return (
    <div className="problem-dialog__liste">
      {fehler && <p className="error">{fehler}</p>}
      {daten && daten.meldungen.length === 0 && <p className="muted">Du hast noch kein Problem gemeldet.</p>}
      {daten && daten.meldungen.length > 0 && (
        <ul>
          {daten.meldungen.map((m) => (
            <li key={m.id}>
              <button type="button" className="problem-dialog__zeile" onClick={() => onOeffnen(m.id)}>
                <span className="problem-dialog__zeile-oben">
                  <span className="problem-dialog__zeile-titel">{m.titel}</span>
                  <span className={`ct-pill ct-pill--muted problem-status problem-status--${m.status}`}>{PROBLEM_STATUS_TEXT[m.status] ?? m.status}</span>
                  {m.ungelesenNutzer && <span className="ct-pill ct-pill--aktiv">neue Antwort</span>}
                </span>
                {m.letzteNachricht && <span className="problem-dialog__zeile-vorschau muted small">{m.letzteNachricht.slice(0, 140)}</span>}
                <span className="problem-dialog__meta muted small"><code>{m.kennung}</code><span>·</span><span>{new Date(m.updatedAt).toLocaleDateString("de-DE")}</span></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MeldungAnsicht({ id, onZurueck }: { id: string; onZurueck: () => void }) {
  const [d, setD] = useState<MeldungDetail | null>(null);
  const [text, setText] = useState("");
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const dateiRef = useRef<HTMLInputElement>(null);
  const laden = () => window.api.problem.lesen(id).then((x) => { setD(x); if (x.meldung.ungelesenNutzer) void window.api.problem.gelesen(id); }).catch((e) => setFehler(e instanceof Error ? e.message : String(e)));
  useEffect(() => { void laden(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);
  const antworten = async () => {
    if (text.trim().length === 0) return;
    setLaeuft(true);
    try { await window.api.problem.antworten(id, text.trim()); setText(""); await laden(); } catch (e) { setFehler(e instanceof Error ? e.message : String(e)); } finally { setLaeuft(false); }
  };
  const nachreichen = async (liste: FileList | null) => {
    if (!liste || liste.length === 0) return;
    setLaeuft(true);
    try { await window.api.problem.nachreichen(id, await Promise.all(Array.from(liste).slice(0, 3).map(dateiLesen))); await laden(); } catch (e) { setFehler(e instanceof Error ? e.message : String(e)); } finally { setLaeuft(false); }
  };
  if (!d) return <p className="muted">{fehler ?? "Wird geladen …"}</p>;
  void onZurueck;
  const m = d.meldung;
  return (
    <div className="problem-dialog__detail">
      <header className="problem-dialog__detail-kopf">
        <h5 id="problem-titel">{m.titel}</h5>
        <div className="problem-dialog__meta">
          <span className={`ct-pill ct-pill--muted problem-status problem-status--${m.status}`}>{PROBLEM_STATUS_TEXT[m.status] ?? m.status}</span>
          <span className="muted small">{PROBLEM_KATEGORIEN.find((k) => k.id === m.kategorie)?.label ?? m.kategorie}</span>
          <span className="muted small">·</span>
          <code className="muted small">{m.kennung}</code>
          <span className="muted small">·</span>
          <span className="muted small">{new Date(m.createdAt).toLocaleDateString("de-DE")}</span>
        </div>
      </header>
      <section className="problem-dialog__block">
        <p className="problem-dialog__beschreibung">{m.beschreibung}</p>
        {d.anhaenge.length > 0 && (
          <div className="problem-dialog__anhaenge">
            {d.anhaenge.map((a) => (
              <span key={a.id} className="ct-pill ct-pill--muted" title={a.verfuegbar ? a.dateiname : "Aufbewahrung abgelaufen"}>
                <Paperclip className="ct-icon-sm" aria-hidden="true" /> {a.dateiname} · {kb(a.groesse)}
              </span>
            ))}
          </div>
        )}
      </section>
      <ol className="problem-dialog__verlauf" aria-label="Verlauf">
        {d.nachrichten.map((n) => (
          <li key={n.id} className={`problem-dialog__nachricht problem-dialog__nachricht--${n.von}${n.art !== "nachricht" ? " problem-dialog__nachricht--system" : ""}`}>
            <span className="muted small">{n.von === "betreiber" ? `AVA-Team${n.actorName ? ` (${n.actorName})` : ""}` : n.von === "nutzer" ? "Du" : ""} · {new Date(n.createdAt).toLocaleString("de-DE")}</span>
            <span>{n.text}</span>
          </li>
        ))}
      </ol>
      {m.status !== "geschlossen" && m.status !== "abgelehnt" && (
        <div className="problem-dialog__antwort">
          <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Antwort an das AVA-Team …" />
          <div className="problem-dialog__aktionen">
            <button type="button" className="btn" onClick={() => dateiRef.current?.click()} disabled={laeuft}><Paperclip className="ct-icon-sm" aria-hidden="true" /> Datei nachreichen</button>
            <input ref={dateiRef} type="file" hidden multiple accept="image/*,.pdf,.txt,.csv,.json,.md" onChange={(e) => { void nachreichen(e.target.files); e.currentTarget.value = ""; }} />
            <button type="button" className="btn btn--primaer" onClick={() => void antworten()} disabled={laeuft || text.trim().length === 0}><Send className="ct-icon-sm" aria-hidden="true" /> Antworten</button>
          </div>
        </div>
      )}
      {fehler && <p className="error">{fehler}</p>}
    </div>
  );
}
