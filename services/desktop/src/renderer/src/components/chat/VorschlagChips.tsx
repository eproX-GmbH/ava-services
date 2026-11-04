// v0.1.648 (docs/PLAN_CHAT_VORSCHLAEGE.md, V3) — Vorschlags-Chips im Chat.
// Zeile je Chip: Titel, gedaempfter Auftrag, rechts der Aktionsbegriff.
// Klick sendet den Auftrag als Nachricht (kein versteckter Tool-Aufruf).
import type { Chip } from "../../../../shared/nutzerstand-types";

// 2026-11-04 — Wegklicken: optionales X je Chip (SVG, vertikal auf der Zeile
// zentriert); der Vorschlag bleibt dann ausgeschlossen, beim naechsten Oeffnen
// kommen frische.
export function VorschlagChips({ chips, quelle, onPick, onDismiss, titel, kompakt }: { chips: Chip[]; quelle?: "ki" | "cache" | "fest"; onPick: (c: Chip) => void; onDismiss?: (c: Chip) => void; titel?: string; kompakt?: boolean }) {
  if (chips.length === 0) return null;
  return (
    <div className={`vs-chips${kompakt ? " vs-chips--kompakt" : ""}`} role="list" aria-label="Vorgeschlagene nächste Schritte">
      {titel && <div className="vs-chips__titel">{titel}</div>}
      {chips.map((c) => (
        <div key={`${c.titel}-${c.gruppe}`} className="vs-chip" role="listitem">
          <button type="button" className="vs-chip__main" onClick={() => onPick(c)} title={c.auftrag}>
            <span className="vs-chip__stufe" aria-hidden="true">
              {c.stufe ?? "·"}
            </span>
            <span className="vs-chip__text">
              <span className="vs-chip__titel">{c.titel}</span>
              {!kompakt && <span className="vs-chip__auftrag">{c.auftrag}</span>}
            </span>
            <span className="vs-chip__aktion">{c.aktion ?? "Los"}</span>
          </button>
          {onDismiss && (
            <button type="button" className="vs-chip__x" onClick={() => onDismiss(c)} aria-label={`Vorschlag „${c.titel}“ ausblenden`} title="Ausblenden">
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false">
                <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
              </svg>
            </button>
          )}
        </div>
      ))}
      {quelle === "fest" && <div className="muted small vs-chips__hinweis">Feste Vorschläge, weil kein KI-Modell bereit ist oder die Organisation Vorschläge abgeschaltet hat.</div>}
    </div>
  );
}

/** Versteckter Kontextsatz, der mit dem Auftrag an AVA geht (nicht im Bubble). */
export function auftragMitKontext(c: Chip, ort: "startseite" | "gespraech"): string {
  return `${c.auftrag}\n\n[Vorschlag: "${c.titel}" (Bereich ${c.gruppe}${c.stufe ? `, Stufe ${c.stufe}` : ""}, ${ort === "startseite" ? "von der Startseite" : "aus dem Gespräch"}). Führe den Auftrag vollständig mit den passenden Werkzeugen aus; frag nur nach, wenn eine Angabe wirklich fehlt.]`;
}
