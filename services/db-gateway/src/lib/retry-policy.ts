// Auto-Retry-Politik fuer EntityProgress (geteilt von persist-bus und event-bus).

/** Operator 2026-09-09: Nur voruebergehende Fehler (Zeitueberschreitung,
 *  Quelle nicht erreichbar, Rate-Limit, 5xx) werden automatisch
 *  wiederholt. Dauerhafte Fehler ("Kein Registereintrag gefunden",
 *  "Element nicht gefunden") bekommen sofort giveUpAt — der Nutzer kann
 *  manuell "Schritt erneut starten". Vorher lief z. B. ein Handelsregister-
 *  Scrape ohne Treffer fuenfmal je ~5 Minuten neu. SQL-Regex (case-
 *  insensitive), gespiegelt in event-bus.ts. */
export const RETRYABLE_ERROR_SQL_RE = "(zeitüberschreitung|zeitueberschreitung|nicht erreichbar|timeout|timed out|econnreset|etimedout|econnrefused|rate limit|\\m429\\M|\\m50[234]\\M|reagiert nicht)";
