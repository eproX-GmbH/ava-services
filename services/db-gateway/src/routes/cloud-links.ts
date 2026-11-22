// Öffentlicher Link aus der Mail „Ein Schritt fehlt noch“ (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z4):
//   GET /cloud/bestaetigen?t=…   signiert (Instanz + Ablauf, lib/cloud/anmeldung.ts)
// Leitet direkt auf die Gerätebestätigung des Anmeldedienstes weiter (Code schon eingetragen).
// Wer den Link weitergibt, verschenkt nichts: Die Instanz nimmt nur das gebundene Konto an.

import { Hono } from "hono";
import { getGatewayPool } from "../lib/producer-pools";
import { loadEnv } from "../lib/env";
import { bestaetigenTokenPruefen } from "../lib/cloud/anmeldung";
import { cloudBestaetigung } from "../lib/cloud/betrieb";
import { pgRepo } from "../lib/cloud/instanzen";
import { esc } from "../lib/mail/vorlagen";

export const cloudLinksRouter = new Hono();

function seite(titel: string, text: string, opt: { neuLadenSek?: number; app?: string } = {}): string {
  const neu = opt.neuLadenSek ? `<meta http-equiv="refresh" content="${opt.neuLadenSek}">` : "";
  const knopf = opt.app ? `<p><a class="k" href="${esc(opt.app)}">AVA öffnen</a></p>` : `<p><a href="https://www.ava.bi">Zu AVA</a></p>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer">${neu}<title>${esc(titel)}</title>
<style>body{margin:0;background:#F2F7F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0A1F2A}main{max-width:480px;margin:12vh auto;padding:32px 28px;background:#fff;border:1px solid #DCE7E5;border-radius:14px}h1{font-size:21px;margin:0 0 12px}p{font-size:15px;line-height:23px;margin:0 0 12px}a{color:#009C88;font-weight:600}a.k{display:inline-block;margin-top:8px;padding:11px 22px;border-radius:8px;background:#00C0A7;color:#fff;text-decoration:none}</style></head>
<body><main><h1>${esc(titel)}</h1><p>${esc(text)}</p>${knopf}</main></body></html>`;
}

cloudLinksRouter.get("/cloud/bestaetigen", async (c) => {
  c.header("cache-control", "no-store");
  c.header("referrer-policy", "no-referrer");
  const app = loadEnv().AVA_APP_URL;
  const id = bestaetigenTokenPruefen(c.req.query("t") ?? "");
  if (!id) return c.html(seite("Link abgelaufen", "Dieser Link ist nicht mehr gültig. Den aktuellen Knopf zum Bestätigen findest du in der AVA-App.", { app }), 404);
  const i = await pgRepo(getGatewayPool()).holen(id);
  if (!i || i.zustand === "geloescht") return c.html(seite("Nicht mehr vorhanden", "Diesen AVA-Server gibt es nicht mehr."), 404);
  if (i.zustand === "laeuft") return c.html(seite("Schon erledigt", "Deine AVA ist bereits bestätigt und arbeitet für dich.", { app }));
  if (i.zustand !== "wartet_auf_verbindung") {
    return c.html(seite("Gerade nicht möglich", i.zustand === "wird_angelegt" || i.zustand === "zahlung_offen" ? "Deine AVA wird noch eingerichtet. Diese Seite lädt sich gleich neu." : "Deine AVA ist gerade pausiert. Den Stand siehst du in der AVA-App.", { app, neuLadenSek: i.zustand === "wird_angelegt" ? 20 : undefined }));
  }
  const b = await cloudBestaetigung(i).catch(() => ({ angemeldet: false, bestaetigen: null }));
  if (b.angemeldet) return c.html(seite("Fertig!", "Deine AVA ist bestätigt und arbeitet ab jetzt für dich.", { app }));
  if (b.bestaetigen) return c.redirect(b.bestaetigen.link, 302);
  return c.html(seite("Einen Moment …", "Deine AVA bereitet die Bestätigung gerade vor. Diese Seite lädt sich gleich neu.", { neuLadenSek: 10 }));
});
