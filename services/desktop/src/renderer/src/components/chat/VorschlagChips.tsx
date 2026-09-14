// v0.1.648 (docs/PLAN_CHAT_VORSCHLAEGE.md, V3) — Vorschlags-Chips im Chat.
// Zeile je Chip: Titel, gedaempfter Auftrag, rechts der Aktionsbegriff.
// Klick sendet den Auftrag als Nachricht (kein versteckter Tool-Aufruf).
import type { Chip } from "../../../../shared/nutzerstand-types";

export function VorschlagChips({ chips, quelle, onPick, titel, kompakt }: { chips: Chip[]; quelle?: "ki" | "cache" | "fest"; onPick: (c: Chip) => void; titel?: string; kompakt?: boolean }) {
  if (chips.length === 0) return null;
  return (
    <div className={`vs-chips${kompakt ? " vs-chips--kompakt" : ""}`} role="list" aria-label="Vorgeschlagene nächste Schritte">
      {titel && <div className="vs-chips__titel">{titel}</div>}
      {chips.map((c) => (
        <button key={`${c.titel}-${c.gruppe}`} type="button" className="vs-chip" role="listitem" onClick={() => onPick(c)} title={c.auftrag}>
          <span className="vs-chip__stufe" aria-hidden="true">
            {c.stufe ?? "·"}
          </span>
          <span className="vs-chip__text">
            <span className="vs-chip__titel">{c.titel}</span>
            {!kompakt && <span className="vs-chip__auftrag">{c.auftrag}</span>}
          </span>
          <span className="vs-chip__aktion">{c.aktion ?? "Los"}</span>
        </button>
      ))}
      {quelle === "fest" && <div className="muted small vs-chips__hinweis">Feste Vorschläge, weil kein KI-Modell bereit ist oder die Organisation Vorschläge abgeschaltet hat.</div>}
    </div>
  );
}

/** Versteckter Kontextsatz, der mit dem Auftrag an AVA geht (nicht im Bubble). */
export function auftragMitKontext(c: Chip, ort: "startseite" | "gespraech"): string {
  return `${c.auftrag}\n\n[Vorschlag: "${c.titel}" (Bereich ${c.gruppe}${c.stufe ? `, Stufe ${c.stufe}` : ""}, ${ort === "startseite" ? "von der Startseite" : "aus dem Gespräch"}). Führe den Auftrag vollständig mit den passenden Werkzeugen aus; frag nur nach, wenn eine Angabe wirklich fehlt.]`;
}
