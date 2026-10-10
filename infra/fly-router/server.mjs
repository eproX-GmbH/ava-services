// AVA-Router (docs/PLAN_AVA_CLOUD.md §14): verteilt <kunde>.ava.bi auf die
// Server-Instanz des Kunden. Er beantwortet jede Anfrage nur mit dem Kopf
// `fly-replay: app=<ziel>`; der Fly-Proxy spielt sie dann bei der Ziel-App ab.
// Kein Zustand, keine Abhängigkeiten.
//
//   <slug>.ROUTER_DOMAIN  →  ava-i-<slug>        (Namensregel der Bereitstellung)
//   ROUTER_ZUORDNUNG      →  Ausnahmen, z. B. "joyce=headless-ava,demo=ava-i-demo-alt"
//
// Ob die Ziel-App existiert und läuft, prüft der Router über das private
// Fly-DNS (<app>.internal); unbekannte Namen bekommen eine 404-Seite statt
// eines Proxy-Fehlers.

import { createServer } from "node:http";
import { promises as dns } from "node:dns";

const DOMAIN = (process.env.ROUTER_DOMAIN || "ava.bi").toLowerCase();
const PREFIX = process.env.ROUTER_APP_PREFIX || "ava-i-";
const PORT = Number(process.env.PORT || 8080);
const ZUORDNUNG = new Map(
  (process.env.ROUTER_ZUORDNUNG || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split("=").map((x) => x.trim().toLowerCase())),
);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

// Ergebnis der DNS-Prüfung je App: positiv 60 s, negativ 15 s (frisch angelegte Instanzen).
const cache = new Map();
async function appLaeuft(app) {
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

function zielApp(host) {
  const h = (host || "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  if (!h.endsWith(`.${DOMAIN}`)) return null;
  const sub = h.slice(0, -(DOMAIN.length + 1));
  if (!SLUG.test(sub)) return null;
  return ZUORDNUNG.get(sub) ?? `${PREFIX}${sub}`;
}

const seite = (titel, text) =>
  `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titel}</title>` +
  `<style>body{font:16px/1.5 system-ui,sans-serif;background:#F2F7F6;color:#0A1F2A;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px}` +
  `main{max-width:32rem}h1{font-size:1.4rem;margin:0 0 .5rem}a{color:#00897a}</style></head><body><main><h1>${titel}</h1><p>${text}</p></main></body></html>`;

createServer(async (req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  // Wiedergespielte Anfrage, die das Ziel nicht annehmen konnte: nicht im Kreis schicken.
  if (req.headers["fly-replay-failed"] || req.headers["fly-replay-src"]) {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8" }).end(seite("AVA startet gerade", "Diese AVA ist gerade nicht erreichbar. Bitte in einer Minute erneut versuchen."));
    return;
  }
  const app = zielApp(req.headers.host);
  if (!app || !(await appLaeuft(app))) {
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(seite("Keine AVA unter dieser Adresse", `Unter dieser Adresse läuft keine AVA. Zur Startseite: <a href="https://${DOMAIN}">${DOMAIN}</a>.`));
    return;
  }
  res.writeHead(204, { "fly-replay": `app=${app}` }).end();
}).listen(PORT, "::", () => console.log(`[router] ${DOMAIN} → ${PREFIX}<slug> auf :${PORT}; Ausnahmen: ${[...ZUORDNUNG].map(([k, v]) => `${k}=${v}`).join(", ") || "keine"}`));
