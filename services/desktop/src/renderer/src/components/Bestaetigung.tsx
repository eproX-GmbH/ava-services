// Einstellungen (docs/PLAN_EINSTELLUNGEN_UI.md §4): eigener Bestaetigungsdialog
// statt window.confirm. Zerstoerende Aktionen rot.
import { useEffect, useRef } from "react";
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
  return (
    <div className="ek-dialog__hintergrund" role="presentation" onClick={onAbbrechen}>
      <div ref={ref} className="ek-dialog" role="dialog" aria-modal="true" aria-labelledby="ek-dialog-titel" onClick={(e) => e.stopPropagation()}>
        <h4 id="ek-dialog-titel">{titel}</h4>
        {text && <div className="ek-dialog__text">{text}</div>}
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
