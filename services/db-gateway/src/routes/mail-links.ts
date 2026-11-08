// Onboarding O5 (docs/PLAN_ONBOARDING.md): oeffentliche Links aus den Mails.
// GET /mail/bestaetigen?t=…  Neuigkeiten per E-Mail einschalten (Double-Opt-in)
// GET|POST /mail/abmelden?t=…  keine Mails mehr (POST = One-Click aus dem Mailprogramm)
import { Hono } from "hono";
import { getGatewayPool } from "../lib/producer-pools";
import { abmelden, bestaetigen } from "../lib/mail/versand";

export const mailLinksRouter = new Hono();

function seite(titel: string, text: string): string {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titel}</title>
<style>body{margin:0;background:#F2F7F6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0A1F2A}main{max-width:480px;margin:12vh auto;padding:32px 28px;background:#fff;border:1px solid #DCE7E5;border-radius:14px}h1{font-size:21px;margin:0 0 12px}p{font-size:15px;line-height:23px;margin:0 0 12px}a{color:#009C88;font-weight:600}</style></head>
<body><main><h1>${titel}</h1><p>${text}</p><p><a href="https://www.ava.bi">Zu AVA</a></p></main></body></html>`;
}

const gueltig = (t: string | undefined) => !!t && /^[a-f0-9]{48}$/.test(t);

mailLinksRouter.get("/mail/bestaetigen", async (c) => {
  const t = c.req.query("t");
  if (!gueltig(t) || !(await bestaetigen(getGatewayPool(), t!))) return c.html(seite("Link ungültig", "Dieser Link ist nicht mehr gültig."), 404);
  return c.html(seite("Alles klar!", "Ab jetzt schicke ich dir Neuigkeiten zu deinen Firmen per E-Mail, höchstens einmal am Tag. Abmelden kannst du dich in jeder Mail."));
});

const abmeldenHandler = async (c: import("hono").Context) => {
  const t = c.req.query("t");
  if (!gueltig(t) || !(await abmelden(getGatewayPool(), t!))) return c.html(seite("Link ungültig", "Dieser Link ist nicht mehr gültig."), 404);
  return c.html(seite("Abgemeldet", "Du bekommst keine Mails mehr von AVA. Deine AVA-App funktioniert wie gewohnt weiter."));
};
mailLinksRouter.get("/mail/abmelden", abmeldenHandler);
mailLinksRouter.post("/mail/abmelden", abmeldenHandler);
