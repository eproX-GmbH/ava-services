// v0.1.580 — Apify-Zugang: eigener Token ODER Organisationsschluessel.
//
// Bis v0.1.579 nutzten Watchlist und Personen-Radar im Hauptprozess nur
// den lokal hinterlegten Apify-Token; der Organisationsschluessel (O5)
// galt nur fuer den company-contact-Producer. Jetzt gibt es EINE
// Zugangsbeschreibung fuer alle Apify-Aufrufe im Hauptprozess:
//   * eigen:        direkt gegen api.apify.com mit `?token=` (wie bisher)
//   * organisation: ueber den Stellvertreter-Proxy des Gateways
//                   (`/v1/proxy/apify/v2/...`) mit dem Nutzer-JWT; das
//                   Gateway setzt den Apify-Token der Organisation ein,
//                   der Schluessel verlaesst das Gateway nie.

export const APIFY_API = "https://api.apify.com/v2";

export interface ApifyAccess {
  quelle: "eigen" | "organisation";
  /** Basis inkl. `/v2`. */
  base: string;
  /** Nur bei `eigen`: Apify-Token fuer `?token=`. */
  token: string | null;
  /** Zusaetzliche Header (bei `organisation`: Bearer-JWT fuers Gateway). */
  headers: Record<string, string>;
}

export function eigenerApifyZugang(token: string): ApifyAccess {
  return { quelle: "eigen", base: APIFY_API, token, headers: {} };
}

export function organisationsApifyZugang(gatewayUrl: string, jwt: string): ApifyAccess {
  return {
    quelle: "organisation",
    base: `${gatewayUrl.replace(/\/+$/, "")}/v1/proxy/apify/v2`,
    token: null,
    headers: { authorization: `Bearer ${jwt}` },
  };
}

/** Volle URL fuer einen Apify-Pfad (mit `?`-Query); haengt bei `eigen` den Token an. */
export function apifyUrl(access: ApifyAccess, pathAndQuery: string): string {
  const url = `${access.base}${pathAndQuery.startsWith("/") ? "" : "/"}${pathAndQuery}`;
  if (access.quelle !== "eigen" || !access.token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(access.token)}`;
}

export function apifyHeaders(access: ApifyAccess, extra?: Record<string, string>): Record<string, string> {
  return { ...access.headers, ...(extra ?? {}) };
}

export function apifyQuellenText(access: ApifyAccess | null): string {
  if (!access) return "kein Apify-Zugang";
  return access.quelle === "organisation" ? "Apify ueber Organisationsschluessel" : "eigener Apify-Token";
}
