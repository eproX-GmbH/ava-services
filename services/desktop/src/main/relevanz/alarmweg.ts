// Welchen Weg eine Meldung nimmt (docs/PLAN_RELEVANZ.md, Abschnitt 6).
//
// WICHTIG, und in der ersten Fassung falsch herum gebaut: Der Wert
// UNTERDRUECKT nichts. Er stuft HOCH.
//
// Eine kalte Firma meldet weiter alles, was sie heute meldet — ein
// Geschaeftsfuehrerwechsel, eine Insolvenz, ein starkes Signal im
// Jahresabschluss, ein ICP-Treffer gehen immer durch, und zwar sofort.
// Alles andere waere ein Datenverlust, den der Nutzer nicht bemerkt und
// deshalb nicht korrigieren kann.
//
// Was der Wert stattdessen tut: Bei einer Firma, an der der Nutzer gerade
// arbeitet, wird genauer hingesehen. Dort wiegt eine Beobachtung, die
// anderswo eine blosse Information waere, schwerer — sie wird zur Warnung,
// und bei den heissesten Firmen zur dringenden Meldung.
//
// Gesammelt wird nur das eine, was die urspruengliche Frage aufwarf: das
// Rauschen aus Feed und Website-Aenderungen bei Firmen, an denen gerade
// niemand arbeitet. Bei 2000 Firmen waere ein Ping bei jedem neuen
// Positionstitel irgendeines Mitarbeiters uebertrieben — aber selbst das
// wird gesammelt und nicht weggeworfen.

import type { AlertKind, AlertSeverity } from "../../shared/types";

export type Alarmweg =
  /** Sofort melden, samt Push. */
  | "sofort"
  /** In die Tageszusammenfassung. Wird NICHT verworfen. */
  | "sammeln";

/**
 * Die einzigen Meldungsarten, die ueberhaupt gesammelt werden koennen.
 *
 * Alles andere — Registeraenderungen, Insolvenz, Jahresabschluesse,
 * Radar- und Best-Match-Treffer, abgeschlossene Importe, Workflows,
 * Erinnerungen — geht immer sofort. Die Liste ist bewusst eine
 * Positivliste: Eine neue Meldungsart ist damit im Zweifel sofort
 * zustellbar, und nicht versehentlich still.
 */
const SAMMELBAR: AlertKind[] = ["linkedin-signal", "link-change"];

/** Ab hier wird genauer hingesehen: eine Stufe hoeher. */
export const HEISS_AB = 7;
/** Ab hier ist alles dringend. */
export const BRENNEND_AB = 9;
/** Unterhalb dieses Rangs darf Rauschen gesammelt werden. */
export const SAMMELN_UNTER = 6;

export interface AlarmwegEingang {
  /** Rang der Firma (0,6·Naehe + 0,4·Gewicht), oder null wenn unbekannt. */
  rang: number | null;
  severity: AlertSeverity;
  kind: AlertKind;
}

export interface AlarmwegErgebnis {
  weg: Alarmweg;
  /** Stufe nach der Hochstufung — das ist die, die gemeldet wird. */
  severity: AlertSeverity;
  /** true, wenn der Wert die Stufe angehoben hat (fuer die Begruendung). */
  hochgestuft: boolean;
}

const RANG: AlertSeverity[] = ["info", "warn", "urgent"];

/**
 * Hochstufung bei Firmen, an denen der Nutzer gerade arbeitet.
 *
 * Das ist der eigentliche Zweck des ganzen Werts: Dieselbe Beobachtung
 * bedeutet bei einer Firma, mit der gerade gearbeitet wird, etwas anderes
 * als bei einer, die seit Monaten ruht.
 *
 * Achtung, echte Folge: `urgent` umgeht die Ruhezeiten. Eine brennend
 * heisse Firma kann deshalb auch nachts melden. Das ist gewollt — wer eine
 * Firma so eng verfolgt, will nicht am naechsten Morgen erfahren, dass
 * etwas passiert ist.
 */
export function stufeHoch(severity: AlertSeverity, rang: number | null): AlertSeverity {
  if (rang === null) return severity;
  if (rang >= BRENNEND_AB) return "urgent";
  if (rang >= HEISS_AB) {
    const i = RANG.indexOf(severity);
    return RANG[Math.min(RANG.length - 1, i + 1)] ?? severity;
  }
  return severity;
}

export function alarmweg({ rang, severity, kind }: AlarmwegEingang): AlarmwegErgebnis {
  const neu = stufeHoch(severity, rang);
  const hochgestuft = neu !== severity;

  // Gesammelt wird nur Rauschen: eine blosse Information aus Feed oder
  // Website-Ueberwachung, bei einer Firma, an der gerade niemand arbeitet.
  // Ein unbekannter Rang zaehlt NICHT als kalt — eine Firma, ueber die AVA
  // nichts weiss, ist nicht dasselbe wie eine, die niemanden interessiert.
  const rauschen =
    neu === "info" &&
    SAMMELBAR.includes(kind) &&
    rang !== null &&
    rang < SAMMELN_UNTER;

  return { weg: rauschen ? "sammeln" : "sofort", severity: neu, hochgestuft };
}

/** Eine Zeile fuer die Transparenzliste. */
export function wegBegruendung(e: AlarmwegErgebnis, rang: number | null): string {
  const r = rang === null ? "" : ` (Rang ${rang.toFixed(1)})`;
  if (e.weg === "sammeln") {
    return `Randnotiz bei einer Firma, an der du gerade nicht arbeitest${r} — kommt in die Tageszusammenfassung.`;
  }
  if (e.hochgestuft) {
    return `Du arbeitest gerade an dieser Firma${r} — deshalb als "${e.severity}" statt nur als Hinweis.`;
  }
  return "";
}
