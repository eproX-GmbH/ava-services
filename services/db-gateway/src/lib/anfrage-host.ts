// Aufgerufener Host einer Anfrage, auch hinter der Staging-Weiche.
//
// Die Weiche im Prod-Gateway (staging-weiche.ts) reicht Anfragen von Staging-Konten an das
// Staging-Gateway weiter. Dort heißt der Host wie die Fly-App, nicht mehr mcp.ava.bi. Alles, was
// am aufgerufenen Host hängt (MCP und ChatGPT-Plugin auf mcp.ava.bi, OAuth-Metadata, Prüfung der
// Token-Audience, Agentenkarte), liest den Host deshalb hier. Befund 2026-11-26: ChatGPT bekam für
// Staging-Konten 404 („MCP SSE probe returned 404“), weil / und /chatgpt nur auf dem eigenen Host
// zum MCP-Endpunkt führen.
import { gatewayRolle } from "./kanal";

export const WEITERGELEITET = "x-ava-weitergeleitet";
/** Host, den der Client im Prod-Gateway aufgerufen hat (setzt nur die Weiche). */
export const URSPRUNGS_HOST = "x-ava-host";

type MitKopfzeilen = { req: { header(name: string): string | undefined } };

/**
 * Host-Kopfzeile, im Staging-Gateway bei weitergeleiteten Anfragen der ursprüngliche Host.
 * Prod liest die Kopfzeile nie: Dort könnte sie jeder Client setzen.
 */
export function anfrageHost(c: MitKopfzeilen): string | undefined {
  const host = c.req.header("host");
  if (gatewayRolle() !== "staging" || !c.req.header(WEITERGELEITET)) return host;
  return c.req.header(URSPRUNGS_HOST)?.trim() || host;
}
