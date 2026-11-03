// Gateway-Token der Producer je Anfrage frisch (Befund Patrick 2026-11-03).
//
// Der ProducerSupervisor legt beim Start ein Keycloak-Access-Token (15 Min)
// als PRODUCER_GATEWAY_TOKEN in die Umgebung. Ein Lauf des Publikations-
// Producers dauert mit lokaler Einbettung aber leicht laenger: danach
// antwortete jeder Gateway-Aufruf (Betreiber-Spur, Vorpruefung, Proxy) mit
// 401, der Desktop startete den Producer neu, AMQP lieferte die Nachricht
// erneut, und der Lauf begann von vorn — eine Schleife, die den Rechner
// dauerhaft auslastete.
//
// Loesung wie beim ChatGPT-Abo: der Desktop bietet auf 127.0.0.1 einen
// Endpunkt (PRODUCER_GATEWAY_TOKEN_URL + PRODUCER_GATEWAY_TOKEN_SECRET), der
// ein garantiert gueltiges Token liefert. Dieser Helfer holt es alle paar
// Minuten und schreibt es in process.env.PRODUCER_GATEWAY_TOKEN, damit ALLE
// Stellen, die das Token bei jedem Aufruf aus der Umgebung lesen, ohne
// Aenderung frisch bleiben. Clients, die das Token beim Bau einfrieren
// (OpenAI-SDK-Header), bekommen `makeGatewayFetch`, das den Bearer je
// Anfrage neu setzt.

const AUFFRISCHUNG_MS = 4 * 60_000;
const MIN_ABSTAND_MS = 30_000;

let timer: NodeJS.Timeout | null = null;
let zuletzt = 0;
let laufend: Promise<string | null> | null = null;

/** Desktop bietet den Token-Dienst an? */
export function gatewayTokenDienstAktiv(): boolean {
  return Boolean(process.env.PRODUCER_GATEWAY_TOKEN_URL && process.env.PRODUCER_GATEWAY_TOKEN_SECRET);
}

/** Frisches Token vom Desktop holen und in die Umgebung schreiben; bei Fehlern bleibt das alte. */
export async function gatewayTokenHolen(baseFetch: typeof fetch = globalThis.fetch): Promise<string | null> {
  const url = process.env.PRODUCER_GATEWAY_TOKEN_URL;
  const secret = process.env.PRODUCER_GATEWAY_TOKEN_SECRET;
  if (!url || !secret) return process.env.PRODUCER_GATEWAY_TOKEN ?? null;
  if (laufend) return laufend;
  laufend = (async () => {
    try {
      const res = await baseFetch(url, { headers: { "x-ava-plan-secret": secret, accept: "application/json" }, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return process.env.PRODUCER_GATEWAY_TOKEN ?? null;
      const json = (await res.json()) as { accessToken?: unknown };
      if (typeof json.accessToken === "string" && json.accessToken.length > 0) {
        process.env.PRODUCER_GATEWAY_TOKEN = json.accessToken;
        zuletzt = Date.now();
      }
      return process.env.PRODUCER_GATEWAY_TOKEN ?? null;
    } catch {
      return process.env.PRODUCER_GATEWAY_TOKEN ?? null;
    } finally {
      laufend = null;
    }
  })();
  return laufend;
}

/** Token aus der Umgebung, vorher aufgefrischt, wenn die letzte Abholung laenger her ist. */
export async function gatewayTokenAktuell(): Promise<string | null> {
  if (gatewayTokenDienstAktiv() && Date.now() - zuletzt > AUFFRISCHUNG_MS - MIN_ABSTAND_MS) await gatewayTokenHolen();
  return process.env.PRODUCER_GATEWAY_TOKEN ?? null;
}

/**
 * Periodische Auffrischung starten (idempotent). Der Timer haelt den
 * Prozess nicht am Leben. Ohne Token-Dienst in der Umgebung passiert nichts.
 */
export function startGatewayTokenAuffrischung(log?: (m: string) => void): void {
  if (timer || !gatewayTokenDienstAktiv()) return;
  void gatewayTokenHolen().then((t) => log?.(`[gateway-token] Auffrischung aktiv (${t ? "Token erhalten" : "kein Token"})`));
  timer = setInterval(() => {
    void gatewayTokenHolen();
  }, AUFFRISCHUNG_MS);
  timer.unref?.();
}

export function stopGatewayTokenAuffrischung(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

function urlVon(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

/** fetch, das den Bearer je Anfrage aus der (aufgefrischten) Umgebung setzt. */
export function makeGatewayFetch(baseFetch: typeof fetch = globalThis.fetch): typeof fetch {
  const f = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const token = await gatewayTokenAktuell();
    const headers = new Headers(init?.headers ?? (typeof input !== "string" && !(input instanceof URL) ? input.headers : undefined));
    if (token) headers.set("authorization", `Bearer ${token}`);
    return baseFetch(urlVon(input), { ...init, headers });
  };
  return f as typeof fetch;
}
