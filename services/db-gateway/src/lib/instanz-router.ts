// Kunden-Instanzen unter <slug>.ava.bi (docs/PLAN_AVA_CLOUD.md §14). Der Gateway
// beantwortet Anfragen an solche Adressen nur mit `fly-replay: app=<ziel>`; der
// Fly-Proxy spielt sie dann bei der Server-Instanz des Kunden ab. Ersetzt die
// eigene App ava-router (Kosten). Eigene Namen des Gateways (mcp, api, …) und
// alles außerhalb von ROUTER_DOMAIN laufen normal weiter.
//
//   <slug>.ROUTER_DOMAIN  →  ava-i-<slug>      (Namensregel der Bereitstellung)
//   ROUTER_ZUORDNUNG      →  Ausnahmen, z. B. "headless-ava=headless-ava"

import { promises as dns } from "node:dns";
import type { MiddlewareHandler } from "hono";

const DOMAIN = (process.env.ROUTER_DOMAIN || "ava.bi").toLowerCase();
const PREFIX = process.env.ROUTER_APP_PREFIX || "ava-i-";
const ZUORDNUNG = new Map(
  (process.env.ROUTER_ZUORDNUNG || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("=").map((x) => x.trim().toLowerCase()) as [string, string]),
);
/** Subdomains, die nie an eine Instanz gehen (wie RESERVIERT in scripts/lib/instanz-fly.mjs). */
const EIGENE = new Set(["www", "mcp", "api", "app", "auth", "login", "sso", "admin", "gateway", "mail", "status", "docs", "hilfe", "support", "router", "setup", "cloud", "server", "desktop", "test", "staging", "dev"]);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Läuft die Ziel-App? Privates Fly-DNS; positiv 60 s, negativ 15 s gemerkt.
const cache = new Map<string, { ok: boolean; bis: number }>();
async function appLaeuft(app: string): Promise<boolean> {
  const c = cache.get(app);
  if (c && c.bis > Date.now()) return c.ok;
  let ok = false;
  try {
    ok = (await dns.resolve6(`${app}.internal`)).length > 0;
  } catch {
    ok = false;
  }
  cache.set(app, { ok, bis: Date.now() + (ok ? 60_000 : 15_000) });
  return ok;
}

export function zielApp(host: string | undefined | null): string | null {
  const h = (host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h.endsWith(`.${DOMAIN}`)) return null;
  const sub = h.slice(0, -(DOMAIN.length + 1));
  if (!SLUG.test(sub) || EIGENE.has(sub)) return null;
  return ZUORDNUNG.get(sub) ?? `${PREFIX}${sub}`;
}

const seite = (titel: string, text: string) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titel}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;background:#F2F7F6;color:#0A1F2A;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}` +
  `main{max-width:32rem}h1{font-size:1.4rem;margin:0 0 .5rem}a{color:#00897a}</style></head><body><main><h1>${titel}</h1><p>${text}</p></main></body></html>`;

export const instanzRouter: MiddlewareHandler = async (c, next) => {
  const app = zielApp(c.req.header("host"));
  if (!app) return next();
  // Konnte das Ziel die wiedergespielte Anfrage nicht annehmen, nicht im Kreis schicken.
  if (c.req.header("fly-replay-failed")) {
    return c.html(seite("AVA startet gerade", "Diese AVA ist gerade nicht erreichbar. Bitte in einer Minute erneut versuchen."), 503);
  }
  if (!(await appLaeuft(app))) {
    return c.html(seite("Keine AVA unter dieser Adresse", `Unter dieser Adresse läuft keine AVA. Zur Startseite: <a href="https://${DOMAIN}">${DOMAIN}</a>.`), 404);
  }
  c.header("fly-replay", `app=${app}`);
  return c.body(null, 204);
};
