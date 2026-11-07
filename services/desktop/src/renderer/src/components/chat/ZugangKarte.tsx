// L6 (docs/PLAN_LOESUNGSKARTEN.md): sichere Zugangskarte im Chat. AVA fragt den
// Zugang zu einem Dienst ab; die Werte gehen ueber das gemeinsame Formular direkt
// in den geschuetzten Speicher dieses Rechners. AVA erfaehrt nur das Ergebnis.
import type { ZugangAnfrage, ZugangErgebnis } from "../../../../shared/dienst-vorlagen";
import { ZugangFormular } from "../ZugangFormular";

export function ZugangKarte(props: { anfrage: ZugangAnfrage; ergebnis?: ZugangErgebnis; onFertig: (e: ZugangErgebnis) => void }) {
  const name = props.anfrage.name ?? "Dienst";
  if (props.ergebnis) {
    return (
      <div className="zugang-karte zugang-karte--fertig">
        {props.ergebnis.verbunden ? `${props.ergebnis.name ?? name} ist verbunden.` : props.ergebnis.abgebrochen ? `Verbindung mit ${name} abgebrochen.` : `Verbindung mit ${name} fehlgeschlagen.`}
      </div>
    );
  }
  return (
    <div className="zugang-karte">
      <div className="zugang-karte__kopf">
        <strong>{name} verbinden</strong>
        {props.anfrage.grund && <span className="muted small">{props.anfrage.grund}</span>}
      </div>
      <ZugangFormular
        vorbelegung={props.anfrage}
        kompakt
        onVerbunden={(d) => props.onFertig({ verbunden: true, name: d.name, slug: d.slug, werkzeuge: d.werkzeuge })}
        onAbbrechen={() => props.onFertig({ verbunden: false, abgebrochen: true })}
      />
      <p className="muted small zugang-karte__hinweis">
        Deine Angaben gehen direkt in den geschützten Speicher dieses Rechners. Sie stehen nicht im Chat, und AVA bekommt sie nicht zu sehen.
      </p>
    </div>
  );
}
