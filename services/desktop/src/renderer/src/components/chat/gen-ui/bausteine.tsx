// Generative UI (docs/PLAN_GENERATIVE_UI.md): die Bausteine im AVA-Design.
// Jede Komponente ist nachsichtig gegenueber fehlenden Feldern (Modellausgabe);
// Werte zeigen wir nur so, wie sie im Spec stehen, nichts wird ergaenzt.

import { useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { defineRegistry, type BaseComponentProps } from "@json-render/react";
import { gatewayFetch } from "../../../api/gateway";
import { ChatChart } from "../../ChatChart";
import type { ChartSpec } from "../../../lib/chart-spec";
import { genUiKatalog, type GenUiFormat, type GenUiName, type GenUiProps } from "./katalog";

type K<N extends GenUiName> = BaseComponentProps<GenUiProps<N>>;

// ---- Formatierung -----------------------------------------------------------

function zahl(v: number, stellen = 1): string {
  return v.toLocaleString("de-DE", { maximumFractionDigits: stellen, minimumFractionDigits: 0 });
}

export function formatWert(v: number | null | undefined, format: GenUiFormat | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const f = format ?? "num";
  if (f === "pct") return `${zahl(v)} %`;
  if (f === "int") return Math.round(v).toLocaleString("de-DE");
  if (f === "eur") {
    const a = Math.abs(v);
    if (a >= 1e9) return `${zahl(v / 1e9)} Mrd. €`;
    if (a >= 1e6) return `${zahl(v / 1e6)} Mio. €`;
    if (a >= 1e4) return `${zahl(v / 1e3, 0)} Tsd. €`;
    return `${v.toLocaleString("de-DE", { maximumFractionDigits: 2 })} €`;
  }
  return zahl(v, 2);
}

/** Unter 0,05 % gilt als unveraendert (sonst zeigte „+0 %“ gruen). */
function veraenderungText(v: number): string {
  if (Math.abs(v) < 0.05) return "±0 %";
  return `${v > 0 ? "+" : "−"}${zahl(Math.abs(v))} %`;
}

function Veraenderung({ wert }: { wert: number }) {
  const ton = Math.abs(wert) < 0.05 ? "neutral" : wert > 0 ? "gut" : "schlecht";
  return <span className={`gu-delta gu-delta--${ton}`}>{veraenderungText(wert)}</span>;
}

/** **fett** im Fliesstext, sonst reiner Text. */
function textMitFett(t: string): ReactNode[] {
  return t.split(/(\*\*[^*]+\*\*)/g).map((teil, i) =>
    teil.startsWith("**") && teil.endsWith("**") && teil.length > 4 ? <strong key={i}>{teil.slice(2, -2)}</strong> : <span key={i}>{teil}</span>,
  );
}

const FARBEN = ["var(--color-brand-500)", "var(--color-cyan-600, #0891b2)", "var(--color-amber-500, #f59e0b)", "var(--color-indigo-300, #a5b4fc)", "var(--color-fg-faint)", "var(--color-brand-800)"];

function chartFormat(f: GenUiFormat | null | undefined): ChartSpec["format"] {
  return f ?? "num";
}

function Sparkline({ werte }: { werte: number[] }) {
  if (werte.length < 2) return null;
  const min = Math.min(...werte);
  const max = Math.max(...werte);
  const spanne = max - min || 1;
  const pts = werte.map((w, i) => `${(i / (werte.length - 1)) * 100},${28 - ((w - min) / spanne) * 24}`).join(" ");
  return (
    <svg className="gu-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--color-brand-500)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---- Firmenkarte ------------------------------------------------------------

interface FirmaKurz {
  name?: string;
  location?: string | null;
  city?: string | null;
  registerStatus?: string | null;
  insolvencyStatus?: string | null;
  legalForm?: string | null;
}

function Firmenkarte({ companyId, grund, score }: { companyId: string; grund?: string | null; score?: number | null }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["company", companyId],
    queryFn: () => gatewayFetch<FirmaKurz>(`/v1/companies/${encodeURIComponent(companyId)}`),
    enabled: !!companyId,
    retry: false,
  });
  const f = q.data;
  const ort = f?.location ?? f?.city ?? null;
  const status =
    f?.insolvencyStatus && f.insolvencyStatus !== "NONE"
      ? { text: "Insolvenz", ton: "schlecht" }
      : f?.registerStatus === "CLOSED"
        ? { text: "gelöscht", ton: "schlecht" }
        : f?.registerStatus === "LOESCHUNG_ANGEKUENDIGT"
          ? { text: "in Löschung", ton: "warnung" }
          : null;
  return (
    <div className="gu-firma">
      <div className="gu-firma__kopf">
        <button type="button" className="gu-link gu-firma__name" onClick={() => navigate(`/companies/${encodeURIComponent(companyId)}`)}>
          {f?.name ?? (q.isLoading ? "Wird geladen…" : companyId)}
        </button>
        {typeof score === "number" && <span className="gu-marke gu-marke--marke">Score {Math.round(score)}</span>}
        {status && <span className={`gu-marke gu-marke--${status.ton}`}>{status.text}</span>}
      </div>
      {(ort || f?.legalForm) && <div className="gu-gedaempft">{[ort, f?.legalForm].filter(Boolean).join(" · ")}</div>}
      {grund && <p className="gu-firma__grund">{textMitFett(grund)}</p>}
      {q.isError && <div className="gu-gedaempft">Firma nicht gefunden.</div>}
    </div>
  );
}

// ---- Ring -------------------------------------------------------------------

function Ring({ anteile, format }: { anteile: Array<{ label: string; wert: number }>; format: GenUiFormat | null | undefined }) {
  const gueltig = anteile.filter((a) => Number.isFinite(a.wert) && a.wert > 0).slice(0, 6);
  const summe = gueltig.reduce((s, a) => s + a.wert, 0) || 1;
  let winkel = -Math.PI / 2;
  const r = 40;
  const bogen = gueltig.map((a, i) => {
    const anteil = a.wert / summe;
    const start = winkel;
    const ende = winkel + anteil * Math.PI * 2;
    winkel = ende;
    const gross = ende - start > Math.PI ? 1 : 0;
    const p = (w: number) => `${50 + r * Math.cos(w)},${50 + r * Math.sin(w)}`;
    const d = anteil >= 0.9999 ? `M 50,${50 - r} A ${r},${r} 0 1 1 49.99,${50 - r}` : `M ${p(start)} A ${r},${r} 0 ${gross} 1 ${p(ende)}`;
    return <path key={a.label} d={d} fill="none" stroke={FARBEN[i % FARBEN.length]} strokeWidth="14" />;
  });
  return (
    <div className="gu-ring">
      <svg viewBox="0 0 100 100" className="gu-ring__grafik" aria-hidden="true">
        {bogen}
      </svg>
      <ul className="gu-ring__legende">
        {gueltig.map((a, i) => (
          <li key={a.label}>
            <span className="gu-ring__farbe" style={{ background: FARBEN[i % FARBEN.length] }} />
            <span className="gu-ring__label">{a.label}</span>
            <span className="gu-ring__wert">{zahl((a.wert / summe) * 100, 0)} %</span>
            {format !== "pct" && <span className="gu-gedaempft gu-ring__abs">{formatWert(a.wert, format)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- Tabellenzelle ----------------------------------------------------------

type Zelle = string | number | null | { text: string; companyId?: string | null; personId?: string | null };
type SpaltenTyp = "text" | "zahl" | "geld" | "prozent" | "veraenderung" | "marke" | "datum";

function TabellenZelle({ wert, typ }: { wert: Zelle; typ: SpaltenTyp }) {
  const navigate = useNavigate();
  if (wert === null || wert === undefined || wert === "") return <span className="gu-gedaempft">–</span>;
  if (typeof wert === "object") {
    const ziel = wert.companyId ? `/companies/${encodeURIComponent(wert.companyId)}` : wert.personId ? `/personen/${encodeURIComponent(wert.personId)}` : null;
    return ziel ? (
      <button type="button" className="gu-link" onClick={() => navigate(ziel)}>
        {wert.text}
      </button>
    ) : (
      <span>{wert.text}</span>
    );
  }
  if (typ === "veraenderung" && typeof wert === "number") return <Veraenderung wert={wert} />;
  if (typ === "marke") return <span className="gu-marke gu-marke--neutral">{String(wert)}</span>;
  if (typeof wert === "number") {
    if (typ === "geld") return <span>{formatWert(wert, "eur")}</span>;
    if (typ === "prozent") return <span>{formatWert(wert, "pct")}</span>;
    return <span>{formatWert(wert, "num")}</span>;
  }
  return <span>{wert}</span>;
}

// ---- Registry ---------------------------------------------------------------

export const { registry: genUiRegistry } = defineRegistry(genUiKatalog, {
  // Komponenten mit eigenen Prop-Typen (K<…>), siehe katalog.ts zur Typableitung.
  components: {
    Karte: ({ props, children, slots }: K<"Karte">) => (
      <section className="gu-karte">
        {(props.titel || props.untertitel || slots?.aktion) && (
          <header className="gu-karte__kopf">
            <div>
              {props.titel && <h3 className="gu-karte__titel">{props.titel}</h3>}
              {props.untertitel && <div className="gu-gedaempft">{props.untertitel}</div>}
            </div>
            {slots?.aktion && <div className="gu-karte__aktion">{slots.aktion}</div>}
          </header>
        )}
        <div className="gu-karte__inhalt">{children}</div>
      </section>
    ),
    Raster: ({ props, children }: K<"Raster">) => (
      <div className="gu-raster" style={{ ["--gu-spalten" as string]: String(Math.min(4, Math.max(1, props.spalten ?? 2))) }}>
        {children}
      </div>
    ),
    Abschnitt: ({ props, children }: K<"Abschnitt">) => (
      <div className="gu-abschnitt">
        {props.titel && <h4 className="gu-abschnitt__titel">{props.titel}</h4>}
        {children}
      </div>
    ),
    Text: ({ props }: K<"Text">) => <p className={props.stil === "gedaempft" ? "gu-text gu-gedaempft" : "gu-text"}>{textMitFett(props.inhalt ?? "")}</p>,
    Hinweis: ({ props }: K<"Hinweis">) => <div className={`gu-hinweis gu-hinweis--${props.art ?? "info"}`}>{textMitFett(props.text ?? "")}</div>,
    Marke: ({ props }: K<"Marke">) => <span className={`gu-marke gu-marke--${props.ton ?? "neutral"}`}>{props.text}</span>,
    Kennzahlen: ({ children }: K<"Kennzahlen">) => <div className="gu-kennzahlen">{children}</div>,
    Kennzahl: ({ props }: K<"Kennzahl">) => (
      <div className="gu-kennzahl">
        <div className="gu-kennzahl__label">{props.label}</div>
        <div className="gu-kennzahl__wert">{typeof props.wert === "number" ? formatWert(props.wert, "num") : props.wert}</div>
        {(typeof props.veraenderung === "number" || props.vergleich) && (
          <div className="gu-kennzahl__fuss">
            {typeof props.veraenderung === "number" && <Veraenderung wert={props.veraenderung} />}
            {props.vergleich && <span className="gu-gedaempft">{props.vergleich}</span>}
          </div>
        )}
        {props.verlauf && props.verlauf.length > 1 && <Sparkline werte={props.verlauf} />}
      </div>
    ),
    Verlauf: ({ props }: K<"Verlauf">) => {
      const spec = useMemo<ChartSpec>(
        () => ({
          kind: props.flaeche ? "area" : "line",
          stacked: false,
          ...(props.titel ? { title: props.titel } : {}),
          format: chartFormat(props.format),
          series: (props.reihen ?? []).slice(0, 5).map((r) => ({ name: r.name, data: (r.punkte ?? []).filter((p) => Number.isFinite(p.y)).slice(0, 100) })),
        }),
        [props],
      );
      return spec.series.some((s) => s.data.length > 0) ? <ChatChart spec={spec} /> : null;
    },
    Balken: ({ props }: K<"Balken">) => {
      const spec = useMemo<ChartSpec>(
        () => ({
          kind: "bar",
          stacked: false,
          ...(props.titel ? { title: props.titel } : {}),
          format: chartFormat(props.format),
          series: (props.reihen ?? []).slice(0, 5).map((r) => ({
            name: r.name,
            data: (props.kategorien ?? []).flatMap((k, i) => {
              const y = r.werte?.[i];
              return typeof y === "number" && Number.isFinite(y) ? [{ x: k, y }] : [];
            }),
          })),
        }),
        [props],
      );
      return spec.series.some((s) => s.data.length > 0) ? <ChatChart spec={spec} /> : null;
    },
    Rangliste: ({ props }: K<"Rangliste">) => {
      const navigate = useNavigate();
      const eintraege = (props.eintraege ?? []).filter((e) => Number.isFinite(e.wert)).slice(0, 20);
      const max = Math.max(...eintraege.map((e) => Math.abs(e.wert)), 1);
      const mitHervorhebung = eintraege.some((e) => e.hervorheben);
      return (
        <div className="gu-rangliste">
          {props.titel && <div className="gu-diagramm-titel">{props.titel}</div>}
          {eintraege.map((e, i) => (
            <div key={`${e.label}-${i}`} className="gu-rangliste__zeile">
              <span className={`gu-rangliste__label${e.hervorheben ? " gu-rangliste__label--hervor" : ""}`}>
                {e.companyId ? (
                  <button type="button" className="gu-link" onClick={() => navigate(`/companies/${encodeURIComponent(e.companyId!)}`)}>
                    {e.label}
                  </button>
                ) : (
                  e.label
                )}
              </span>
              <span className="gu-rangliste__spur">
                <span
                  className={`gu-rangliste__balken${!mitHervorhebung || e.hervorheben ? " gu-rangliste__balken--marke" : ""}`}
                  style={{ width: `${Math.max(2, (Math.abs(e.wert) / max) * 100)}%` }}
                />
              </span>
              <span className="gu-rangliste__wert">{formatWert(e.wert, props.format)}</span>
            </div>
          ))}
        </div>
      );
    },
    Ring: ({ props }: K<"Ring">) => (
      <div className="gu-ring-block">
        {props.titel && <div className="gu-diagramm-titel">{props.titel}</div>}
        <Ring anteile={props.anteile ?? []} format={props.format} />
      </div>
    ),
    Tabelle: ({ props }: K<"Tabelle">) => {
      const spalten = props.spalten ?? [];
      const rechts = (t: SpaltenTyp | null | undefined) => t === "zahl" || t === "geld" || t === "prozent" || t === "veraenderung";
      return (
        <div className="gu-tabelle">
          {props.titel && <div className="gu-diagramm-titel">{props.titel}</div>}
          <div className="gu-tabelle__rahmen">
            <table>
              <thead>
                <tr>
                  {spalten.map((s, i) => (
                    <th key={i} className={rechts(s.typ) ? "gu-rechts" : undefined}>
                      {s.titel}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(props.zeilen ?? []).slice(0, 50).map((z, ri) => (
                  <tr key={ri}>
                    {spalten.map((s, ci) => (
                      <td key={ci} className={rechts(s.typ) ? "gu-rechts" : undefined}>
                        <TabellenZelle wert={(z?.[ci] ?? null) as Zelle} typ={(s.typ ?? "text") as SpaltenTyp} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    },
    Firmenkarte: ({ props }: K<"Firmenkarte">) => <Firmenkarte companyId={props.companyId} grund={props.grund} score={props.score} />,
    Knopfreihe: ({ children }: K<"Knopfreihe">) => <div className="gu-knopfreihe">{children}</div>,
    Knopf: ({ props, emit }: K<"Knopf">) => (
      <button type="button" className={props.art === "sekundaer" ? "btn" : "btn btn--primaer"} onClick={() => emit("press")}>
        {props.label}
      </button>
    ),
  },
  // Die echten Handler setzt GenUiBlock ueber JSONUIProvider (Navigation und
  // Chat-Auftrag brauchen React-Kontext); diese hier greifen nie.
  actions: {
    oeffnen: async () => undefined,
    auftrag: async () => undefined,
    link: async () => undefined,
  },
} as never);
