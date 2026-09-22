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
import type { BcInteraktionenErgebnis, BcMitgliedInteraktionen, BcLauf } from "../../../shared/types";
import { Waermeanzeige } from "../routes/waermeanzeige";
import { seitText } from "../routes/CompanyDetail";
import { useFeature } from "../store/policy";

export interface BcAngabe {
  id: string; dimension: string; wert: string | null; herkunft: string; grund: string;
  vonActorId: string | null; entschieden: string | null; erfasstAt: string;
}
export interface BcMitglied {
  id: string; personId: string | null; name: string; funktion: string | null;
  /** Beschaeftigungsbeginn "JJJJ-MM" / "JJJJ" aus dem Kontakt-Bestand. */
  seit?: string | null;
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
  /** Auto-Modus: offene AVA-Vorschlaege werden sofort uebernommen. */
  automatik?: boolean;
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
  // Legende auf Klick; im Chat standardmaessig zu, in der Firmenansicht auf.
  // Die Wahl bleibt im Browser — eine Bequemlichkeit, kein Zustand.
  const [legende, setLegende] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("bc-legende");
      if (v === "1") return true;
      if (v === "0") return false;
    } catch { /* ohne Speicher: Vorgabe */ }
    return !kompakt;
  });
  const legendeUmschalten = () => {
    setLegende((v) => {
      try { localStorage.setItem("bc-legende", v ? "0" : "1"); } catch { /* egal */ }
      return !v;
    });
  };
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

  // Auto-Modus: Opt-in je Buying Center, direkt an der Karte schaltbar.
  const automatik = useMutation({
    mutationFn: (an: boolean) =>
      gatewayFetch<{ automatik: boolean; uebernommen: number }>(`/v1/buying-center/${encodeURIComponent(id)}/automatik`, { method: "POST", body: { an } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["buying-center", id] }),
  });
  // "Recherche jetzt": Gateway (Website-Abgleich, Auto-Modus) und danach der
  // CRM-Abgleich vom Rechner — beides landet im Verlauf.
  // Der Nutzer soll sehen, WAS gerade laeuft (2026-09-22): erst der
  // Gateway-Teil, dann der CRM-Abgleich vom Rechner. Danach bleibt das
  // Ergebnis stehen, bis die naechste Recherche startet.
  const [rechercheSchritt, setRechercheSchritt] = useState<RechercheSchritt>(null);
  const recherche = useMutation({
    mutationFn: async () => {
      // 1. Kontaktlauf anstossen (Website-Personen, LinkedIn/Apify) …
      setRechercheSchritt("anstossen");
      const start = await gatewayFetch<{ angestossen: boolean; grund?: string; transactionId: string | null }>(`/v1/buying-center/${encodeURIComponent(id)}/recherche`, { method: "POST", body: {} });
      // 2. … und auf sein Ende warten (der Producer laeuft auf diesem
      //    Rechner; je nach Firma ein bis einige Minuten).
      let kontaktlauf: string = start.angestossen ? "läuft" : `nicht gestartet (${start.grund ?? "unbekannt"})`;
      if (start.angestossen) {
        setRechercheSchritt("kontaktlauf");
        const bis = Date.now() + 15 * 60_000;
        kontaktlauf = "Zeitüberschreitung";
        while (Date.now() < bis) {
          await new Promise((r) => setTimeout(r, 5_000));
          const st = await gatewayFetch<{ state: string }>(`/v1/buying-center/${encodeURIComponent(id)}/recherche`).catch(() => null);
          if (st && st.state !== "in_progress" && st.state !== "pending") {
            kontaktlauf = st.state === "completed" ? "abgeschlossen" : st.state === "failed" ? "fehlgeschlagen" : st.state;
            break;
          }
        }
      }
      // 3. Auswertung im Gateway (Website-Hervorhebung, Verknuepfbare, Auto-Modus).
      setRechercheSchritt("auswertung");
      const r = await gatewayFetch<{ website: number; verknuepfbar: number; uebernommen: number }>(`/v1/buying-center/${encodeURIComponent(id)}/auswertung`, { method: "POST", body: {} });
      // 4. CRM-Abgleich vom Rechner.
      setRechercheSchritt("crm");
      await qc.invalidateQueries({ queryKey: ["buying-center", id, "interaktionen"] });
      const crm = (await qc.fetchQuery<BcInteraktionenErgebnis>({
        queryKey: ["buying-center", id, "interaktionen"],
        queryFn: () => window.api.buyingCenter.interaktionen(id),
        staleTime: 0,
      }));
      // Ohne CRM-Verknuepfung schreibt der Abgleich nichts ins Protokoll —
      // dann soll der Verlauf trotzdem sagen, dass er gelaufen ist.
      if (!crm.verfuegbar) {
        const grund = crm.grund === "keine_crm_verknuepfung" ? "Die Firma ist mit keinem CRM verknüpft" : crm.grund === "hubspot_nicht_verbunden" ? "HubSpot ist nicht verbunden" : "nicht möglich";
        await gatewayFetch(`/v1/buying-center/${encodeURIComponent(id)}/verlauf`, { method: "POST", body: { art: "crm-abgleich", ergebnis: `CRM-Abgleich übersprungen: ${grund}`, details: { grund: crm.grund ?? null } } }).catch(() => undefined);
      }
      return { ...r, crm, kontaktlauf };
    },
    onSettled: () => {
      setRechercheSchritt(null);
      void qc.invalidateQueries({ queryKey: ["buying-center", id] });
    },
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
        <span className="bc-karte__rechts">
          <span className="muted small">{bc.mitglieder.length} Personen · Stand {new Date(bc.updatedAt).toLocaleDateString("de-DE")}</span>
          {bc.eigenes && (
            <label className="field-inline bc-karte__auto" title="Offene AVA-Vorschläge (Titel, Website, CRM) sofort übernehmen statt sie in der Seitenleiste zu sammeln. Einschalten übernimmt alles, was gerade offen ist; jede Übernahme steht in der Belegkette.">
              <input
                type="checkbox"
                checked={bc.automatik === true}
                disabled={automatik.isPending}
                onChange={(e) => automatik.mutate(e.target.checked)}
              />
              <span>Auto-Modus</span>
            </label>
          )}
        </span>
      </div>
      {automatik.data && automatik.data.uebernommen > 0 && (
        <p className="bc-muster">{automatik.data.uebernommen} offene {automatik.data.uebernommen === 1 ? "Vorschlag" : "Vorschläge"} automatisch übernommen.</p>
      )}
      {interaktionen.data?.gespraechsmuster && (
        <p className="bc-muster">{interaktionen.data.gespraechsmuster}</p>
      )}
      {bc.mitglieder.length === 0 ? (
        <p className="muted">Noch keine Personen. Nimm im Chat auf, wer beteiligt ist.</p>
      ) : (
        <div className="bc-karte__flaeche">
          <Grafik bc={bc} aktiv={aktiv} onWahl={setAktiv} kompakt={kompakt} />
        </div>
      )}
      {gewaehlt && (
        // Als Dialog, nicht als Spalte: Neben der Karte war fuer Belegkette,
        // Vorschlaege und Interaktionen kein Platz — im Chat schon gar nicht.
        <div
          className="bc-dialog__overlay"
          role="dialog"
          aria-modal="true"
          aria-label={`${gewaehlt.name} im Buying Center`}
          onClick={(e) => { if (e.target === e.currentTarget) setAktiv(null); }}
        >
          <Seitenleiste
            bc={bc}
            m={gewaehlt}
            interaktionen={interaktionen.data?.mitglieder.find((x) => x.mitgliedId === gewaehlt.id) ?? null}
            interaktionenStand={interaktionen.isLoading ? "laedt" : interaktionen.data?.verfuegbar ? "da" : (interaktionen.data?.grund ?? "fehler")}
            onSchliessen={() => setAktiv(null)}
            onGeaendert={() => void qc.invalidateQueries({ queryKey: ["buying-center", id] })}
          />
        </div>
      )}
      <Legende offen={legende} onToggle={legendeUmschalten} />
      <Verlauf
        id={id}
        stand={`${bc.updatedAt}:${recherche.status}:${rechercheSchritt ?? ""}`}
        eigenes={bc.eigenes}
        laeuft={recherche.isPending}
        schritt={rechercheSchritt}
        onRecherche={() => recherche.mutate()}
        ergebnis={
          recherche.data
            ? `Abgeschlossen ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} · Kontaktlauf ${recherche.data.kontaktlauf} · Website ${recherche.data.website}, verknüpfbar ${recherche.data.verknuepfbar}${recherche.data.uebernommen ? `, ${recherche.data.uebernommen} übernommen` : ""} · CRM: ${recherche.data.crm.verfuegbar ? `${recherche.data.crm.mitglieder.filter((m) => m.hubspotContactId).length} gefunden` : "übersprungen"}`
            : recherche.error ? "Recherche fehlgeschlagen" : null
        }
      />
    </div>
  );
}

// ---- Grafik ------------------------------------------------------------------

/**
 * Leinwand je Personenzahl: 25 Personen brauchen mehr Flaeche als 6, sonst
 * kleben Namen aneinander. Die Anfangsansicht passt sich ein (viewBox),
 * danach kann man ziehen und zoomen — die Leinwandgroesse sieht man nicht.
 */
function leinwand(n: number): { breite: number; hoehe: number } {
  const breite = Math.max(880, Math.round(Math.sqrt(Math.max(n, 1)) * 340));
  return { breite, hoehe: Math.round(breite * 0.5) };
}

type Ansicht = { x: number; y: number; w: number; h: number };
/** Weiteste Anfangsansicht in Leinwand-Einheiten (bei ~720 px Breite Massstab ≥ 0,6). */
const ANSICHT_MAX = 1200;

function Grafik({ bc, aktiv, onWahl, kompakt }: { bc: BuyingCenter; aktiv: string | null; onWahl: (id: string) => void; kompakt: boolean }) {
  const { breite, hoehe } = useMemo(() => leinwand(bc.mitglieder.length), [bc.mitglieder.length]);
  const ids = useMemo(() => bc.mitglieder.map((m) => m.id), [bc.mitglieder]);
  const bekannt = useMemo(() => {
    const map = new Map<string, Punkt>();
    for (const m of bc.mitglieder) if (m.x !== null && m.y !== null) map.set(m.id, { x: m.x, y: m.y });
    return map;
  }, [bc.mitglieder]);
  const kanten = useMemo(() => bc.kanten.map((k) => ({ von: k.vonMitgliedId, nach: k.nachMitgliedId })), [bc.kanten]);
  const berechnet = useMemo(() => kraftLayout(ids, kanten, breite, hoehe, bekannt), [ids, kanten, bekannt, breite, hoehe]);
  const [pos, setPos] = useState<Map<string, Punkt>>(berechnet);
  useEffect(() => setPos(berechnet), [berechnet]);

  const speichern = useMutation({
    mutationFn: (positionen: Array<{ mitgliedId: string; x: number; y: number }>) =>
      gatewayFetch(`/v1/buying-center/${encodeURIComponent(bc.id)}/positionen`, { method: "PUT", body: { positionen } }),
  });

  // ---- Ansicht: einpassen, zoomen, ziehen -----------------------------------
  //
  // Die viewBox ist die Kamera. "Einpassen" legt sie um alle Personen samt
  // Beschriftung; Rad/Pinch zoomen um den Zeiger, Ziehen auf dem Hintergrund
  // verschiebt. Das Rad zoomt nur, wenn die Karte den Fokus hat (Klick) oder
  // Strg/Cmd gedrueckt ist — sonst frisst die Karte im Chat das Scrollen.
  const einpassen = (p: Map<string, Punkt>): Ansicht => {
    const werte = Array.from(p.values());
    if (werte.length === 0) return { x: 0, y: 0, w: breite, h: hoehe };
    const rand = 90;
    const minX = Math.min(...werte.map((q) => q.x)) - rand;
    const maxX = Math.max(...werte.map((q) => q.x)) + rand;
    const minY = Math.min(...werte.map((q) => q.y)) - rand;
    const maxY = Math.max(...werte.map((q) => q.y)) + rand + 20;
    // Nie so weit heraus, dass die Namen unlesbar werden: hoechstens
    // ANSICHT_MAX Einheiten breit, dann lieber mittig und zum Ziehen.
    const w = Math.min(ANSICHT_MAX, Math.max(400, maxX - minX));
    const h = Math.min(ANSICHT_MAX * 0.56, Math.max(240, maxY - minY));
    return { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
  };
  const [ansicht, setAnsicht] = useState<Ansicht>(() => einpassen(berechnet));
  useEffect(() => setAnsicht(einpassen(berechnet)), [berechnet]); // eslint-disable-line react-hooks/exhaustive-deps

  const svgRef = useRef<SVGSVGElement | null>(null);
  const ansichtRef = useRef(ansicht);
  ansichtRef.current = ansicht;

  const zoomen = (faktor: number, um?: Punkt) => {
    setAnsicht((a) => {
      const w = Math.min(breite * 3, Math.max(200, a.w * faktor));
      const h = a.h * (w / a.w);
      const ux = um ? um.x : a.x + a.w / 2;
      const uy = um ? um.y : a.y + a.h / 2;
      // Der Punkt unter dem Zeiger bleibt unter dem Zeiger.
      const fx = (ux - a.x) / a.w, fy = (uy - a.y) / a.h;
      return { x: ux - fx * w, y: uy - fy * h, w, h };
    });
  };

  const svgPunkt = (clientX: number, clientY: number): Punkt => {
    const svg = svgRef.current;
    const m = svg?.getScreenCTM();
    if (!svg || !m) return { x: 0, y: 0 };
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // React haengt onWheel passiv an; preventDefault braucht den nativen Weg.
    const aufRad = (e: WheelEvent) => {
      const hatFokus = document.activeElement === svg;
      if (!hatFokus && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const faktor = Math.exp((e.ctrlKey || e.metaKey ? 0.01 : 0.002) * e.deltaY);
      zoomen(faktor, svgPunkt(e.clientX, e.clientY));
    };
    svg.addEventListener("wheel", aufRad, { passive: false });
    return () => svg.removeEventListener("wheel", aufRad);
  }, [breite]); // eslint-disable-line react-hooks/exhaustive-deps

  const drag = useRef<{ id: string; bewegt: boolean } | null>(null);
  const pan = useRef<{ x: number; y: number; bewegt: boolean } | null>(null);
  const dragStart = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { id, bewegt: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const panStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    // Sonst beginnt der Browser beim Ziehen eine Textauswahl ueber die Karte hinaus.
    e.preventDefault();
    svgRef.current?.focus();
    pan.current = { x: e.clientX, y: e.clientY, bewegt: false };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const p = svgPunkt(e.clientX, e.clientY);
      d.bewegt = true;
      setPos((alt) => {
        const neu = new Map(alt);
        neu.set(d.id, { x: Math.min(breite - 80, Math.max(80, p.x)), y: Math.min(hoehe - 40, Math.max(40, p.y)) });
        return neu;
      });
      return;
    }
    const q = pan.current;
    if (q) {
      const svg = svgRef.current;
      if (!svg) return;
      const massstab = ansichtRef.current.w / svg.clientWidth;
      const dx = (e.clientX - q.x) * massstab, dy = (e.clientY - q.y) * massstab;
      if (Math.abs(e.clientX - q.x) + Math.abs(e.clientY - q.y) > 2) q.bewegt = true;
      q.x = e.clientX; q.y = e.clientY;
      setAnsicht((a) => ({ ...a, x: a.x - dx, y: a.y - dy }));
    }
  };
  const ende = () => {
    const d = drag.current;
    if (d) {
      if (d.bewegt) {
        // Nur der Eigentuemer speichert. Beim Fremden bleibt das Verschieben
        // eine Sache des Augenblicks.
        if (bc.eigenes) {
          const alle = Array.from(pos.entries()).map(([mitgliedId, p]) => ({ mitgliedId, x: Math.round(p.x), y: Math.round(p.y) }));
          speichern.mutate(alle);
        }
        setTimeout(() => (drag.current = null), 0);
      } else {
        onWahl(d.id);
        drag.current = null;
      }
      return;
    }
    pan.current = null;
  };

  const zuruecksetzen = () => {
    const frisch = kraftLayout(ids, kanten, breite, hoehe);
    setPos(frisch);
    setAnsicht(einpassen(frisch));
    if (bc.eigenes) speichern.mutate(Array.from(frisch.entries()).map(([mitgliedId, p]) => ({ mitgliedId, x: Math.round(p.x), y: Math.round(p.y) })));
  };

  const name = (mid: string) => bc.mitglieder.find((m) => m.id === mid)?.name ?? "";

  return (
    <div className={`bc-grafik ${kompakt ? "bc-grafik--kompakt" : ""}`}>
      <div className="bc-grafik__werkzeuge">
        <button type="button" className="btn small" onClick={() => zoomen(0.8)} aria-label="Vergrößern" title="Vergrößern">+</button>
        <button type="button" className="btn small" onClick={() => zoomen(1.25)} aria-label="Verkleinern" title="Verkleinern">−</button>
        <button type="button" className="btn small" onClick={() => setAnsicht(einpassen(pos))} title="Alle Personen ins Bild">Einpassen</button>
        <button type="button" className="btn small" onClick={zuruecksetzen} title="Personen neu anordnen">Neu anordnen</button>
      </div>
      <svg ref={svgRef} viewBox={`${ansicht.x} ${ansicht.y} ${ansicht.w} ${ansicht.h}`} preserveAspectRatio="xMidYMid meet"
        role="img" aria-label="Buying Center als Karte — ziehen verschiebt, Rad zoomt" tabIndex={0}
        onPointerDown={panStart} onPointerMove={move} onPointerUp={ende} onPointerCancel={ende}
        style={{ touchAction: "none", cursor: pan.current ? "grabbing" : "grab" }}>
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
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--color-bg-1, var(--bg))" strokeWidth={1.5} /></g>;
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
              <circle r={r} fill="var(--color-bg-1, var(--bg))" />
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
  useEffect(() => {
    const aufTaste = (e: KeyboardEvent) => { if (e.key === "Escape") onSchliessen(); };
    window.addEventListener("keydown", aufTaste);
    return () => window.removeEventListener("keydown", aufTaste);
  }, [onSchliessen]);
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
          {m.seit && <div className="muted small">Im Unternehmen {seitText(m.seit)}</div>}
          {relevanzErlaubt && m.personId && <Waermeanzeige zielArt="person" zielId={m.personId} />}
          {!m.personId && <div className="muted small">Nicht mit dem Kontakt-Bestand verbunden — keine Personensignale. Im Chat: „verbinde … mit …".</div>}
        </div>
        <button type="button" className="btn small" onClick={onSchliessen} aria-label="Schließen">Schließen</button>
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

// ---- Verlauf --------------------------------------------------------------------
//
// Was AVA im Hintergrund getan hat — Entwurf, CRM-Abgleich, Website-
// Abgleich, Nachfrage, Watchlist. Zugeklappt, weil es Nachschlagewerk ist,
// kein Arbeitsmittel; die Kopfzeile nennt den juengsten Lauf.

const LAUF_ART_TEXT: Record<string, string> = {
  entwurf: "Entwurf", "crm-abgleich": "CRM-Abgleich", "website-abgleich": "Website", nachfrage: "Nachfrage",
  watchlist: "Watchlist", verknuepfung: "Verknüpfung", status: "Status", freigabe: "Freigabe",
  automatik: "Auto-Modus", recherche: "Recherche", auswertung: "Auswertung",
};

type RechercheSchritt = "anstossen" | "kontaktlauf" | "auswertung" | "crm" | null;
const SCHRITT_TEXT: Record<Exclude<RechercheSchritt, null>, string> = {
  anstossen: "Kontaktlauf wird angestoßen …",
  kontaktlauf: "Kontaktlauf läuft (Website-Personen, LinkedIn) — das dauert ein paar Minuten …",
  auswertung: "Auswertung läuft …",
  crm: "CRM-Abgleich läuft …",
};

function Verlauf({ id, stand, eigenes, laeuft, schritt, onRecherche, ergebnis }: {
  id: string; stand: string; eigenes: boolean; laeuft: boolean; schritt: RechercheSchritt; onRecherche: () => void; ergebnis: string | null;
}) {
  const q = useQuery<{ items: BcLauf[] }>({
    // `stand` im Schluessel: Nach jeder Aenderung der Karte wird neu geladen.
    queryKey: ["buying-center", id, "verlauf", stand],
    queryFn: () => gatewayFetch<{ items: BcLauf[] }>(`/v1/buying-center/${encodeURIComponent(id)}/verlauf?limit=50`),
    retry: false,
    staleTime: 60_000,
  });
  const items = q.data?.items ?? [];
  const wann = (iso: string) => new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
  return (
    <details className="bc-verlauf">
      <summary className="muted small">
        <span className="bc-verlauf__kopf">
          <span>Verlauf{items.length ? ` · zuletzt ${wann(items[0]!.zeitpunkt)}: ${LAUF_ART_TEXT[items[0]!.art] ?? items[0]!.art}` : " · noch keine Läufe"}</span>
          {eigenes && (
            <button
              type="button"
              className="btn small"
              disabled={laeuft}
              title="Website-Abgleich, Verknüpfungskandidaten und CRM-Abgleich jetzt ausführen"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); onRecherche(); }}
            >
              {laeuft ? "Läuft …" : "Recherche starten"}
            </button>
          )}
          {laeuft && (
            <span className="bc-verlauf__status" role="status" aria-live="polite">
              <span className="activity-spinner" aria-hidden="true" />
              {schritt ? SCHRITT_TEXT[schritt] : "Läuft …"}
            </span>
          )}
          {!laeuft && ergebnis && <span className="muted small">{ergebnis}</span>}
        </span>
      </summary>
      {items.length > 0 && (
        <ul className="bc-verlauf__liste small">
          {items.map((l) => (
            <li key={l.id}>
              <span className="bc-verlauf__zeit muted">{wann(l.zeitpunkt)}</span>
              <span className="bc-verlauf__art">{LAUF_ART_TEXT[l.art] ?? l.art}</span>
              <span>{l.ergebnis}</span>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Legende({ offen, onToggle }: { offen: boolean; onToggle: () => void }) {
  // Jede Bedeutung wird gezeigt, nicht beschrieben: ein kleiner Knoten, eine
  // kleine Linie — so wie sie auf der Karte aussehen.
  const Muster = ({ children, w = 44 }: { children: React.ReactNode; w?: number }) => (
    <svg width={w} height={26} viewBox={`0 0 ${w} 26`} aria-hidden="true" className="bc-legende__muster">{children}</svg>
  );
  const Knoten = ({ r = 9, rand, dash, fuell }: { r?: number; rand: string; dash?: string; fuell?: number }) => (
    <>
      {fuell !== undefined && fuell > 0 && (
        <rect x={22 - r} y={13 + r - 2 * r * fuell} width={2 * r} height={2 * r * fuell} fill="var(--accent)" opacity={0.28} clipPath="inset(0 round 50%)" />
      )}
      <circle cx={22} cy={13} r={r} fill="none" stroke={rand} strokeWidth={2} strokeDasharray={dash} />
    </>
  );
  return (
    <div className="bc-legende">
      <button type="button" className="btn small bc-legende__knopf" onClick={onToggle} aria-expanded={offen}>
        {offen ? "Legende ausblenden" : "Legende"}
      </button>
      {offen && (
        <div className="bc-legende__raster muted small">
          <span className="bc-legende__titel">Personen</span>
          <span><Muster><circle cx={12} cy={13} r={5} fill="none" stroke="var(--muted)" strokeWidth={2} /><circle cx={32} cy={13} r={11} fill="none" stroke="var(--muted)" strokeWidth={2} /></Muster>Größe: Einfluss</span>
          <span><Muster w={80}><circle cx={12} cy={13} r={8} fill="none" stroke="var(--color-emerald-500, #10b981)" strokeWidth={2} /><circle cx={40} cy={13} r={8} fill="none" stroke="var(--error, #ef4444)" strokeWidth={2} /><circle cx={68} cy={13} r={8} fill="none" stroke="var(--muted)" strokeWidth={2} strokeDasharray="4 3" /></Muster>Rand: Einstellung (Coach · Feind · unbekannt)</span>
          <span><Muster><Knoten rand="var(--muted)" fuell={0.6} /></Muster>Füllung: Kontaktintensität</span>
          <span><Muster><text x={22} y={16} textAnchor="middle" fontSize={10} fontWeight={700} fill="var(--accent)" letterSpacing="0.06em">E GK</text></Muster>Kürzel: Rollen</span>
          <span><Muster><circle cx={30} cy={7} r={4} fill="var(--color-amber-500, #f59e0b)" /><circle cx={22} cy={14} r={8} fill="none" stroke="var(--muted)" strokeWidth={2} /></Muster>Punkt: offene Vorschläge</span>
          <span className="bc-legende__titel">Beziehungen</span>
          <span><Muster><line x1={4} y1={13} x2={36} y2={13} stroke="var(--accent)" strokeWidth={2.2} markerEnd="url(#bc-pfeil)" /></Muster>Einfluss</span>
          <span><Muster><line x1={4} y1={13} x2={40} y2={13} stroke="var(--muted)" strokeWidth={5} opacity={0.35} /><line x1={4} y1={13} x2={40} y2={13} stroke="var(--color-bg-1, var(--bg))" strokeWidth={1.5} /></Muster>vertraut</span>
          <span><Muster><line x1={4} y1={13} x2={40} y2={13} stroke="var(--error, #ef4444)" strokeWidth={2} strokeDasharray="6 5" /></Muster>Animosität</span>
        </div>
      )}
    </div>
  );
}
