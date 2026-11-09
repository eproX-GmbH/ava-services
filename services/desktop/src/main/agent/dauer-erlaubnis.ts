// Dauerhafte Erlaubnis je Werkzeug (Joyce 2026-11-09): wie bei Betriebssystemen
// „Nur dieses Mal“ oder „Immer erlauben“. Einmal erlaubt, fragt dasselbe Werkzeug
// nicht mehr nach (Chat, Telegram, Workflows), auch bei loeschenden Aktionen,
// wenn der Nutzer es ausdruecklich so gewaehlt hat. Uebersicht und Widerruf in
// den Einstellungen (Konto → Erlaubnisse) und per Chat-Werkzeug `erlaubnisse`.
// Gespeichert je Konto im userData (der Konto-Space ist das userData).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../../core/platform";
import type { DauerErlaubnis } from "../../shared/types";

type Eintrag = { seit: string; beispiel?: string; loeschend?: boolean };

const datei = () => join(paths().get("userData"), "dauer-erlaubnisse.json");

function lesen(): Record<string, Eintrag> {
  try {
    if (!existsSync(datei())) return {};
    const roh = JSON.parse(readFileSync(datei(), "utf8")) as unknown;
    return roh && typeof roh === "object" && !Array.isArray(roh) ? (roh as Record<string, Eintrag>) : {};
  } catch {
    return {};
  }
}

function schreiben(d: Record<string, Eintrag>): void {
  writeFileSync(datei(), JSON.stringify(d, null, 2), { mode: 0o600 });
}

export const dauerErlaubnis = {
  hat(werkzeug: string): boolean {
    return !!lesen()[werkzeug];
  },
  /** beispiel: erste Zeile der Rueckfrage, damit die Uebersicht zeigt, worum es ging. */
  erteilen(werkzeug: string, opts: { beispiel?: string; loeschend?: boolean } = {}): void {
    const d = lesen();
    const beispiel = opts.beispiel?.split("\n").find((z) => z.trim())?.trim().slice(0, 160);
    d[werkzeug] = { seit: new Date().toISOString(), ...(beispiel ? { beispiel } : {}), ...(opts.loeschend ? { loeschend: true } : {}) };
    schreiben(d);
  },
  widerrufen(werkzeug: string): boolean {
    const d = lesen();
    if (!d[werkzeug]) return false;
    delete d[werkzeug];
    schreiben(d);
    return true;
  },
  alleWiderrufen(): number {
    const n = Object.keys(lesen()).length;
    schreiben({});
    return n;
  },
  liste(): DauerErlaubnis[] {
    return Object.entries(lesen())
      .map(([werkzeug, v]) => ({ werkzeug, seit: v.seit, ...(v.beispiel ? { beispiel: v.beispiel } : {}), loeschend: v.loeschend === true }))
      .sort((a, b) => b.seit.localeCompare(a.seit));
  },
};

/** Options-Wert fuer „Immer erlauben“ in Bestaetigungsdialogen. */
export const IMMER_ERLAUBEN = "__immer_erlauben__";
