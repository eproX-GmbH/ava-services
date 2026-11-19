// Reiter „Zeitachse“ der Firmenansicht (Firmenhistorie H3, Vorlage: ava-app
// components/firmen/zeitachse.tsx): Personalwechsel, Register- und Profiländerungen,
// Insolvenz-Ereignisse, Meldungen, Recherche-Läufe, Notizen und Jahresabschlüsse als
// Marken auf einer Achse, jüngstes zuerst, nach Monaten gegliedert. Oben die
// Notiz-Eingabe, darunter Filter-Chips (Mehrfachauswahl), unten „Ältere laden“.
// Jede Quelle hat ihren eigenen Zustand: Eine, die noch lädt, steht als Zeile unter der
// Achse; eine, die scheitert, als Fehlerzeile mit „Neu laden“, ohne die anderen zu blockieren.

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  BellRing,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  FileSpreadsheet,
  Gavel,
  Landmark,
  LoaderCircle,
  MessageCircle,
  NotebookPen,
  RotateCcw,
  Search,
  Send,
  Trash2,
  TriangleAlert,
  UserRoundPen,
  UsersRound,
  type LucideIcon,
} from "lucide-react";
import { GatewayError } from "../api/gateway";
import { useAuthStore } from "../store/auth";
import { bestaetigen } from "./Bestaetigung";
import { ARTEN, ART_INFO, genau, gruppe, nichtVorhanden, relativ, useNotizAnlegen, useNotizLoeschen, useZeitachse, type Art, type Eintrag, type Quellen } from "../lib/zeitachse";

const STAPEL = 25;
const NOTIZ_MIN = 3;
const NOTIZ_MAX = 20_000;
const KLAPP_AB = 280;

const ART_ICON: Record<Art, LucideIcon> = {
  notiz: NotebookPen,
  personal: UsersRound,
  register: Landmark,
  profil: UserRoundPen,
  insolvenz: Gavel,
  meldung: BellRing,
  recherche: Search,
  abschluss: FileSpreadsheet,
};

type QuellenKey = Exclude<keyof Quellen, "stand">;
const QUELLEN_TEXT: Record<QuellenKey, string> = {
  register: "Register-Verlauf",
  profil: "Profiländerungen",
  personal: "Personalwechsel",
  insolvenz: "Insolvenz-Ereignisse",
  meldung: "Meldungen",
  recherche: "Recherche-Läufe",
  notiz: "Notizen",
  abschluss: "Jahresabschlüsse",
};
const QUELLEN_KEYS: QuellenKey[] = ["personal", "register", "profil", "insolvenz", "meldung", "recherche", "notiz", "abschluss"];

const fehlerText = (e: unknown) => (e instanceof GatewayError ? e.message : e instanceof Error ? e.message : "Unbekannter Fehler");

// ---- Notiz anlegen ---------------------------------------------------------------------

function NotizEingabe({ companyId, name }: { companyId: string; name: string }) {
  const actorId = useAuthStore((s) => s.actorId);
  const anlegen = useNotizAnlegen(companyId, actorId);
  const [text, setText] = useState("");
  const [offen, setOffen] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const laenge = text.trim().length;
  const kann = laenge >= NOTIZ_MIN && laenge <= NOTIZ_MAX && !anlegen.isPending;
  const auf = offen || text.length > 0;
  const speichern = () => {
    if (!kann) return;
    const inhalt = text.trim();
    setText("");
    setFehler(null);
    anlegen.mutate(
      { text: inhalt },
      {
        onError: (e) => {
          setText(inhalt);
          setFehler(`Die Notiz konnte nicht gespeichert werden: ${fehlerText(e)}`);
        },
      },
    );
  };
  return (
    <form
      className={`zeitachse__notiz${auf ? " zeitachse__notiz--offen" : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        speichern();
      }}
    >
      <label htmlFor="zeitachse-notiz" className="sr-only">
        Notiz zu {name}
      </label>
      <div className="zeitachse__notiz-zeile">
        <span className="zeitachse__symbol zeitachse__symbol--notiz" aria-hidden>
          <NotebookPen size={16} />
        </span>
        <textarea
          id="zeitachse-notiz"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOffen(true)}
          onBlur={() => !text && setOffen(false)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              speichern();
            }
          }}
          placeholder={auf ? "Gespräch, Eindruck, nächster Schritt …" : "Notiz festhalten …"}
          maxLength={NOTIZ_MAX}
          rows={auf ? 3 : 1}
        />
      </div>
      {auf && (
        <div className="zeitachse__notiz-fuss">
          <span className="zeitachse__leise">
            Sichtbar für deine Organisation. {laenge > 0 && laenge < NOTIZ_MIN ? "Mindestens drei Zeichen." : "⌘ + Enter speichert."}
          </span>
          <span className="zeitachse__knoepfe">
            {text && (
              <button type="button" className="btn btn--leise" onClick={() => setText("")}>
                Verwerfen
              </button>
            )}
            <button type="submit" className="primary" disabled={!kann}>
              {anlegen.isPending ? <LoaderCircle size={14} className="zeitachse__dreht" /> : <Send size={14} />} Notiz speichern
            </button>
          </span>
        </div>
      )}
      {fehler && (
        <p className="error zeitachse__klein" role="alert">
          {fehler}
        </p>
      )}
    </form>
  );
}

// ---- Eintrag -------------------------------------------------------------------------------

function Datum({ eintrag }: { eintrag: Eintrag }) {
  return (
    <time dateTime={eintrag.datum} title={genau(eintrag)} className={`zeitachse__datum${eintrag.von || eintrag.zeitHinweis ? " zeitachse__datum--unsicher" : ""}`}>
      {relativ(eintrag.datum)}
    </time>
  );
}

function Quelle({ quelle, onReiter }: { quelle: Eintrag["quelle"]; onReiter?: (reiter: string) => void }) {
  if (!quelle.url) return <span className="zeitachse__leise">Quelle: {quelle.text}</span>;
  if (quelle.url.startsWith("#")) {
    const ziel = quelle.url.slice(1);
    if (!onReiter) return <span className="zeitachse__leise">Quelle: {quelle.text}</span>;
    return (
      <button type="button" className="link zeitachse__quelle" onClick={() => onReiter(ziel)}>
        Quelle: {quelle.text}
      </button>
    );
  }
  return (
    <a href={quelle.url} target="_blank" rel="noreferrer" className="zeitachse__quelle">
      <ExternalLink size={13} aria-hidden /> Quelle: {quelle.text}
    </a>
  );
}

function Langtext({ text }: { text: string }) {
  const [offen, setOffen] = useState(false);
  const lang = text.length > KLAPP_AB || text.split("\n").length > 4;
  return (
    <div>
      <p className={`zeitachse__langtext${!offen && lang ? " zeitachse__langtext--zu" : ""}`}>{text}</p>
      {lang && (
        <button type="button" className="link zeitachse__mehr" aria-expanded={offen} onClick={() => setOffen((o) => !o)}>
          {offen ? "Weniger anzeigen" : "Mehr anzeigen"} <ChevronDown size={13} className={offen ? "zeitachse__gedreht" : undefined} />
        </button>
      )}
    </div>
  );
}

function EintragZeile({ eintrag, onAva, onReiter, onLoeschen, loescht }: { eintrag: Eintrag; onAva: (frage: string) => void; onReiter?: (reiter: string) => void; onLoeschen?: () => void; loescht?: boolean }) {
  const Icon = ART_ICON[eintrag.art];
  const vorlaeufig = eintrag.notiz?.vorlaeufig === true;

  if (eintrag.marke) {
    return (
      <li className="zeitachse__eintrag zeitachse__eintrag--marke">
        <span className="zeitachse__raute" aria-hidden />
        <div className="zeitachse__marke-text">
          <strong>{eintrag.titel}</strong>
          {eintrag.text && <span className="zeitachse__leise">{eintrag.text}</span>}
          <Datum eintrag={eintrag} />
          <Quelle quelle={eintrag.quelle} onReiter={onReiter} />
        </div>
        <button type="button" className="zeitachse__ava-icon" aria-label="Mit AVA besprechen" title="Mit AVA besprechen" onClick={() => onAva(eintrag.frage)}>
          <MessageCircle size={15} />
        </button>
      </li>
    );
  }

  return (
    <li className={`zeitachse__eintrag${vorlaeufig ? " zeitachse__eintrag--vorlaeufig" : ""}`}>
      <span className={`zeitachse__symbol zeitachse__symbol--${eintrag.art}`} aria-hidden>
        {vorlaeufig ? <LoaderCircle size={16} className="zeitachse__dreht" /> : <Icon size={16} />}
      </span>
      <div className="zeitachse__inhalt">
        <div className="zeitachse__kopf">
          <span className="sr-only">{ART_INFO[eintrag.art].label}: </span>
          <h4>{eintrag.titel}</h4>
          {eintrag.pille && <span className={`zeitachse__pille${eintrag.pille === "Fehler" ? " zeitachse__pille--fehler" : ""}`}>{eintrag.pille}</span>}
          <Datum eintrag={eintrag} />
        </div>

        {eintrag.aenderungen && eintrag.aenderungen.length > 0 && (
          <dl className="zeitachse__aenderungen">
            {eintrag.aenderungen.map((a) => (
              <div key={a.name}>
                <dt>{a.name}</dt>
                <dd>
                  {a.vorher && <span className={a.nachher ? "zeitachse__vorher" : undefined}>{a.vorher}</span>}
                  {a.vorher && a.nachher && <ArrowRight size={13} className="zeitachse__pfeil" aria-label="wird zu" />}
                  {a.nachher ? <strong>{a.nachher}</strong> : !a.vorher ? <span className="zeitachse__leise">–</span> : null}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {eintrag.text && <p className="zeitachse__text">{eintrag.text}</p>}
        {eintrag.langtext && <Langtext text={eintrag.langtext} />}

        <div className="zeitachse__fuss">
          <Quelle quelle={eintrag.quelle} onReiter={onReiter} />
          <span className="zeitachse__luecke" />
          {onLoeschen && (
            <button type="button" className="btn btn--leise zeitachse__aktion zeitachse__aktion--loeschen" disabled={loescht || vorlaeufig} onClick={onLoeschen}>
              {loescht ? <LoaderCircle size={14} className="zeitachse__dreht" /> : <Trash2 size={14} />} Löschen
            </button>
          )}
          <button type="button" className="btn btn--leise zeitachse__aktion" disabled={vorlaeufig} onClick={() => onAva(eintrag.frage)}>
            <MessageCircle size={14} /> Mit AVA
          </button>
        </div>
      </div>
    </li>
  );
}

function Hinweis({ icon, titel, children }: { icon: LucideIcon; titel?: string; children: ReactNode }) {
  const Icon = icon;
  return (
    <div className="zeitachse__leer">
      <Icon size={22} aria-hidden />
      {titel && <strong>{titel}</strong>}
      {children}
    </div>
  );
}

// ---- Reiter -------------------------------------------------------------------------------

export function ZeitachseTab({
  id,
  name,
  country,
  websiteUrl,
  an,
  onReiter,
}: {
  id: string;
  name: string | null;
  country: string | null;
  websiteUrl: string | null;
  /** false (ruhende Firma, keine Daten erlaubt) lädt nichts. */
  an: boolean;
  /** Interne Quellen („Finanzen“) springen auf den Reiter. */
  onReiter?: (reiter: string) => void;
}) {
  const navigate = useNavigate();
  const actorId = useAuthStore((s) => s.actorId);
  const anzeigeName = name ?? id;
  const firmaLink = `[${anzeigeName.replace(/[[\]]/g, "")}](company:${id})`;
  const { quellen, eintraege } = useZeitachse(id, { an, ohneRegister: id.startsWith("WEB_"), country, websiteUrl, firmaLink });
  const loeschen = useNotizLoeschen(id);
  const [arten, setArten] = useState<Set<Art>>(new Set());
  const [loeschFehler, setLoeschFehler] = useState<string | null>(null);
  const filterKey = ARTEN.filter((a) => arten.has(a)).join(",");
  const [stapel, setStapel] = useState({ key: filterKey, n: STAPEL });
  const sichtbar = stapel.key === filterKey ? stapel.n : STAPEL;

  const laedt = QUELLEN_KEYS.filter((k) => quellen[k].isPending && quellen[k].fetchStatus !== "idle");
  const fehler = QUELLEN_KEYS.filter((k) => quellen[k].isError && !nichtVorhanden(quellen[k].error));
  const irgendwasDa = QUELLEN_KEYS.some((k) => quellen[k].isSuccess || quellen[k].isError);

  const anzahlJeArt = useMemo(() => {
    const m = new Map<Art, number>();
    for (const e of eintraege) m.set(e.art, (m.get(e.art) ?? 0) + 1);
    return m;
  }, [eintraege]);
  const gefiltert = useMemo(() => (arten.size === 0 ? eintraege : eintraege.filter((e) => arten.has(e.art))), [eintraege, arten]);
  const liste = gefiltert.slice(0, sichtbar);

  const umschalten = (a: Art) => {
    const neu = new Set(arten);
    if (neu.has(a)) neu.delete(a);
    else neu.add(a);
    setArten(neu.size === ARTEN.length ? new Set() : neu);
  };
  const onAva = (frage: string) => navigate("/chat", { state: { prefill: frage } });

  const notizLoeschen = async (e: Eintrag) => {
    if (!e.notiz) return;
    const ok = await bestaetigen({ titel: "Notiz löschen", text: "Die Notiz wird für alle in deiner Organisation entfernt. Das lässt sich nicht rückgängig machen.", bestaetigen: "Löschen", zerstoerend: true });
    if (!ok) return;
    setLoeschFehler(null);
    loeschen.mutate(e.notiz.id, {
      onError: (err) =>
        setLoeschFehler(err instanceof GatewayError && err.status === 404 ? "Nur wer die Notiz geschrieben hat oder ein Admin darf sie löschen." : `Die Notiz konnte nicht gelöscht werden: ${fehlerText(err)}`),
    });
  };
  const darfLoeschen = (e: Eintrag) => Boolean(e.notiz && !e.notiz.vorlaeufig && actorId && e.notiz.actorId === actorId);

  const gruppen: Array<{ schluessel: string; titel: string; eintraege: Eintrag[] }> = [];
  for (const e of liste) {
    const g = gruppe(e.datum);
    const letzte = gruppen[gruppen.length - 1];
    if (letzte && letzte.schluessel === g.schluessel) letzte.eintraege.push(e);
    else gruppen.push({ ...g, eintraege: [e] });
  }

  return (
    <div className="zeitachse">
      <NotizEingabe companyId={id} name={anzeigeName} />

      {(eintraege.length > 0 || arten.size > 0) && (
        <div role="group" aria-label="Nach Art filtern" className="zeitachse__filter">
          <button type="button" aria-pressed={arten.size === 0} className={`zeitachse__chip${arten.size === 0 ? " zeitachse__chip--an" : ""}`} onClick={() => setArten(new Set())}>
            Alle <span className="zeitachse__zahl">{eintraege.length}</span>
          </button>
          {ARTEN.map((a) => {
            const n = anzahlJeArt.get(a) ?? 0;
            const an2 = arten.has(a);
            const Icon = ART_ICON[a];
            if (n === 0 && !an2) return null;
            return (
              <button key={a} type="button" aria-pressed={an2} className={`zeitachse__chip${an2 ? ` zeitachse__chip--an zeitachse__chip--${a}` : ""}`} onClick={() => umschalten(a)}>
                <Icon size={13} aria-hidden />
                {ART_INFO[a].mehrzahl}
                <span className="zeitachse__zahl">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {loeschFehler && (
        <p className="error zeitachse__klein" role="alert">
          {loeschFehler}
        </p>
      )}

      {fehler.length > 0 && (
        <ul className="zeitachse__fehler" aria-label="Quellen mit Fehler">
          {fehler.map((k) => (
            <li key={k} role="alert">
              <TriangleAlert size={15} aria-hidden />
              <span>{QUELLEN_TEXT[k]} konnten nicht geladen werden.</span>
              <button type="button" className="btn" onClick={() => void quellen[k].refetch()}>
                <RotateCcw size={13} /> Neu laden
              </button>
            </li>
          ))}
        </ul>
      )}

      {!irgendwasDa && laedt.length > 0 ? (
        <p className="zeitachse__leise zeitachse__laedt" role="status" aria-live="polite">
          <LoaderCircle size={14} className="zeitachse__dreht" /> Zeitachse lädt …
        </p>
      ) : gefiltert.length === 0 && laedt.length === 0 ? (
        arten.size > 0 ? (
          <Hinweis icon={CalendarClock}>
            <span>Für diese Auswahl gibt es keine Einträge.</span>
            <button type="button" className="btn" onClick={() => setArten(new Set())}>
              Alle anzeigen
            </button>
          </Hinweis>
        ) : (
          <Hinweis icon={CalendarClock} titel="Noch keine Ereignisse">
            <span>Sobald sich im Register, beim Personal, auf der Website oder in deinen Notizen etwas tut, steht es hier. Halte oben eine Notiz fest oder frag AVA nach dem Stand.</span>
          </Hinweis>
        )
      ) : (
        <ol className="zeitachse__achse" aria-label="Zeitachse">
          {gruppen.map((g) => (
            <li key={g.schluessel} className="zeitachse__gruppe">
              <h3 className="zeitachse__gruppentitel">
                <span className="zeitachse__gruppenpunkt" aria-hidden />
                {g.titel}
              </h3>
              <ol className="zeitachse__eintraege">
                {g.eintraege.map((e) => (
                  <EintragZeile
                    key={e.id}
                    eintrag={e}
                    onAva={onAva}
                    onReiter={onReiter}
                    onLoeschen={darfLoeschen(e) ? () => void notizLoeschen(e) : undefined}
                    loescht={loeschen.isPending && loeschen.variables === e.notiz?.id}
                  />
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}

      {laedt.length > 0 && irgendwasDa && (
        <p className="zeitachse__leise zeitachse__laedt" role="status" aria-live="polite">
          <LoaderCircle size={13} className="zeitachse__dreht" /> Lädt noch: {laedt.map((k) => QUELLEN_TEXT[k]).join(", ")} …
        </p>
      )}

      {gefiltert.length > sichtbar && (
        <div className="zeitachse__mehr-laden">
          <button type="button" className="btn" onClick={() => setStapel({ key: filterKey, n: sichtbar + STAPEL })}>
            Ältere laden
          </button>
          <span className="zeitachse__leise">
            {liste.length} von {gefiltert.length}
          </span>
        </div>
      )}
      {gefiltert.length > 0 && gefiltert.length <= sichtbar && laedt.length === 0 && (
        <p className="zeitachse__leise zeitachse__ende">
          {gefiltert.length === 1 ? "Ein Eintrag" : `${gefiltert.length} Einträge`}
          {quellen.meldung.isSuccess ? " · Meldungen der letzten 30 Tage" : ""}
        </p>
      )}
    </div>
  );
}
