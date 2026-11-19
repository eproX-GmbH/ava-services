// Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §5, V6): Reiter in den
// Firmendetails. Netzgrafik wie bei North Data (Firmen als Kaesten, Personen
// als Kreise, Kanten Beteiligung mit Prozent, Geschaeftsfuehrung, Adresse),
// Gesellschaftertabelle der neuesten Liste, Beteiligungen der Firma und der
// Stand der Rekursion (Kontexte) mit "tiefer verfolgen".

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import { PERSON_R, WURZEL_ZEICHEN, kurz, knotenGroesse, labelLage, radialLayout, randPunkt, umriss, type Punkt } from "../lib/netz-layout";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, GatewayError } from "../api/gateway";
import { FirmaUebernehmen, useIstUebernommen } from "../routes/firma-uebernehmen";

type Knoten = { id: string; typ: "FIRMA" | "PERSON"; name: string; land?: string | null; registerStatus?: string | null; insolvencyStatus?: string | null; geburtsjahr?: number | null; wohnort?: string | null; tiefe: number };
type Kante = { von: string; nach: string; art: "BETEILIGUNG" | "GESCHAEFTSFUEHRUNG" | "ADRESSE"; prozent?: number | null; nennbetragEur?: number | null; aktuell: boolean; seit?: string | null; bis?: string | null; quelle: string };
type Netz = { companyId: string; tiefe: number; knoten: Knoten[]; kanten: Kante[]; abgeschnitten: boolean };
type Beteiligung = { id: number; companyId: string; listeDatum: string; typ: "PERSON" | "FIRMA"; personId: string | null; personName: string | null; geburtsjahr: number | null; wohnort: string | null; gesellschafterCompanyId: string | null; gesellschafterFirmaText: string | null; gesellschafterFirmaName?: string | null; anteileNummern: string | null; nennbetragEur: number | null; prozent: number | null; veraenderung: string | null; konfidenz: number; unsicher: boolean };
type Stand = { geprueftAt: string; listeDatum: string | null; ergebnis: "LISTE" | "KEINE" | "UNSICHER" | "FEHLER"; format: string | null; modell: string | null; fehler: string | null; gruende: string[]; dokumentId: number | null };
type Gesellschafter = { companyId: string; stand: Stand | null; gesellschafter: Beteiligung[]; beteiligungen: Beteiligung[] };
// K4: Angaben laut juengstem Konzernabschluss (Gateway /konzern-angaben).
type KonzernTochter = { id: number; name: string; sitz: string | null; land: string | null; anteilProzent: number | null; verbundenSeit: string | null; kerngeschaeft: string | null; match: { companyId: string; name: string; location: string | null; stufe?: "sicher" | "unsicher" } | null };
type KonzernAngaben = { quelle: string | null; jahr: number | null; toechter: KonzernTochter[]; konzernmutter: KonzernTochter | null; geschaeftsfuehrung: Array<{ name: string; status: string; datum: string | null }> };
type Kontext = { kontext: string; ursprungCompanyId: string; transactionId: string; maxTiefe: number; maxFirmen: number; ohneBremse: boolean; erstelltAt: string; offen: number; erledigt: number };

const ART_LABEL: Record<Kante["art"], string> = { BETEILIGUNG: "Beteiligung", GESCHAEFTSFUEHRUNG: "Geschäftsführung", ADRESSE: "gleiche Adresse" };
const ART_FARBE: Record<Kante["art"], string> = { BETEILIGUNG: "#00C0A7", GESCHAEFTSFUEHRUNG: "#5b7cfa", ADRESSE: "#b08a00" };
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const datum = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("de-DE") : "–");

// ---- Netzgrafik (2026-11-19): echte Pixel, radiales Layout, Zoom und Verschieben ----------
// Vorher: feste Zeichenflaeche 920 × 560, auf die Panelbreite hochskaliert — Kreise, Schrift
// und Linien wuchsen mit der Fensterbreite („riesig und bulky“). Jetzt misst die Grafik ihre
// Breite, zeichnet 1:1 und passt den Inhalt nur verkleinernd ein.

function personLabel(k: Knoten): string {
  return `${kurz(k.name, 28)}${k.geburtsjahr ? ` *${k.geburtsjahr}` : ""}`;
}

function initialen(name: string): string {
  return name
    .split(/\s+/)
    .filter((t) => /^\p{L}/u.test(t))
    .map((t) => t[0]!.toUpperCase())
    .join("")
    .slice(0, 2);
}

type Ansicht = { k: number; tx: number; ty: number };
const HOEHE_MIN = 320;
const HOEHE_MAX = 780;
const RAND = 28;

export function NetzGrafik({ netz, wurzel, arten }: { netz: Netz; wurzel: string; arten: Set<Kante["art"]> }) {
  const kanten = useMemo(() => netz.kanten.filter((k) => arten.has(k.art)), [netz, arten]);
  const knoten = useMemo(() => {
    const verbunden = new Set<string>([wurzel]);
    for (const k of kanten) {
      verbunden.add(k.von);
      verbunden.add(k.nach);
    }
    return netz.knoten.filter((k) => verbunden.has(k.id));
  }, [netz, kanten, wurzel]);
  const netzKnoten = useMemo(() => new Map(knoten.map((k) => [k.id, k])), [knoten]);
  const berechnet = useMemo(() => radialLayout(knoten, kanten, wurzel, (k) => personLabel(k as Knoten)), [knoten, kanten, wurzel]);
  const [pos, setPos] = useState<Map<string, Punkt>>(berechnet);
  useEffect(() => setPos(berechnet), [berechnet]);
  const groesse = useMemo(() => new Map(knoten.map((k) => [k.id, knotenGroesse(k, k.id === wurzel)])), [knoten, wurzel]);

  // Breite messen; die Zeichenflaeche ist so breit wie das Panel und wird nie skaliert.
  const huelle = useRef<HTMLDivElement | null>(null);
  const [breite, setBreite] = useState(860);
  useEffect(() => {
    const el = huelle.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setBreite(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rahmen = useMemo(() => umriss(knoten, berechnet, wurzel, (k) => personLabel(k as Knoten)), [knoten, berechnet, wurzel]);
  const hoehe = Math.round(Math.min(HOEHE_MAX, Math.max(HOEHE_MIN, rahmen.y1 - rahmen.y0 + 2 * RAND)));
  const einpassen = useCallback((): Ansicht => {
    const b = rahmen.x1 - rahmen.x0;
    const h = rahmen.y1 - rahmen.y0;
    const k = Math.min(1, (breite - 2 * RAND) / Math.max(b, 1), (hoehe - 2 * RAND) / Math.max(h, 1));
    return { k, tx: breite / 2 - k * (rahmen.x0 + b / 2), ty: hoehe / 2 - k * (rahmen.y0 + h / 2) };
  }, [rahmen, breite, hoehe]);
  const [ansicht, setAnsicht] = useState<Ansicht>(() => einpassen());
  useEffect(() => setAnsicht(einpassen()), [einpassen]);

  const [aktiv, setAktiv] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const zug = useRef<{ art: "knoten"; id: string; bewegt: boolean } | { art: "flaeche"; x: number; y: number; tx: number; ty: number } | null>(null);
  const bildschirm = (e: { clientX: number; clientY: number }): Punkt => {
    const r = svgRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  };
  const inhalt = (s: Punkt): Punkt => ({ x: (s.x - ansicht.tx) / ansicht.k, y: (s.y - ansicht.ty) / ansicht.k });

  // Zoomen mit Trackpad (Zwei-Finger-Geste) oder ⌘/Strg + Mausrad; normales Scrollen bleibt der Seite.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const rad = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      setAnsicht((a) => {
        const k = Math.min(3, Math.max(0.25, a.k * Math.exp(-e.deltaY * 0.01)));
        return { k, tx: sx - ((sx - a.tx) / a.k) * k, ty: sy - ((sy - a.ty) / a.k) * k };
      });
    };
    svg.addEventListener("wheel", rad, { passive: false });
    return () => svg.removeEventListener("wheel", rad);
  }, []);
  const zoom = (f: number) =>
    setAnsicht((a) => {
      const k = Math.min(3, Math.max(0.25, a.k * f));
      return { k, tx: breite / 2 - ((breite / 2 - a.tx) / a.k) * k, ty: hoehe / 2 - ((hoehe / 2 - a.ty) / a.k) * k };
    });

  const knotenStart = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    zug.current = { art: "knoten", id, bewegt: false };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };
  const flaecheStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    zug.current = { art: "flaeche", x: e.clientX, y: e.clientY, tx: ansicht.tx, ty: ansicht.ty };
    svgRef.current?.setPointerCapture?.(e.pointerId);
  };
  const bewegen = (e: React.PointerEvent) => {
    const z = zug.current;
    if (!z) return;
    if (z.art === "flaeche") {
      setAnsicht((a) => ({ ...a, tx: z.tx + e.clientX - z.x, ty: z.ty + e.clientY - z.y }));
      return;
    }
    z.bewegt = true;
    const p = inhalt(bildschirm(e));
    setPos((alt) => new Map(alt).set(z.id, p));
  };
  const loslassen = () => {
    // Nach einem Ziehen den Klick (Link) unterdruecken; nach einem reinen Klick nicht.
    const z = zug.current;
    if (z?.art === "knoten" && z.bewegt) setTimeout(() => (zug.current = null), 0);
    else zug.current = null;
  };
  const klickUnterdruecken = (e: React.MouseEvent) => {
    const z = zug.current;
    if (z?.art === "knoten" && z.bewegt) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  if (knoten.length <= 1) return <p className="muted">Noch keine Verbindungen bekannt.</p>;
  const nachbarVonAktiv = (id: string) => aktiv === null || aktiv === id || kanten.some((e) => (e.von === aktiv && e.nach === id) || (e.nach === aktiv && e.von === id));
  const knopf: React.CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 28, height: 28, padding: 0, borderRadius: 8 };
  return (
    <div ref={huelle} className="netz" style={{ position: "relative", marginTop: 12 }}>
      <div className="netz__steuerung" style={{ position: "absolute", right: 8, top: 8, display: "flex", gap: 4, zIndex: 1 }}>
        <button type="button" className="secondary small" style={knopf} title="Vergrößern" aria-label="Vergrößern" onClick={() => zoom(1.25)}>
          <ZoomIn size={15} />
        </button>
        <button type="button" className="secondary small" style={knopf} title="Verkleinern" aria-label="Verkleinern" onClick={() => zoom(0.8)}>
          <ZoomOut size={15} />
        </button>
        <button type="button" className="secondary small" style={knopf} title="Einpassen" aria-label="Einpassen" onClick={() => setAnsicht(einpassen())}>
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          className="secondary small"
          style={knopf}
          title="Anordnung zurücksetzen"
          aria-label="Anordnung zurücksetzen"
          onClick={() => {
            setPos(berechnet);
            setAnsicht(einpassen());
          }}
        >
          <RotateCcw size={14} />
        </button>
      </div>
      <svg
        ref={svgRef}
        width={breite}
        height={hoehe}
        viewBox={`0 0 ${breite} ${hoehe}`}
        style={{ display: "block", borderRadius: 12, background: "var(--color-bg-0)", border: "1px solid var(--color-border)", touchAction: "none", cursor: zug.current?.art === "flaeche" ? "grabbing" : "default" }}
        role="img"
        aria-label="Netzgrafik der Verflechtungen"
        onPointerDown={flaecheStart}
        onPointerMove={bewegen}
        onPointerUp={loslassen}
        onPointerCancel={loslassen}
      >
        <defs>
          {(Object.keys(ART_FARBE) as Kante["art"][]).map((a) => (
            <marker key={a} id={`netz-pfeil-${a}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={ART_FARBE[a]} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${ansicht.tx} ${ansicht.ty}) scale(${ansicht.k})`}>
          {kanten.map((k, i) => {
            const a = pos.get(k.von);
            const b = pos.get(k.nach);
            const ka = netzKnoten.get(k.von);
            const kb = netzKnoten.get(k.nach);
            if (!a || !b || !ka || !kb) return null;
            const hervor = aktiv !== null && (aktiv === k.von || aktiv === k.nach);
            const blass = aktiv !== null && !hervor;
            const s = randPunkt(a, b, groesse.get(k.von)!, ka.typ === "PERSON");
            const z = randPunkt(b, a, groesse.get(k.nach)!, kb.typ === "PERSON");
            const mx = (s.x + z.x) / 2;
            const my = (s.y + z.y) / 2;
            return (
              <g key={`${k.von}-${k.nach}-${k.art}-${i}`} opacity={blass ? 0.12 : 1}>
                <title>{k.art === "ADRESSE" ? `Gleiche Adresse: ${k.quelle}` : `${ART_LABEL[k.art]}${k.prozent != null ? ` ${k.prozent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : ""}${k.seit ? ` seit ${new Date(k.seit).toLocaleDateString("de-DE")}` : ""}${k.bis ? ` bis ${new Date(k.bis).toLocaleDateString("de-DE")}` : ""}`}</title>
                <line
                  x1={s.x}
                  y1={s.y}
                  x2={z.x}
                  y2={z.y}
                  stroke={ART_FARBE[k.art]}
                  strokeOpacity={hervor ? 0.95 : 0.45}
                  strokeWidth={hervor ? 1.8 : 1.15}
                  strokeLinecap="round"
                  strokeDasharray={k.aktuell ? undefined : "3 4"}
                  markerEnd={k.art === "BETEILIGUNG" ? `url(#netz-pfeil-${k.art})` : undefined}
                />
                {k.art === "BETEILIGUNG" && k.prozent != null && (
                  <text x={mx} y={my - 3} fontSize={10.5} textAnchor="middle" fill="var(--color-fg-muted)" stroke="var(--color-bg-0)" strokeWidth={3} paintOrder="stroke" fontWeight={600}>
                    {k.prozent.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %
                  </text>
                )}
              </g>
            );
          })}
          {knoten.map((k) => {
            const p = pos.get(k.id);
            if (!p) return null;
            const istWurzel = k.id === wurzel;
            const g0 = groesse.get(k.id)!;
            const tot = k.registerStatus === "CLOSED";
            const insolvent = !!k.insolvencyStatus && k.insolvencyStatus !== "NONE";
            const blass = !nachbarVonAktiv(k.id);
            const istAktiv = aktiv === k.id;
            let zeichnung: React.ReactNode;
            if (k.typ === "PERSON") {
              const l = labelLage(p);
              zeichnung = (
                <>
                  <circle cx={p.x} cy={p.y} r={PERSON_R + (istAktiv ? 1.5 : 0)} fill="var(--color-bg-1)" stroke={ART_FARBE.GESCHAEFTSFUEHRUNG} strokeOpacity={istAktiv ? 1 : 0.7} strokeWidth={istAktiv ? 2 : 1.25} />
                  <text x={p.x} y={p.y + 3.5} fontSize={9.5} textAnchor="middle" fill="var(--color-fg-muted)" fontWeight={700} style={{ letterSpacing: 0.2 }}>
                    {initialen(k.name)}
                  </text>
                  <text x={l.x} y={l.y} fontSize={12} textAnchor={l.anker} fill="var(--color-fg)" stroke="var(--color-bg-0)" strokeWidth={4} paintOrder="stroke" fontWeight={istAktiv ? 600 : 500}>
                    {kurz(k.name, 28)}
                    {k.geburtsjahr ? (
                      <tspan fill="var(--color-fg-faint)" fontWeight={400} fontSize={11}>
                        {" "}*{k.geburtsjahr}
                      </tspan>
                    ) : null}
                  </text>
                </>
              );
            } else if (istWurzel) {
              zeichnung = (
                <>
                  <rect x={p.x - g0.b / 2} y={p.y - g0.h / 2} width={g0.b} height={g0.h} rx={g0.h / 2} fill="#00C0A7" stroke={insolvent ? "#d9534f" : "none"} strokeWidth={2} style={{ filter: "drop-shadow(0 2px 6px rgba(0, 160, 138, 0.28))" }} />
                  <text x={p.x} y={p.y + 4.2} fontSize={12.5} textAnchor="middle" fill="#ffffff" fontWeight={700}>
                    {kurz(k.name, WURZEL_ZEICHEN)}
                  </text>
                </>
              );
            } else {
              zeichnung = (
                <>
                  <rect x={p.x - g0.b / 2} y={p.y - g0.h / 2} width={g0.b} height={g0.h} rx={8} fill="var(--color-bg-1)" stroke={insolvent ? "#d9534f" : istAktiv ? "#00C0A7" : "var(--color-border-strong)"} strokeWidth={istAktiv || insolvent ? 1.6 : 1} />
                  <rect x={p.x - g0.b / 2 + 6} y={p.y - 5} width={3} height={10} rx={1.5} fill="#00C0A7" />
                  <text x={p.x + 4} y={p.y + 4} fontSize={11.5} textAnchor="middle" fill="var(--color-fg)" fontWeight={600} textDecoration={tot ? "line-through" : undefined}>
                    {kurz(k.name, 28)}
                  </text>
                </>
              );
            }
            const g = (
              <g key={k.id} opacity={blass ? 0.22 : tot ? 0.6 : 1} onMouseEnter={() => setAktiv(k.id)} onMouseLeave={() => setAktiv(null)} onPointerDown={knotenStart(k.id)} style={{ cursor: "pointer" }}>
                <title>
                  {k.name}
                  {k.typ === "PERSON" && k.wohnort ? `, ${k.wohnort}` : ""}
                  {k.typ === "FIRMA" && k.registerStatus ? ` · ${k.registerStatus}` : ""}
                  {insolvent ? ` · Insolvenz ${k.insolvencyStatus}` : ""}
                </title>
                {zeichnung}
              </g>
            );
            if (k.typ === "PERSON")
              return (
                <Link key={k.id} to={`/personen/${encodeURIComponent(k.id)}`} onClick={klickUnterdruecken}>
                  {g}
                </Link>
              );
            return k.typ === "FIRMA" && !istWurzel ? (
              <Link key={k.id} to={`/companies/${encodeURIComponent(k.id)}`} onClick={klickUnterdruecken}>
                {g}
              </Link>
            ) : (
              g
            );
          })}
        </g>
      </svg>
    </div>
  );
}

function GesellschafterName({ g }: { g: Beteiligung }) {
  if (g.typ === "FIRMA" && g.gesellschafterCompanyId) {
    const aktuell = g.gesellschafterFirmaName ?? null;
    const inListe = g.gesellschafterFirmaText ?? g.gesellschafterCompanyId;
    return (
      <span>
        <Link to={`/companies/${encodeURIComponent(g.gesellschafterCompanyId)}`}>{aktuell ?? inListe}</Link>
        {aktuell && g.gesellschafterFirmaText && !g.gesellschafterFirmaText.toLowerCase().startsWith(aktuell.toLowerCase()) && (
          <span className="muted small"> (in der Liste: {g.gesellschafterFirmaText})</span>
        )}
      </span>
    );
  }
  if (g.typ === "FIRMA") return <span>{g.gesellschafterFirmaText ?? "Firma"}</span>;
  const name = g.personName ?? "Person";
  return (
    <span>
      {g.personId ? <Link to={`/personen/${encodeURIComponent(g.personId)}`}>{name}</Link> : name}
      <span className="muted"> {[g.geburtsjahr ? `*${g.geburtsjahr}` : null, g.wohnort].filter(Boolean).join(", ")}</span>
    </span>
  );
}

/** Eine Tochter: Stammdaten-Treffer verlinkt, Übernehmen wie im Kunden-Reiter. */
function TochterAktion({ match }: { match: NonNullable<KonzernTochter["match"]> }) {
  const uebernommen = useIstUebernommen(match.companyId);
  return <FirmaUebernehmen name={match.name} ort={match.location} uebernommen={uebernommen} companyId={match.companyId} kompakt />;
}

const GF_STATUS: Record<string, string> = { amtierend: "amtierend", ausgeschieden: "ausgeschieden", bestellt: "bestellt" };

function KonzernPanel({ id }: { id: string }) {
  const q = useQuery<KonzernAngaben>({ queryKey: ["company", id, "konzern-angaben"], queryFn: () => gatewayFetch<KonzernAngaben>(`/v1/companies/${id}/konzern-angaben`), retry: false });
  const d = q.data;
  if (!d || !d.quelle) return null;
  const jahr = d.jahr ? ` ${d.jahr}` : "";
  return (
    <article className="panel">
      <h3 style={{ marginTop: 0 }}>Laut Konzernabschluss{jahr}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        Angaben der Firma selbst aus „{d.quelle}“. Der Stammdaten-Treffer ist ein Vorschlag (nur bei eindeutigem Namen); „Übernehmen“ importiert die Tochter in „Meine Firmen“.
      </p>
      {d.konzernmutter && (
        <p>
          <strong>Konzernmutter:</strong> {d.konzernmutter.name}
          {d.konzernmutter.sitz ? `, ${d.konzernmutter.sitz}` : ""}
          <span className="muted small"> (dieser Abschluss wird dort einbezogen)</span>
        </p>
      )}
      {d.toechter.length > 0 && (
        <>
          <h4>Tochtergesellschaften{jahr}</h4>
          <table className="kunden-tabelle">
            <thead>
              <tr>
                <th>Name</th>
                <th>Sitz</th>
                <th>Anteil</th>
                <th>Seit</th>
                <th>Kerngeschäft</th>
                <th>In den Stammdaten</th>
                <th className="kunden-aktion" aria-label="Aktion" />
              </tr>
            </thead>
            <tbody>
              {d.toechter.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>{[t.sitz, t.land].filter(Boolean).join(", ") || "–"}</td>
                  <td>{t.anteilProzent != null ? `${t.anteilProzent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : "–"}</td>
                  <td>{t.verbundenSeit ?? "–"}</td>
                  <td>{t.kerngeschaeft ?? "–"}</td>
                  <td>
                    {t.match ? (
                      <>
                        <Link to={`/companies/${encodeURIComponent(t.match.companyId)}`}>{t.match.name}</Link>
                        {t.match.location ? `, ${t.match.location}` : ""}
                      </>
                    ) : (
                      <span className="muted">{t.land && !/deutschland|germany/i.test(t.land) ? "Ausland" : "nicht gefunden"}</span>
                    )}
                  </td>
                  <td className="kunden-aktion">{t.match ? <TochterAktion match={t.match} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {d.geschaeftsfuehrung.length > 0 && (
        <>
          <h4>Geschäftsführung{jahr}</h4>
          <ul>
            {d.geschaeftsfuehrung.map((g) => (
              <li key={g.name}>
                {g.name} <span className="muted small">({GF_STATUS[g.status] ?? g.status}{g.datum ? ` ${datum(g.datum)}` : ""})</span>
              </li>
            ))}
          </ul>
          <p className="muted small">Stand des Abschlussjahres, nicht des Registers. Abweichungen zum Handelsregister meldet der Statuswächter.</p>
        </>
      )}
    </article>
  );
}

export function VerflechtungenTab({ id, name }: { id: string; name: string | null }) {
  const qc = useQueryClient();
  const [tiefe, setTiefe] = useState(2);
  const [arten, setArten] = useState<Set<Kante["art"]>>(new Set(["BETEILIGUNG", "GESCHAEFTSFUEHRUNG", "ADRESSE"]));
  const [ohneBremse, setOhneBremse] = useState(false);
  const [bestaetigen, setBestaetigen] = useState(false);

  const gesellschafter = useQuery<Gesellschafter>({ queryKey: ["company", id, "shareholders"], queryFn: () => gatewayFetch<Gesellschafter>(`/v1/companies/${id}/shareholders`), retry: false });
  const netz = useQuery<Netz>({ queryKey: ["company", id, "network", tiefe], queryFn: () => gatewayFetch<Netz>(`/v1/companies/${id}/network?tiefe=${tiefe}`), retry: false });
  const kontexte = useQuery<{ items: Kontext[] }>({ queryKey: ["company", id, "verflechtungen-kontexte"], queryFn: () => gatewayFetch<{ items: Kontext[] }>(`/v1/verflechtungen/kontexte?companyId=${encodeURIComponent(id)}`), retry: false, refetchInterval: 60_000 });
  const vertiefen = useMutation({
    mutationFn: () => gatewayFetch<{ kontext: string; angestossen: boolean; unbekannt: boolean }>("/v1/verflechtungen/kontexte", { method: "POST", body: { companyId: id, name: name ?? undefined, maxTiefe: 6, ohneBremse } }),
    onSuccess: () => {
      setBestaetigen(false);
      void qc.invalidateQueries({ queryKey: ["company", id, "verflechtungen-kontexte"] });
    },
  });
  useEffect(() => setBestaetigen(false), [id]);

  const stand = gesellschafter.data?.stand ?? null;
  const fehler = (e: unknown) => (e instanceof GatewayError && e.status === 404 ? null : e instanceof Error ? e.message : null);
  const laufend = (kontexte.data?.items ?? []).filter((k) => k.offen > 0);

  const toggleArt = (a: Kante["art"]) =>
    setArten((alt) => {
      const n = new Set(alt);
      if (n.has(a)) n.delete(a);
      else n.add(a);
      return n;
    });

  return (
    <div style={{ display: "grid", gap: "1.5rem" }}>
      <article className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0 }}>Firmengeflecht</h3>
          <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
            <label className="field" style={{ margin: 0, display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <span className="small">Tiefe</span>
              <select value={tiefe} onChange={(e) => setTiefe(Number(e.target.value))}>
                {[1, 2, 3, 4, 5, 6].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            {(Object.keys(ART_LABEL) as Kante["art"][]).map((a) => (
              <label key={a} className="small" style={{ display: "flex", gap: "0.3rem", alignItems: "center" }}>
                <input type="checkbox" checked={arten.has(a)} onChange={() => toggleArt(a)} />
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: ART_FARBE[a] }} />
                {ART_LABEL[a]}
              </label>
            ))}
          </div>
        </div>
        {netz.isLoading && <p>Lädt…</p>}
        {netz.error && <p className="muted">{fehler(netz.error) ?? "Noch kein Netz bekannt."}</p>}
        {netz.data && <NetzGrafik netz={netz.data} wurzel={id} arten={arten} />}
        {netz.data?.abgeschnitten && <p className="muted small">Netz gekürzt: mehr als 300 Knoten. Tiefe verringern oder gezielt weiterklicken.</p>}
        <p className="muted small" style={{ marginBottom: 0 }}>
          Pfeile zeigen vom Gesellschafter zur gehaltenen Firma, gestrichelt heißt frühere Verbindung. Knoten und Fläche lassen sich verschieben, zoomen geht mit zwei Fingern auf dem Trackpad oder ⌘ und Mausrad. Ein Klick öffnet Firma oder Person.
        </p>
      </article>

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Gesellschafter</h3>
        {gesellschafter.isLoading && <p>Lädt…</p>}
        {gesellschafter.error && <p className="muted">{fehler(gesellschafter.error) ?? "Noch keine Gesellschafterliste gelesen."}</p>}
        {stand && (
          <p className="muted small">
            {stand.ergebnis === "LISTE" && `Liste vom ${datum(stand.listeDatum)}, gelesen am ${datum(stand.geprueftAt)}${stand.modell ? ` mit ${stand.modell}` : ""}.`}
            {stand.ergebnis === "KEINE" && `Im Registerordner liegt keine Gesellschafterliste (geprüft am ${datum(stand.geprueftAt)}).`}
            {(stand.ergebnis === "UNSICHER" || stand.ergebnis === "FEHLER") &&
              `${stand.listeDatum ? `Die Liste vom ${datum(stand.listeDatum)}` : "Die zuletzt gelesene Liste"} wurde nicht übernommen (${stand.gruende.slice(0, 3).join("; ") || stand.fehler || "Lesung unsicher"}). Lieber keine Daten als falsche. Beim nächsten Registerlauf wird sie erneut gelesen.`}
          </p>
        )}
        {gesellschafter.data && gesellschafter.data.gesellschafter.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Gesellschafter</th>
                  <th>Art</th>
                  <th style={{ textAlign: "right" }}>Nennbetrag</th>
                  <th style={{ textAlign: "right" }}>Anteil</th>
                  <th>Anteile Nr.</th>
                </tr>
              </thead>
              <tbody>
                {gesellschafter.data.gesellschafter.map((g) => (
                  <tr key={g.id}>
                    <td>
                      <GesellschafterName g={g} />
                    </td>
                    <td>{g.typ === "FIRMA" ? "Firma" : "Person"}</td>
                    <td style={{ textAlign: "right" }}>{g.nennbetragEur != null ? eur.format(g.nennbetragEur) : "–"}</td>
                    <td style={{ textAlign: "right" }}>{g.prozent != null ? `${g.prozent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : "–"}</td>
                    <td className="muted small">{g.anteileNummern ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !gesellschafter.isLoading && !stand && <p className="muted">Noch keine Gesellschafterliste gelesen. Sie wird beim nächsten Registerlauf der Firma geholt.</p>
        )}
        {gesellschafter.data && gesellschafter.data.beteiligungen.length > 0 && (
          <>
            <h4>Beteiligungen dieser Firma</h4>
            <ul>
              {gesellschafter.data.beteiligungen.map((b) => (
                <li key={b.id}>
                  <Link to={`/companies/${encodeURIComponent(b.companyId)}`}>{b.companyId}</Link>
                  {b.prozent != null ? ` · ${b.prozent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : ""}
                  {b.nennbetragEur != null ? ` · ${eur.format(b.nennbetragEur)}` : ""}
                  <span className="muted small"> (Liste vom {datum(b.listeDatum)})</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </article>

      <KonzernPanel id={id} />

      <article className="panel">
        <h3 style={{ marginTop: 0 }}>Geflecht tiefer verfolgen</h3>
        <p className="muted small">
          AVA liest die Gesellschafterlisten der Firmen-Gesellschafter rekursiv (Standard bis Tiefe 6, höchstens 200 Firmen) mit deinem KI-Modell und legt dafür den Vorgang "Verflechtungen {name ?? id}" an. Automatisch läuft nach jedem Registerlauf eine Ebene.
        </p>
        {laufend.length > 0 && (
          <p className="small">
            Läuft: {laufend.map((k) => `${k.erledigt} fertig, ${k.offen} offen (Tiefe bis ${k.ohneBremse ? "∞" : k.maxTiefe})`).join(" · ")}
          </p>
        )}
        {!bestaetigen ? (
          <button type="button" className="secondary" onClick={() => setBestaetigen(true)} disabled={vertiefen.isPending}>
            Tiefer verfolgen
          </button>
        ) : (
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <label className="small" style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
              <input type="checkbox" checked={ohneBremse} onChange={(e) => setOhneBremse(e.target.checked)} />
              Ohne Notbremse (unbegrenzte Tiefe und Firmenzahl, für sehr große Konstrukte)
            </label>
            <div style={{ display: "flex", gap: "0.6rem" }}>
              <button type="button" onClick={() => vertiefen.mutate()} disabled={vertiefen.isPending}>
                {vertiefen.isPending ? "Startet…" : ohneBremse ? "Ohne Notbremse starten" : "Bis Tiefe 6 starten"}
              </button>
              <button type="button" className="secondary" onClick={() => setBestaetigen(false)}>
                Abbrechen
              </button>
            </div>
          </div>
        )}
        {vertiefen.error && <p className="error">{(vertiefen.error as Error).message}</p>}
        {vertiefen.data && <p className="small">{vertiefen.data.unbekannt ? "Die Firma ist noch nicht in den Stammdaten; sie wird nachgezogen." : "Lauf gestartet. Der Fortschritt steht unter Vorgänge."}</p>}
        {(kontexte.data?.items ?? []).length > 0 && (
          <ul className="muted small">
            {kontexte.data!.items.slice(0, 5).map((k) => (
              <li key={k.kontext}>
                {datum(k.erstelltAt)}: {k.erledigt} Firmen gelesen, {k.offen} offen, Tiefe bis {k.ohneBremse ? "unbegrenzt" : k.maxTiefe}
              </li>
            ))}
          </ul>
        )}
      </article>
    </div>
  );
}
