// Die Schalter der E-Mail-Ableitung stellt die Person in der AVA ein; der
// Desktop speichert sie in userData/email-muster.json (EmailMusterSupervisor).
// Der Producer liest sie bei jedem Trigger frisch, damit "aus" sofort gilt.
// Fehlt die Datei oder ist sie unlesbar, gelten die Standards (alles an).

import { readFileSync } from "node:fs";

export interface Einstellungen {
  aktiv: boolean;
  zuordnungAktiv: boolean;
  ungeprueftSpeichern: boolean;
}

export function leseEinstellungen(datei: string | null, featureAktiv: boolean): Einstellungen {
  let roh: { enabled?: unknown; zuordnungAktiv?: unknown; ungeprueftAnzeigen?: unknown } = {};
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
  };
}
