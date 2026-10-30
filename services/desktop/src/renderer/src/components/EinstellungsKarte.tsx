// Einstellungen (docs/PLAN_EINSTELLUNGEN_UI.md §4): EINE Karte als Muster fuer
// jeden Abschnitt. Titel, ein Nutzensatz, Status rechts oben, Inhalt, Aktionen,
// optional ein eingeklapptes "Technische Details". Ladezustand als Platzhalter in
// der Karte, nie ein verschwindender Abschnitt.
import type { ReactNode } from "react";

export type KartenStatus = { text: string; ton?: "ok" | "aus" | "laeuft" | "fehlt" | "vorgabe" | "warn" };

export function StatusChip({ status }: { status: KartenStatus }) {
  return <span className={`ek-chip ek-chip--${status.ton ?? "aus"}`}>{status.text}</span>;
}

export function EinstellungsKarte({
  id,
  titel,
  text,
  status,
  aktion,
  technik,
  className,
  laedt,
  children,
}: {
  id: string;
  titel: ReactNode;
  /** Ein Nutzensatz in Du-Form. */
  text?: ReactNode;
  status?: KartenStatus | null;
  /** Knopf oder Link rechts im Kopf. */
  aktion?: ReactNode;
  /** Pfade, Ports, IDs, Modellnamen — eingeklappt, Standard zu. */
  technik?: ReactNode;
  className?: string;
  /** Inhalt noch nicht da: Platzhalter statt Inhalt. */
  laedt?: boolean;
  children?: ReactNode;
}) {
  return (
    <section id={id} className={`ek provider-section${className ? ` ${className}` : ""}`} aria-busy={laedt || undefined}>
      <header className="ek__kopf">
        <div className="ek__titel">
          <h3>{titel}</h3>
          {text && <p className="ek__text">{text}</p>}
        </div>
        <div className="ek__rechts">
          {status && <StatusChip status={status} />}
          {aktion}
        </div>
      </header>
      {laedt ? (
        <div className="ek__platzhalter" aria-hidden="true">
          <span />
          <span />
        </div>
      ) : (
        children
      )}
      {technik && !laedt && (
        <details className="ek__technik">
          <summary>Technische Details</summary>
          <div className="ek__technik-inhalt">{technik}</div>
        </details>
      )}
    </section>
  );
}
