// Generative UI (docs/PLAN_GENERATIVE_UI.md): rendert einen ```spec-Zaun aus der
// Chat-Antwort. Der Zaun traegt JSON-Patch-Zeilen (json-render, Modus "inline");
// waehrend des Streamens waechst die Oberflaeche mit jeder fertigen Zeile.

import { Component, createContext, useContext, useMemo, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { createSpecStreamCompiler, type Spec } from "@json-render/core";
import { JSONUIProvider, Renderer } from "@json-render/react";
import { genUiKatalog } from "./katalog";
import { genUiRegistry } from "./bausteine";

/** Der Chat reicht hier den Weg fuer „auftrag“ herein (neue Nutzernachricht). */
export const GenUiAktionenContext = createContext<{ auftrag: (text: string) => void } | null>(null);

const ERLAUBTE_ZIELE = /^\/(companies|personen|radar|alerts|workflows|settings|alle-firmen|linkedin|transactions|buying-center|thema)(\/|$)/;

function specAus(raw: string, offen: boolean): Spec | null {
  const c = createSpecStreamCompiler();
  // Offener Zaun: die letzte Zeile kann noch unvollstaendig sein; der Compiler
  // nimmt nur abgeschlossene Zeilen.
  c.push(offen ? raw : `${raw}\n`);
  const spec = c.getResult() as unknown as Spec | null;
  // Erst rendern, wenn das Wurzel-Element da ist: beim Streamen kommt /root vor
  // /elements, und der Renderer stuerzt bei fehlenden elements ab (2026-11-09).
  if (!spec || typeof spec !== "object" || !spec.root) return null;
  const elemente = (spec as { elements?: unknown }).elements;
  if (!elemente || typeof elemente !== "object" || !(spec.root in (elemente as Record<string, unknown>))) return null;
  return spec;
}

/** Eine fehlerhafte Oberflaeche darf nie den ganzen Chat mitreissen. */
class GenUiGrenze extends Component<{ children: ReactNode; offen: boolean }, { fehler: boolean }> {
  state = { fehler: false };
  static getDerivedStateFromError() {
    return { fehler: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[gen-ui] Darstellung fehlgeschlagen:", err instanceof Error ? err.message : String(err));
  }
  componentDidUpdate(prev: { offen: boolean }) {
    // Beim Streamen kann ein Zwischenstand scheitern, der naechste klappt.
    if (this.state.fehler && prev.offen && !this.props.offen) this.setState({ fehler: false });
  }
  render() {
    if (this.state.fehler) return this.props.offen ? <div className="chart-placeholder">Ansicht wird aufgebaut…</div> : <div className="chart-placeholder">Diese Ansicht konnte nicht dargestellt werden.</div>;
    return this.props.children;
  }
}

export function GenUiBlock({ raw, offen = false }: { raw: string; offen?: boolean }) {
  const navigate = useNavigate();
  const ctx = useContext(GenUiAktionenContext);
  const spec = useMemo(() => {
    try {
      return specAus(raw, offen);
    } catch {
      return null;
    }
  }, [raw, offen]);
  const pruefung = useMemo(() => (spec && !offen ? genUiKatalog.validate(spec) : null), [spec, offen]);
  if (pruefung && !pruefung.success) console.warn("[gen-ui] Spec weicht vom Katalog ab:", pruefung.error?.issues?.slice(0, 5));

  const handlers = useMemo(
    () => ({
      oeffnen: (p: Record<string, unknown>) => {
        const ziel = typeof p.ziel === "string" ? p.ziel.trim() : "";
        if (ERLAUBTE_ZIELE.test(ziel)) navigate(ziel);
      },
      auftrag: (p: Record<string, unknown>) => {
        const text = typeof p.text === "string" ? p.text.trim() : "";
        if (text && ctx) ctx.auftrag(text);
      },
      link: (p: Record<string, unknown>) => {
        const url = typeof p.url === "string" ? p.url.trim() : "";
        if (/^https:\/\//i.test(url)) void window.api.shell.openExternal(url);
      },
    }),
    [navigate, ctx],
  );

  if (!spec) return offen ? <div className="chart-placeholder">Ansicht wird aufgebaut…</div> : null;
  return (
    <div className="gu-block">
      <GenUiGrenze offen={offen}>
        <JSONUIProvider registry={genUiRegistry} handlers={handlers}>
          <Renderer spec={spec} registry={genUiRegistry} loading={offen} fallback={() => null} />
        </JSONUIProvider>
      </GenUiGrenze>
    </div>
  );
}
