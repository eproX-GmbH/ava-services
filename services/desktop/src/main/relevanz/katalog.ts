// Signalkatalog (docs/PLAN_RELEVANZ.md, Abschnitt 3).
//
// Ein Signal ist eine Handlung des Nutzers an einer Firma oder Person.
// Punkte sagen, wie viel die Handlung wiegt, die Halbwertszeit, wie lange
// sie nachwirkt.
//
// Leitgedanke bei den Zahlen: Die teuersten Handlungen sind die besten
// Anzeichen. Eine Ansicht kostet einen Klick. Einen DSGVO-Hinweis
// kopieren heisst, dass der Nutzer diese Person anschreibt — ein
// ehrlicheres Absichtssignal gibt es in AVA nicht. Deshalb wiegt es das
// Fuenffache und wirkt neunmal so lange nach.
//
// Die Zahlen sind bewusst fest verdrahtet und nicht einstellbar: Waeren
// sie es, justierte sie niemand, und jede Fehlersuche begaenne mit der
// Frage, was beim Nutzer eingestellt ist.

export interface SignalArt {
  /** Schluessel, wie er in der Datenbank landet. */
  key: string;
  ziel: "firma" | "person";
  punkte: number;
  /** Halbwertszeit in Tagen. 0 = verfaellt nie (nur fuer gesetzte Marken). */
  halbwertT: number;
  /** Fuer die Erklaerung in der Oberflaeche. */
  label: string;
}

const F = (key: string, punkte: number, halbwertT: number, label: string): SignalArt =>
  ({ key, ziel: "firma", punkte, halbwertT, label });
const P = (key: string, punkte: number, halbwertT: number, label: string): SignalArt =>
  ({ key, ziel: "person", punkte, halbwertT, label });

export const SIGNALE: SignalArt[] = [
  // ---- Firma --------------------------------------------------------------
  F("firma.ansicht", 3, 21, "Firma angesehen"),
  F("firma.verweildauer", 2, 21, "laenger in der Firmenansicht"),
  F("firma.chatlink", 3, 21, "Firmenlink im Chat geklickt"),
  F("firma.chat", 5, 30, "im Chat behandelt"),
  F("firma.uebernommen", 12, 120, "in Meine Firmen uebernommen"),
  F("firma.import", 10, 90, "Import gestartet"),
  F("firma.workflow", 14, 120, "in einem Workflow"),
  F("firma.watchlist", 18, 0, "auf der Watchlist"),
  F("firma.crm", 16, 120, "Kontakt ins CRM uebernommen"),
  F("firma.alarm.geoeffnet", 4, 30, "Alarm geoeffnet"),
  // Negativ, und erst ab dem dritten Mal derselben Art: Einmal wegwischen
  // heisst meist "gesehen, erledigt"; dreimal heisst "lass mich damit in
  // Ruhe". Ein System, das nur addiert, kann sich nicht korrigieren.
  F("firma.alarm.weggewischt", -3, 30, "Alarm wiederholt weggewischt"),

  // ---- Person -------------------------------------------------------------
  P("person.profil", 6, 60, "Profil geoeffnet"),
  P("person.hinweis", 14, 180, "DSGVO-Hinweis kopiert"),
  P("person.crm", 18, 180, "ins CRM uebernommen"),
  P("person.mail", 10, 90, "Mailentwurf begonnen"),
  P("person.gesucht", 4, 45, "ueber die Kontaktsuche geoeffnet"),
  P("person.chat", 8, 60, "im Chat behandelt"),
  P("person.watchlist", 18, 0, "auf der Personen-Watchlist"),
];

const NACH_KEY = new Map(SIGNALE.map((s) => [s.key, s]));

export function signalArt(key: string): SignalArt | null {
  return NACH_KEY.get(key) ?? null;
}

export function labelFuer(key: string): string {
  if (key === "wiederkehr") return "mehrfach zurueckgekommen";
  return NACH_KEY.get(key)?.label ?? key;
}

/**
 * Wie oft dieselbe Alarmart bei derselben Firma weggewischt sein muss,
 * bevor es zaehlt.
 */
export const WEGWISCHEN_AB = 3;

/** Eine Handlung zaehlt hoechstens einmal je Stunde und Ziel. */
export const ENTPRELLUNG_MS = 60 * 60_000;

/** Ab dieser Naehe gilt ein Ziel als warm (Alarmstufen, Aggregat). */
export const WARM_AB = 6;
