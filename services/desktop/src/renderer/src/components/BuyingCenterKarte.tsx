// Die Power Map als Karte (docs/PLAN_BUYING_CENTER.md, Abschnitt 8).
//
// Legende nach Sieck, Abbildung 21, in Form gegossen:
//   Groesse des Knotens   Einfluss (G klein, M mittel, H gross, ? mittel gestrichelt)
//   Rand                  Einstellung (Coach gruen … Feind rot, ? grau gestrichelt)
//   Fuellung              Kontaktintensitaet (0 leer … I voll)
//   Kuerzel am Knoten     Rollen (E, B, N, R, S, EK, GK)
//   Kanten                Einfluss = Pfeil (Dicke = Staerke),
//                         Vertraut = Doppellinie, Animositaet = gestrichelt rot
//
// Klick auf eine Person oeffnet die Seitenleiste: Einordnung mit
// Belegkette, offene Vorschlaege zum Annehmen oder Verwerfen. Der Bereich
// "Interaktionen" (CRM) kommt mit BC3 — bis dahin sagt er das ehrlich.
//
// Nur der Eigentuemer kann Knoten verschieben und Vorschlaege beantworten.
// Bei einem freigegebenen Buying Center ist alles ansehbar, nichts
// veraenderbar; das Verschieben wird dann nicht gespeichert.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch } from "../api/gateway";
import { kraftLayout, type Punkt } from "../lib/kraft-layout";
import type { BcInteraktionenErgebnis, BcMitgliedInteraktionen } from "../../../shared/types";
import { Waermeanzeige } from "../routes/waermeanzeige";
import { useFeature } from "../store/policy";

export interface BcAngabe {
  id: string; dimension: string; wert: string | null; herkunft: string; grund: string;
  vonActorId: string | null; entschieden: string | null; erfasstAt: string;
}
export interface BcMitglied {
  id: string; personId: string | null; name: string; funktion: string | null;
  rollen: string[]; einstellung: string | null; kontakt: string | null; einfluss: string | null;
  ansprechpartnerBeiUns: string | null; x: number | null; y: number | null; angaben: BcAngabe[];
}
export interface BcKante {
  id: string; vonMitgliedId: string; nachMitgliedId: string; art: string;
  staerke: string | null; grund: string | null; herkunft: string; erfasstAt: string;
}
export interface BuyingCenter {
  id: string; companyId: string; anlass: string; status: string; eigenes: boolean;
  eigentuemerActorId: string; angelegtAt: string; updatedAt: string;
  mitglieder: BcMitglied[]; kanten: BcKante[];
}

export const ROLLE_TEXT: Record<string, string> = {
  E: "Entscheider", B: "Beeinflusser", N: "Nutzer/Anwender", R: "Ratifizierer",
  S: "Spezifizierer", EK: "Einkäufer", GK: "Gatekeeper",
};
const EINSTELLUNG_TEXT: Record<string, string> = { C: "Coach", "+": "positiv", "=": "neutral", "-": "negativ", F: "Feind" };
const KONTAKT_TEXT: Record<string, string> = { "0": "kein Kontakt", S: "selten", R: "regelmäßig", I: "intensiv" };
const EINFLUSS_TEXT: Record<string, string> = { G: "gering", M: "mittel", H: "hoch" };
const DIMENSION_TEXT: Record<string, string> = {
  rolle: "Rolle", einstellung: "Einstellung", kontakt: "Kontakt", einfluss: "Einfluss", ansprechpartner: "Ansprechpartner bei uns", notiz: "Notiz",
};
const HERKUNFT_TEXT: Record<string, string> = {
  nutzer: "von dir", "ava:titel": "AVA, aus dem Titel", "ava:website": "AVA, von der Website",
  "ava:linkedin": "AVA, von LinkedIn", "ava:crm": "AVA, aus dem CRM",
};

/** Wert einer Dimension in Worten — fuer Seitenleiste und Titel. */
function wertText(dimension: string, wert: string | null): string {
  if (wert === null || wert === "") return "unbekannt";
  const w = wert.startsWith("-") ? wert.slice(1) : wert;
  const t =
    dimension === "rolle" ? ROLLE_TEXT[w] :
    dimension === "einstellung" ? EINSTELLUNG_TEXT[w] :
    dimension === "kontakt" ? KONTAKT_TEXT[w] :
    dimension === "einfluss" ? EINFLUSS_TEXT[w] : undefined;
  const text = t ?? wert;
  return wert.startsWith("-") ? `nicht mehr ${text}` : text;
}

// ---- Farben und Groessen ----------------------------------------------------

function randFarbe(einstellung: string | null): string {
  switch (einstellung) {
    case "C": return "var(--color-emerald-500, #10b981)";
    case "+": return "var(--color-emerald-300, #6ee7b7)";
    case "=": return "var(--muted)";
    case "-": return "var(--color-amber-500, #f59e0b)";
    case "F": return "var(--error, #ef4444)";
    default: return "var(--muted)";
  }
}
function radius(einfluss: string | null): number {
  switch (einfluss) {
    case "G": return 18;
    case "H": return 32;
    default: return 24;
  }
}
function fuellung(kontakt: string | null): number {
  switch (kontakt) {
    case "S": return 0.25;
    case "R": return 0.6;
    case "I": return 1;
    default: return 0;
  }
}
function initialen(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((t) => t[0]?.toUpperCase() ?? "").join("");
}

// ---- Karte -------------------------------------------------------------------

export function BuyingCenterKarte({ id, kompakt = false }: { id: string; kompakt?: boolean }) {
  const qc = useQueryClient();
  const q = useQuery<BuyingCenter>({
    queryKey: ["buying-center", id],
    queryFn: () => gatewayFetch<BuyingCenter>(`/v1/buying-center/${encodeURIComponent(id)}`),
    retry: false,
    // Der Zaun im Chat traegt nur die Kennung; die Karte soll den heutigen
    // Stand zeigen, nicht den von damals.
    staleTime: 15_000,
  });
  const [aktiv, setAktiv] = useState<string | null>(null);
  // BC3: CRM-Abgleich beim Oeffnen. Einmal je Karte, nicht je Person — der
  // Abgleich holt die Kontakte der Firma ohnehin auf einen Schlag.
  const interaktionen = useQuery<BcInteraktionenErgebnis>({
    queryKey: ["buying-center", id, "interaktionen"],
    queryFn: async () => {
      const r = await window.api.buyingCenter.interaktionen(id);
      // Der Abgleich kann Kontakt-Vorschlaege abgelegt haben.
      if (r.verfuegbar) void qc.invalidateQueries({ queryKey: ["buying-center", id] });
      return r;
    },
    enabled: Boolean(q.data),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (q.isLoading) return <div className="bc-platzhalter">Buying Center wird geladen …</div>;
  if (q.error || !q.data) {
    return <div className="bc-platzhalter muted">Dieses Buying Center ist nicht abrufbar — es gehört vielleicht jemand anderem oder wurde entfernt.</div>;
  }
  const bc = q.data;
  const gewaehlt = bc.mitglieder.find((m) => m.id === aktiv) ?? null;

  return (
    <div className={`bc-karte ${kompakt ? "bc-karte--kompakt" : ""}`}>
      <div className="bc-karte__kopf">
        <span className="bc-karte__titel">
          Buying Center{bc.anlass ? ` · ${bc.anlass}` : ""}
          {!bc.eigenes && <span className="bc-karte__fremd"> · nur ansehen</span>}
          {bc.status !== "aktiv" && <span className="bc-karte__fremd"> · {bc.status}</span>}
        </span>
        <span className="muted small">{bc.mitglieder.length} Personen · Stand {new Date(bc.updatedAt).toLocaleDateString("de-DE")}</span>
      </div>
      {interaktionen.data?.gespraechsmuster && (
        <p className="bc-muster">{interaktionen.data.gespraechsmuster}</p>
      )}
      {bc.mitglieder.length === 0 ? (
        <p className="muted">Noch keine Personen. Nimm im Chat auf, wer beteiligt ist.</p>
      ) : (
        <div className="bc-karte__flaeche">
          <Grafik bc={bc} aktiv={aktiv} onWahl={setAktiv} />
          {gewaehlt && (
            <Seitenleiste
              bc={bc}
              m={gewaehlt}
              interaktionen={interaktionen.data?.mitglieder.find((x) => x.mitgliedId === gewaehlt.id) ?? null}
              interaktionenStand={interaktionen.isLoading ? "laedt" : interaktionen.data?.verfuegbar ? "da" : (interaktionen.data?.grund ?? "fehler")}
              onSchliessen={() => setAktiv(null)}
              onGeaendert={() => void qc.invalidateQueries({ queryKey: ["buying-center", id] })}
            />
          )}
        </div>
      )}
      <Legende />
    </div>
  );
}

// ---- Grafik ------------------------------------------------------------------

function Grafik({ bc, aktiv, onWahl }: { bc: BuyingCenter; aktiv: string | null; onWahl: (id: string) => void }) {
  const breite = 880;
  const hoehe = 520;
  const ids = useMemo(() => bc.mitglieder.map((m) => m.id), [bc.mitglieder]);
  const bekannt = useMemo(() => {
    const map = new Map<string, Punkt>();
    for (const m of bc.mitglieder) if (m.x !== null && m.y !== null) map.set(m.id, { x: m.x, y: m.y });
    return map;
  }, [bc.mitglieder]);
  const kanten = useMemo(() => bc.kanten.map((k) => ({ von: k.vonMitgliedId, nach: k.nachMitgliedId })), [bc.kanten]);
  const berechnet = useMemo(() => kraftLayout(ids, kanten, breite, hoehe, bekannt), [ids, kanten, bekannt]);
  const [pos, setPos] = useState<Map<string, Punkt>>(berechnet);
  useEffect(() => setPos(berechnet), [berechnet]);

  const speichern = useMutation({
    mutationFn: (positionen: Array<{ mitgliedId: string; x: number; y: number }>) =>
      gatewayFetch(`/v1/buying-center/${encodeURIComponent(bc.id)}/positionen`, { method: "PUT", body: { positionen } }),
  });

  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ id: string; bewegt: boolean } | null>(null);
  const svgPunkt = (e: React.PointerEvent): Punkt => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const dragStart = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { id, bewegt: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const dragMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = svgPunkt(e);
    d.bewegt = true;
    setPos((alt) => {
      const neu = new Map(alt);
      neu.set(d.id, { x: Math.min(breite - 80, Math.max(80, p.x)), y: Math.min(hoehe - 40, Math.max(40, p.y)) });
      return neu;
    });
  };
  const dragEnd = () => {
    const d = drag.current;
    if (d?.bewegt) {
      // Nur der Eigentuemer speichert. Beim Fremden bleibt das Verschieben
      // eine Sache des Augenblicks.
      if (bc.eigenes) {
        const alle = Array.from(pos.entries()).map(([mitgliedId, p]) => ({ mitgliedId, x: Math.round(p.x), y: Math.round(p.y) }));
        speichern.mutate(alle);
      }
      setTimeout(() => (drag.current = null), 0);
    } else {
      if (d) onWahl(d.id);
      drag.current = null;
    }
  };

  const zuruecksetzen = () => {
    const frisch = kraftLayout(ids, kanten, breite, hoehe);
    setPos(frisch);
    if (bc.eigenes) speichern.mutate(Array.from(frisch.entries()).map(([mitgliedId, p]) => ({ mitgliedId, x: Math.round(p.x), y: Math.round(p.y) })));
  };

  const name = (mid: string) => bc.mitglieder.find((m) => m.id === mid)?.name ?? "";

  return (
    <div className="bc-grafik">
      <button type="button" className="btn small bc-grafik__reset" onClick={zuruecksetzen}>Anordnung zurücksetzen</button>
      <svg ref={svgRef} viewBox={`0 0 ${breite} ${hoehe}`} width="100%" role="img" aria-label="Buying Center als Karte"
        onPointerMove={dragMove} onPointerUp={dragEnd} onPointerCancel={dragEnd} style={{ touchAction: "none" }}>
        <defs>
          <marker id="bc-pfeil" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" fill="var(--accent)" />
          </marker>
        </defs>
        {bc.kanten.map((k) => {
          const a = pos.get(k.vonMitgliedId);
          const b = pos.get(k.nachMitgliedId);
          if (!a || !b) return null;
          const dicke = k.staerke === "H" ? 3.5 : k.staerke === "M" ? 2.2 : 1.4;
          const titel = `${name(k.vonMitgliedId)} → ${name(k.nachMitgliedId)}: ${k.art === "EINFLUSS" ? "Einfluss" : k.art === "VERTRAUT" ? "vertraut" : "Animosität"}${k.grund ? ` — ${k.grund}` : ""}`;
          if (k.art === "EINFLUSS") {
            // Pfeil endet am Rand des Zielknotens, nicht in seiner Mitte.
            const ziel = bc.mitglieder.find((m) => m.id === k.nachMitgliedId);
            const r = radius(ziel?.einfluss ?? null) + 4;
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
            const ex = b.x - (dx / d) * r, ey = b.y - (dy / d) * r;
            return <line key={k.id} x1={a.x} y1={a.y} x2={ex} y2={ey} stroke="var(--accent)" strokeWidth={dicke} markerEnd="url(#bc-pfeil)"><title>{titel}</title></line>;
          }
          if (k.art === "VERTRAUT") {
            return <g key={k.id}><title>{titel}</title>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--muted)" strokeWidth={5} opacity={0.35} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--panel-bg, #111)" strokeWidth={1.5} /></g>;
          }
          return <line key={k.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--error, #ef4444)" strokeWidth={2} strokeDasharray="6 5"><title>{titel}</title></line>;
        })}
        {bc.mitglieder.map((m) => {
          const p = pos.get(m.id);
          if (!p) return null;
          const r = radius(m.einfluss);
          const f = fuellung(m.kontakt);
          const offen = m.angaben.filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null).length;
          const istAktiv = aktiv === m.id;
          return (
            <g key={m.id} transform={`translate(${p.x} ${p.y})`} style={{ cursor: "pointer" }} onPointerDown={dragStart(m.id)}>
              <title>{`${m.name}${m.funktion ? ` · ${m.funktion}` : ""}\nRolle: ${m.rollen.length ? m.rollen.map((x) => ROLLE_TEXT[x] ?? x).join(", ") : "?"}\nEinstellung: ${wertText("einstellung", m.einstellung)}\nKontakt: ${wertText("kontakt", m.kontakt)}\nEinfluss: ${wertText("einfluss", m.einfluss)}`}</title>
              {/* Fuellung = Kontaktintensitaet: eine Scheibe, die von unten volllaeuft. */}
              <clipPath id={`bc-clip-${m.id}`}><circle r={r} /></clipPath>
              <circle r={r} fill="var(--panel-bg, #1b2230)" />
              {f > 0 && <rect x={-r} y={r - 2 * r * f} width={2 * r} height={2 * r * f} fill="var(--accent)" opacity={0.28} clipPath={`url(#bc-clip-${m.id})`} />}
              <circle r={r} fill="none" stroke={randFarbe(m.einstellung)} strokeWidth={istAktiv ? 4 : m.einstellung ? 3 : 2}
                strokeDasharray={m.einstellung ? undefined : "4 3"} opacity={m.einfluss ? 1 : 0.8} />
              <text textAnchor="middle" dominantBaseline="central" fontSize={r * 0.62} fontWeight={600} fill="var(--fg)">{initialen(m.name)}</text>
              {m.rollen.length > 0 && (
                <text y={-r - 6} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--accent)" letterSpacing="0.06em">{m.rollen.join(" ")}</text>
              )}
              {offen > 0 && <circle cx={r * 0.72} cy={-r * 0.72} r={7} fill="var(--color-amber-500, #f59e0b)"><title>{`${offen} offene Vorschläge`}</title></circle>}
              <text y={r + 15} textAnchor="middle" fontSize={12} fill="var(--fg)">{m.name.length > 24 ? `${m.name.slice(0, 23)}…` : m.name}</text>
              {m.funktion && <text y={r + 29} textAnchor="middle" fontSize={10} fill="var(--muted)">{m.funktion.length > 30 ? `${m.funktion.slice(0, 29)}…` : m.funktion}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---- Seitenleiste --------------------------------------------------------------

const ART_TEXT: Record<string, string> = { notiz: "Notiz", anruf: "Anruf", email: "E-Mail", termin: "Termin" };

function Seitenleiste({ bc, m, onSchliessen, onGeaendert, interaktionen, interaktionenStand }: {
  bc: BuyingCenter; m: BcMitglied; onSchliessen: () => void; onGeaendert: () => void;
  interaktionen: BcMitgliedInteraktionen | null;
  interaktionenStand: string;
}) {
  const offen = m.angaben.filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null);
  const belegt = m.angaben.filter((a) => !(a.herkunft.startsWith("ava:") && a.entschieden === null));
  // BC5: Personensignale am Knoten — die Naehe der Person, sofern die
  // Organisation die Relevanz nicht abgeschaltet hat. Freie Mitglieder
  // (ohne personId) haben keine; das sagt die Leiste ehrlich.
  const relevanzErlaubt = useFeature("relevanz");
  const antworten = useMutation({
    mutationFn: (p: { vorschlagId: string; entscheidung: "angenommen" | "verworfen" }) =>
      gatewayFetch(`/v1/buying-center/${encodeURIComponent(bc.id)}/mitglieder/${encodeURIComponent(m.id)}/angaben`, {
        method: "POST",
        body: { dimension: "notiz", wert: null, grund: p.entscheidung === "angenommen" ? "in der Karte angenommen" : "in der Karte verworfen", vorschlagId: p.vorschlagId, entscheidung: p.entscheidung },
      }),
    onSuccess: onGeaendert,
  });

  return (
    <aside className="bc-seite">
      <div className="bc-seite__kopf">
        <div>
          <div className="bc-seite__name">{m.personId ? <Link to={`/personen/${encodeURIComponent(m.personId)}`}>{m.name}</Link> : m.name}</div>
          {m.funktion && <div className="muted small">{m.funktion}</div>}
          {relevanzErlaubt && m.personId && <Waermeanzeige zielArt="person" zielId={m.personId} />}
          {!m.personId && <div className="muted small">Nicht mit dem Kontakt-Bestand verbunden — keine Personensignale. Im Chat: „verbinde … mit …".</div>}
        </div>
        <button type="button" className="btn small" onClick={onSchliessen} aria-label="Seitenleiste schließen">Schließen</button>
      </div>

      <h4>Einordnung</h4>
      <dl className="bc-seite__dims">
        <dt>Rolle</dt><dd>{m.rollen.length ? m.rollen.map((r) => ROLLE_TEXT[r] ?? r).join(", ") : <span className="muted">unbekannt</span>}</dd>
        <dt>Einstellung</dt><dd>{m.einstellung ? EINSTELLUNG_TEXT[m.einstellung] : <span className="muted">unbekannt</span>}</dd>
        <dt>Kontakt</dt><dd>{m.kontakt ? KONTAKT_TEXT[m.kontakt] : <span className="muted">unbekannt</span>}</dd>
        <dt>Einfluss</dt><dd>{m.einfluss ? EINFLUSS_TEXT[m.einfluss] : <span className="muted">unbekannt</span>}</dd>
      </dl>
      {belegt.length > 0 ? (
        <ul className="bc-seite__belege">
          {belegt.slice(0, 12).map((a) => (
            <li key={a.id}>
              <span className="bc-seite__beleg-kopf">
                {DIMENSION_TEXT[a.dimension] ?? a.dimension}{a.wert !== null && a.dimension !== "notiz" ? `: ${wertText(a.dimension, a.wert)}` : ""}
                {a.entschieden === "angenommen" && " (Vorschlag angenommen)"}
                {a.entschieden === "verworfen" && " (Vorschlag verworfen)"}
              </span>
              <span className="muted small"> — {HERKUNFT_TEXT[a.herkunft] ?? a.herkunft}, {new Date(a.erfasstAt).toLocaleDateString("de-DE")}</span>
              <div className="bc-seite__grund">{a.grund}</div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Zu dieser Person liegt nichts vor. Du kannst im Chat ergänzen, was du weißt.</p>
      )}

      {offen.length > 0 && (
        <>
          <h4>Offene Vorschläge</h4>
          <ul className="bc-seite__vorschlaege">
            {offen.map((a) => (
              <li key={a.id}>
                <div><strong>{DIMENSION_TEXT[a.dimension] ?? a.dimension}: {wertText(a.dimension, a.wert)}</strong></div>
                <div className="muted small">{a.grund}</div>
                {bc.eigenes && (
                  <div className="bc-seite__knoepfe">
                    <button type="button" className="primary small" disabled={antworten.isPending} onClick={() => antworten.mutate({ vorschlagId: a.id, entscheidung: "angenommen" })}>Übernehmen</button>
                    <button type="button" className="btn small" disabled={antworten.isPending} onClick={() => antworten.mutate({ vorschlagId: a.id, entscheidung: "verworfen" })}>Verwerfen</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4>Interaktionen</h4>
      {interaktionenStand === "laedt" && <p className="muted small">CRM wird abgeglichen …</p>}
      {interaktionenStand === "keine_crm_verknuepfung" && <p className="muted small">Die Firma ist mit keinem CRM verknüpft.</p>}
      {interaktionenStand === "hubspot_nicht_verbunden" && <p className="muted small">HubSpot ist nicht verbunden.</p>}
      {interaktionenStand === "fehler" && <p className="muted small">Der CRM-Abgleich ist gerade nicht möglich.</p>}
      {interaktionenStand === "da" && interaktionen && !interaktionen.hubspotContactId && (
        <p className="muted small">Im CRM gibt es keinen Kontakt mit diesem Namen.</p>
      )}
      {interaktionenStand === "da" && interaktionen?.hubspotContactId && (
        <>
          <p className="small">{interaktionen.anzahl90Tage} in den letzten 90 Tagen{interaktionen.kontaktVorschlag ? ` · Vorschlag: ${KONTAKT_TEXT[interaktionen.kontaktVorschlag]}` : ""}</p>
          {interaktionen.letzte.length > 0 ? (
            <ul className="bc-seite__belege">
              {interaktionen.letzte.map((i, n) => (
                <li key={n}>
                  <span className="bc-seite__beleg-kopf">{ART_TEXT[i.art] ?? i.art}</span>
                  <span className="muted small"> — {i.zeitpunkt ? new Date(i.zeitpunkt).toLocaleDateString("de-DE") : "ohne Datum"}</span>
                  {i.titel && <div className="bc-seite__grund">{i.titel}</div>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Keine Notizen, Anrufe, E-Mails oder Termine im CRM.</p>
          )}
        </>
      )}
    </aside>
  );
}

// ---- Legende --------------------------------------------------------------------

function Legende() {
  return (
    <div className="bc-legende muted small">
      <span><b>Größe</b> Einfluss</span>
      <span><b>Rand</b> Einstellung (grün Coach · rot Feind · gestrichelt unbekannt)</span>
      <span><b>Füllung</b> Kontaktintensität</span>
      <span><b>Kürzel</b> Rollen</span>
      <span><b>Pfeil</b> Einfluss · <b>Doppellinie</b> vertraut · <b>gestrichelt rot</b> Animosität</span>
    </div>
  );
}
