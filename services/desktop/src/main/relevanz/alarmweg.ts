// Welchen Weg eine Meldung nimmt (docs/PLAN_RELEVANZ.md, Abschnitt 6).
//
// Das ist die Antwort auf die urspruengliche Frage: Bei 2000 Firmen waere
// ein Alarm jedes Mal, wenn irgendjemand einen neuen Positionstitel hat,
// sinnlos. Aber dieselbe Meldung ist bei der Firma, an der der Nutzer
// gerade arbeitet, genau das, wofuer AVA da ist.
//
// Der Wert entscheidet deshalb NICHT, ob etwas eine Meldung ist — ein
// Positionswechsel bleibt ein Positionswechsel. Er entscheidet nur, ob sie
// sofort kommt, gesammelt wird oder im Datensatz bleibt. Das haelt den
// Judge einfach und das Verhalten erklaerbar.
//
// Drei harte Ausnahmen stehen ueber allem. Sie sind bewusst fest
// verdrahtet und nicht ueber Gewichte einstellbar: Es waere absurd, die
// Insolvenz eines Kunden zu verschweigen, weil ihn noch niemand
// angeklickt hat.

import type { AlertKind, AlertSeverity } from "../../shared/types";

export type Alarmweg =
  /** Sofort melden, samt Push. */
  | "sofort"
  /** In die Tageszusammenfassung. */
  | "sammeln"
  /** Nur im Datensatz — kein Alarm. */
  | "nein";

/** Meldungsarten, die IMMER durchgehen, egal wie kalt die Firma ist. */
const IMMER: AlertKind[] = ["status"];

export interface AlarmwegEingang {
  /** Rang der Firma (0,6·Naehe + 0,4·Gewicht), oder null wenn unbekannt. */
  rang: number | null;
  severity: AlertSeverity;
  kind: AlertKind;
}

export function alarmweg({ rang, severity, kind }: AlarmwegEingang): Alarmweg {
  // 1. Statuswarnungen: Insolvenz, Loeschung, Liquidation. Immer.
  if (IMMER.includes(kind)) return "sofort";

  // 2. Dringendes umgeht alles — auch die Ruhezeiten, das regelt der
  //    Zustellweg. Was dringend ist, entscheidet der Judge, nicht der Wert.
  if (severity === "urgent") return "sofort";

  // 3. Ohne Wert im Zweifel melden. Eine Firma, ueber die AVA nichts
  //    weiss, ist nicht dasselbe wie eine, die der Nutzer abgelehnt hat —
  //    und eine verschluckte erste Meldung waere der schlechtere Fehler.
  if (rang === null) return "sofort";

  if (rang >= 8) return "sofort";                       // heiss: alles sofort
  if (rang >= 6) return severity === "warn" ? "sofort" : "sammeln";
  if (rang >= 4) return severity === "warn" ? "sammeln" : "nein";
  return "nein";                                        // kalt: nur Dringendes
}

/** Fuer die Transparenzliste: warum eine Meldung nicht sofort kam. */
export function wegBegruendung(weg: Alarmweg, rang: number | null): string {
  if (rang === null) return "";
  const r = rang.toFixed(1);
  if (weg === "sammeln") {
    return `Diese Firma ist derzeit lauwarm (Rang ${r}) — kommt in die Tageszusammenfassung.`;
  }
  if (weg === "nein") {
    return `Diese Firma ist derzeit kalt (Rang ${r}) — nur im Datensatz, kein Alarm.`;
  }
  return "";
}
