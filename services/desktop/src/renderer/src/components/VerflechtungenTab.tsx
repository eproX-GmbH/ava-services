// Firmen-Verflechtungen (docs/PLAN_VERFLECHTUNGEN.md §5, V6): Reiter in den
// Firmendetails. Netzgrafik wie bei North Data (Firmen als Kaesten, Personen
// als Kreise, Kanten Beteiligung mit Prozent, Geschaeftsfuehrung, Adresse),
// Gesellschaftertabelle der neuesten Liste, Beteiligungen der Firma und der
// Stand der Rekursion (Kontexte) mit "tiefer verfolgen".

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { gatewayFetch, GatewayError } from "../api/gateway";

type Knoten = { id: string; typ: "FIRMA" | "PERSON"; name: string; land?: string | null; registerStatus?: string | null; insolvencyStatus?: string | null; geburtsjahr?: number | null; wohnort?: string | null; tiefe: number };
type Kante = { von: string; nach: string; art: "BETEILIGUNG" | "GESCHAEFTSFUEHRUNG" | "ADRESSE"; prozent?: number | null; nennbetragEur?: number | null; aktuell: boolean; seit?: string | null; bis?: string | null; quelle: string };
type Netz = { companyId: string; tiefe: number; knoten: Knoten[]; kanten: Kante[]; abgeschnitten: boolean };
type Beteiligung = { id: number; companyId: string; listeDatum: string; typ: "PERSON" | "FIRMA"; personId: string | null; personName: string | null; geburtsjahr: number | null; wohnort: string | null; gesellschafterCompanyId: string | null; gesellschafterFirmaText: string | null; gesellschafterFirmaName?: string | null; anteileNummern: string | null; nennbetragEur: number | null; prozent: number | null; veraenderung: string | null; konfidenz: number; unsicher: boolean };
type Stand = { geprueftAt: string; listeDatum: string | null; ergebnis: "LISTE" | "KEINE" | "UNSICHER" | "FEHLER"; format: string | null; modell: string | null; fehler: string | null; gruende: string[]; dokumentId: number | null };
type Gesellschafter = { companyId: string; stand: Stand | null; gesellschafter: Beteiligung[]; beteiligungen: Beteiligung[] };
type Kontext = { kontext: string; ursprungCompanyId: string; transactionId: string; maxTiefe: number; maxFirmen: number; ohneBremse: boolean; erstelltAt: string; offen: number; erledigt: number };

const ART_LABEL: Record<Kante["art"], string> = { BETEILIGUNG: "Beteiligung", GESCHAEFTSFUEHRUNG: "Geschäftsführung", ADRESSE: "gleiche Adresse" };
const ART_FARBE: Record<Kante["art"], string> = { BETEILIGUNG: "#00C0A7", GESCHAEFTSFUEHRUNG: "#5b7cfa", ADRESSE: "#b08a00" };
const eur = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const datum = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString("de-DE") : "–");

// ---- Layout: kleine Kraftsimulation, deterministisch (kein Zufall) --------
type Punkt = { x: number; y: number };
function layout(knoten: Knoten[], kanten: Kante[], breite: number, hoehe: number, wurzel: string): Map<string, Punkt> {
  const pos = new Map<string, Punkt>();
  const cx = breite / 2;
  const cy = hoehe / 2;
  const jeTiefe = new Map<number, Knoten[]>();
  for (const k of knoten) jeTiefe.set(k.tiefe, [...(jeTiefe.get(k.tiefe) ?? []), k]);
  for (const [t, liste] of jeTiefe) {
    const r = t === 0 ? 0 : Math.min(breite, hoehe) * (0.16 + 0.14 * t);
    liste.forEach((k, i) => {
      const w = (2 * Math.PI * i) / Math.max(liste.length, 1) + t * 0.7;
      pos.set(k.id, { x: cx + r * Math.cos(w), y: cy + r * Math.sin(w) });
    });
  }
  const ids = knoten.map((k) => k.id);
  const idx = new Map(ids.map((id, i) => [id, i]));
  const vx = new Float64Array(ids.length);
  const vy = new Float64Array(ids.length);
  const kantenIdx = kanten.map((k) => [idx.get(k.von), idx.get(k.nach)] as const).filter(([a, b]) => a !== undefined && b !== undefined) as Array<readonly [number, number]>;
  const p = ids.map((id) => pos.get(id)!);
  for (let iter = 0; iter < 260; iter++) {
    const temp = 1 - iter / 260;
    for (let i = 0; i < p.length; i++) {
      const pi = p[i]!;
      for (let j = i + 1; j < p.length; j++) {
        const pj = p[j]!;
        let dx = pj.x - pi.x;
        let dy = pj.y - pi.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = 0.5;
          dy = 0.5;
          d2 = 0.5;
        }
        const f = 5200 / d2;
        const fx = (dx / Math.sqrt(d2)) * f;
        const fy = (dy / Math.sqrt(d2)) * f;
        vx[i] = (vx[i] ?? 0) - fx;
        vy[i] = (vy[i] ?? 0) - fy;
        vx[j] = (vx[j] ?? 0) + fx;
        vy[j] = (vy[j] ?? 0) + fy;
      }
    }
    for (const [a, b] of kantenIdx) {
      const pa = p[a]!;
      const pb = p[b]!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 150) * 0.02;
      vx[a] = (vx[a] ?? 0) + (dx / d) * f;
      vy[a] = (vy[a] ?? 0) + (dy / d) * f;
      vx[b] = (vx[b] ?? 0) - (dx / d) * f;
      vy[b] = (vy[b] ?? 0) - (dy / d) * f;
    }
    for (let i = 0; i < p.length; i++) {
      const pi = p[i]!;
      if (ids[i] === wurzel) {
        p[i] = { x: cx, y: cy };
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      const sx = (vx[i] ?? 0) + (cx - pi.x) * 0.004;
      const sy = (vy[i] ?? 0) + (cy - pi.y) * 0.004;
      const nx = Math.min(breite - 70, Math.max(70, pi.x + Math.max(-12, Math.min(12, sx * temp))));
      const ny = Math.min(hoehe - 30, Math.max(30, pi.y + Math.max(-12, Math.min(12, sy * temp))));
      p[i] = { x: nx, y: ny };
      vx[i] = sx * 0.6;
      vy[i] = sy * 0.6;
    }
  }
  ids.forEach((id, i) => pos.set(id, p[i]!));
  return pos;
}

function kurz(s: string, n = 26): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function NetzGrafik({ netz, wurzel, arten }: { netz: Netz; wurzel: string; arten: Set<Kante["art"]> }) {
  const breite = 920;
  const hoehe = 560;
  const kanten = useMemo(() => netz.kanten.filter((k) => arten.has(k.art)), [netz, arten]);
  const knoten = useMemo(() => {
    const verbunden = new Set<string>([wurzel]);
    for (const k of kanten) {
      verbunden.add(k.von);
      verbunden.add(k.nach);
    }
    return netz.knoten.filter((k) => verbunden.has(k.id));
  }, [netz, kanten, wurzel]);
  const pos = useMemo(() => layout(knoten, kanten, breite, hoehe, wurzel), [knoten, kanten, wurzel]);
  const [aktiv, setAktiv] = useState<string | null>(null);

  if (knoten.length <= 1) return <p className="muted">Noch keine Verbindungen bekannt.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${breite} ${hoehe}`} width="100%" style={{ minWidth: 640, background: "var(--panel-bg, transparent)", borderRadius: 8 }} role="img" aria-label="Netzgrafik der Verflechtungen">
        <defs>
          <marker id="pfeil" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#00C0A7" />
          </marker>
        </defs>
        {kanten.map((k, i) => {
          const a = pos.get(k.von);
          const b = pos.get(k.nach);
          if (!a || !b) return null;
          const hervor = aktiv === null || aktiv === k.von || aktiv === k.nach;
          // Leicht gebogene Kante: Verbindungen ueber eine dazwischen liegende Firma hinweg
          // bleiben sichtbar (kollineare Knoten), zwei Kanten desselben Paares trennen sich.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const bogen = (i % 2 === 0 ? 1 : -1) * Math.min(40, 0.12 * len);
          const cx = (a.x + b.x) / 2 + (-dy / len) * bogen;
          const cy = (a.y + b.y) / 2 + (dx / len) * bogen;
          const mx = 0.25 * a.x + 0.5 * cx + 0.25 * b.x;
          const my = 0.25 * a.y + 0.5 * cy + 0.25 * b.y;
          return (
            <g key={`${k.von}-${k.nach}-${k.art}-${i}`} opacity={hervor ? 1 : 0.15}>
              <title>{k.art === "ADRESSE" ? `Gleiche Adresse: ${k.quelle}` : `${ART_LABEL[k.art]}${k.prozent != null ? ` ${k.prozent.toLocaleString("de-DE", { maximumFractionDigits: 2 })} %` : ""}${k.seit ? ` seit ${new Date(k.seit).toLocaleDateString("de-DE")}` : ""}${k.bis ? ` bis ${new Date(k.bis).toLocaleDateString("de-DE")}` : ""}`}</title>
              <path d={`M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`} fill="none" stroke={ART_FARBE[k.art]} strokeWidth={k.aktuell ? 1.8 : 1} strokeDasharray={k.aktuell ? undefined : "4 4"} markerEnd={k.art === "BETEILIGUNG" ? "url(#pfeil)" : undefined} />
              {k.art === "BETEILIGUNG" && k.prozent != null && (
                <text x={mx} y={my - 4} fontSize={11} textAnchor="middle" fill="currentColor" opacity={0.85}>
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
          const hervor = aktiv === null || aktiv === k.id || kanten.some((e) => (e.von === aktiv && e.nach === k.id) || (e.nach === aktiv && e.von === k.id));
          const tot = k.registerStatus === "CLOSED";
          const insolvent = !!k.insolvencyStatus && k.insolvencyStatus !== "NONE";
          const inhalt =
            k.typ === "FIRMA" ? (
              <>
                <rect x={p.x - 66} y={p.y - 17} width={132} height={34} rx={7} fill={istWurzel ? "#00C0A7" : "#0A1F2A"} stroke={insolvent ? "#d9534f" : "#00C0A7"} strokeWidth={istWurzel ? 2.5 : 1.2} opacity={tot ? 0.55 : 1} />
                <text x={p.x} y={p.y + 4} fontSize={11} textAnchor="middle" fill="#F2F7F6" fontWeight={istWurzel ? 700 : 500}>
                  {kurz(k.name, 22)}
                </text>
              </>
            ) : (
              <>
                <circle cx={p.x} cy={p.y} r={16} fill="#F2F7F6" stroke="#5b7cfa" strokeWidth={1.5} />
                <text x={p.x} y={p.y + 4} fontSize={11} textAnchor="middle" fill="#0A1F2A" fontWeight={600}>
                  {k.name
                    .split(/\s+/)
                    .map((t) => t[0])
                    .join("")
                    .slice(0, 3)}
                </text>
                <text x={p.x} y={p.y + 30} fontSize={10.5} textAnchor="middle" fill="currentColor">
                  {kurz(k.name, 28)}
                  {k.geburtsjahr ? ` (*${k.geburtsjahr})` : ""}
                </text>
              </>
            );
          const g = (
            <g key={k.id} opacity={hervor ? 1 : 0.25} onMouseEnter={() => setAktiv(k.id)} onMouseLeave={() => setAktiv(null)} style={{ cursor: istWurzel ? "default" : "pointer" }}>
              <title>
                {k.name}
                {k.typ === "PERSON" && k.wohnort ? `, ${k.wohnort}` : ""}
                {k.typ === "FIRMA" && k.registerStatus ? ` · ${k.registerStatus}` : ""}
                {insolvent ? ` · Insolvenz ${k.insolvencyStatus}` : ""}
              </title>
              {inhalt}
            </g>
          );
          if (k.typ === "PERSON")
            return (
              <Link key={k.id} to={`/personen/${encodeURIComponent(k.id)}`}>
                {g}
              </Link>
            );
          return k.typ === "FIRMA" && !istWurzel ? (
            <Link key={k.id} to={`/companies/${encodeURIComponent(k.id)}`}>
              {g}
            </Link>
          ) : (
            g
          );
        })}
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
          Pfeile zeigen vom Gesellschafter zur gehaltenen Firma. Gestrichelt = frühere Verbindung. Firmen anklicken öffnet die Firmendetails, Personen die Personenseite.
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
