// Die Schalter der E-Mail-Ableitung stellt die Person in der AVA ein; der
// Desktop speichert sie in userData/email-muster.json (EmailMusterSupervisor).
// Der Producer liest sie bei jedem Trigger frisch, damit "aus" sofort gilt.
// Fehlt die Datei oder ist sie unlesbar, gelten die Standards (alles an).

import { readFileSync } from "node:fs";
import { pruefungenJeStunde } from "@ava/email-muster";

export interface Einstellungen {
  aktiv: boolean;
  zuordnungAktiv: boolean;
  ungeprueftSpeichern: boolean;
  /** RCPT-TO-Anfragen je Stunde (Verifizierungsrate), Einstellung der Person. */
  pruefungenJeStunde: number;
}

export function leseEinstellungen(datei: string | null, featureAktiv: boolean): Einstellungen {
  let roh: { enabled?: unknown; zuordnungAktiv?: unknown; ungeprueftAnzeigen?: unknown; pruefungenJeStunde?: unknown } = {};
  if (datei) {
    try {
      roh = JSON.parse(readFileSync(datei, "utf8")) as typeof roh;
    } catch {
      roh = {};
    }
  }
  return {
    aktiv: featureAktiv && roh.enabled !== false,
    zuordnungAktiv: roh.zuordnungAktiv !== false,
    ungeprueftSpeichern: roh.ungeprueftAnzeigen !== false,
    pruefungenJeStunde: pruefungenJeStunde(roh.pruefungenJeStunde),
  };
}
