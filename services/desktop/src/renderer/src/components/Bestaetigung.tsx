// Einstellungen (docs/PLAN_EINSTELLUNGEN_UI.md §4): eigener Bestaetigungsdialog
// statt window.confirm. Zerstoerende Aktionen rot.
//
// Zwei Wege: <Bestaetigung> als gesteuerte Komponente, oder `bestaetigen(...)`
// als Promise von ueberall im Renderer. Dafuer haengt <BestaetigungHost> einmal
// in der AppShell; ohne Host faellt `bestaetigen` auf window.confirm zurueck.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export function Bestaetigung({
  offen,
  titel,
  text,
  bestaetigen = "Ja",
  abbrechen = "Abbrechen",
  zerstoerend = false,
  laeuft = false,
  onBestaetigen,
  onAbbrechen,
}: {
  offen: boolean;
  titel: string;
  text?: ReactNode;
  bestaetigen?: string;
  abbrechen?: string;
  zerstoerend?: boolean;
  laeuft?: boolean;
  onBestaetigen: () => void;
  onAbbrechen: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!offen) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onAbbrechen();
    };
    window.addEventListener("keydown", h);
    ref.current?.querySelector<HTMLButtonElement>("button[data-primaer]")?.focus();
    return () => window.removeEventListener("keydown", h);
  }, [offen, onAbbrechen]);
  if (!offen) return null;
  // Ein Text mit Leerzeilen wird zu Absaetzen.
  const inhalt =
    typeof text === "string"
      ? text.split(/\n\s*\n/).map((abs, i) => <p key={i}>{abs}</p>)
      : text;
  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={onAbbrechen}>
      <div ref={ref} className="ek-dialog" role="dialog" aria-modal="true" aria-labelledby="ek-dialog-titel" onClick={(e) => e.stopPropagation()}>
        <h4 id="ek-dialog-titel">{titel}</h4>
        {inhalt && <div className="ek-dialog__text">{inhalt}</div>}
        <div className="ek-dialog__aktionen">
          <button type="button" className="btn" onClick={onAbbrechen} disabled={laeuft}>
            {abbrechen}
          </button>
          <button type="button" className={`btn ${zerstoerend ? "btn--gefahr" : "btn--primaer"}`} data-primaer onClick={onBestaetigen} disabled={laeuft}>
            {laeuft ? "Bitte warten …" : bestaetigen}
          </button>
        </div>
      </div>
    </div>
  );
}

export type BestaetigungsFrage = {
  titel: string;
  text?: ReactNode;
  /** Beschriftung des bestaetigenden Knopfs, Standard "Ja". */
  bestaetigen?: string;
  abbrechen?: string;
  zerstoerend?: boolean;
};

type Anfrage = { frage: BestaetigungsFrage; antwort: (ok: boolean) => void };

let hostSetzer: ((a: Anfrage | null) => void) | null = null;

/** Fragt den Nutzer; loest mit true auf, wenn er bestaetigt. */
export function bestaetigen(frage: BestaetigungsFrage | string): Promise<boolean> {
  const f = typeof frage === "string" ? { titel: frage } : frage;
  if (!hostSetzer) {
    const textTeil = typeof f.text === "string" ? `\n\n${f.text}` : "";
    return Promise.resolve(window.confirm(`${f.titel}${textTeil}`));
  }
  const setzer = hostSetzer;
  return new Promise((resolve) => setzer({ frage: f, antwort: resolve }));
}

/** Einmal in der AppShell einhaengen. */
export function BestaetigungHost() {
  const [anfrage, setAnfrage] = useState<Anfrage | null>(null);
  useEffect(() => {
    hostSetzer = setAnfrage;
    return () => {
      if (hostSetzer === setAnfrage) hostSetzer = null;
    };
  }, []);
  if (!anfrage) return null;
  const schliessen = (ok: boolean) => {
    anfrage.antwort(ok);
    setAnfrage(null);
  };
  return (
    <Bestaetigung
      offen
      titel={anfrage.frage.titel}
      text={anfrage.frage.text}
      bestaetigen={anfrage.frage.bestaetigen}
      abbrechen={anfrage.frage.abbrechen}
      zerstoerend={anfrage.frage.zerstoerend}
      onBestaetigen={() => schliessen(true)}
      onAbbrechen={() => schliessen(false)}
    />
  );
}
