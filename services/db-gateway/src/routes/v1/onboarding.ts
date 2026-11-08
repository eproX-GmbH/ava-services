// Onboarding O1/O2 (docs/PLAN_ONBOARDING.md): Start-Analyse und EINMALIGE Abholung.
// POST /onboarding/start          Auftrag anlegen (Website-Registrierung ruft das mit dem frischen Token)
// GET  /onboarding/start          Stand fuer die App (ohne Vorschlag)
// POST /onboarding/start/website  Website nachreichen (Freemail, fehlgeschlagen)
// POST /onboarding/start/abholen  einmalige Uebergabe des ICP-Vorschlags an die App
// POST /onboarding/mail/top10     Mail "Deine Top 10" nach dem Start-Workflow
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { abholen, auftragAnlegen, auftragLesen, websiteNachreichen } from "../../lib/start-analyse/auftrag";
import { domainZuordnen } from "../../lib/beitritt-domain";
import { ErrorShape } from "./schemas";
import { loadEnv } from "../../lib/env";
import { getProducerPool } from "../../lib/producer-pools";
import { linkAdressen, mailKonto, mailKontoLesen, mailSenden } from "../../lib/mail/versand";
import { top10Mail } from "../../lib/mail/vorlagen";
import { assertTransactionOwnershipById } from "./transactions";

export const onboardingRouter = new OpenAPIHono();
const tag = "onboarding";
const Passthrough = z.object({}).passthrough();

function auth(c: { get: (k: "auth") => { actorId: string; email?: string | null; name?: string | null } }) {
  const a = c.get("auth");
  if (!a?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return a;
}

const WebsiteFeld = z.string().trim().max(300).regex(/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i, "Keine gültige Website");

onboardingRouter.openapi(
  createRoute({
    method: "post", path: "/onboarding/start", tags: [tag], summary: "Start-Analyse fuer den angemeldeten Nutzer anlegen (idempotent)",
    request: { body: { content: { "application/json": { schema: z.object({ website: WebsiteFeld.optional() }) } }, required: false } },
    responses: { 202: { content: { "application/json": { schema: Passthrough } }, description: "angelegt oder schon vorhanden" } },
  }),
  async (c) => {
    const a = auth(c);
    const body = (await c.req.json().catch(() => ({}))) as { website?: unknown };
    const website = typeof body.website === "string" && WebsiteFeld.safeParse(body.website).success ? body.website : null;
    await auftragAnlegen(getGatewayPool(), { actorId: a.actorId, email: a.email ?? null, vorname: a.name ?? null, website });
    // O11 (Website-Registrierung): Organisation der eigenen Firma als offene Anfrage.
    await domainZuordnen(getGatewayPool(), { actorId: a.actorId, email: a.email ?? null, name: a.name ?? null }).catch(() => undefined);
    return c.json({ ok: true, stand: await auftragLesen(getGatewayPool(), a.actorId) }, 202);
  },
);

onboardingRouter.openapi(
  createRoute({
    method: "get", path: "/onboarding/start", tags: [tag], summary: "Stand der Start-Analyse (ohne Vorschlag)",
    responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "Stand oder null" } },
  }),
  async (c) => {
    const a = auth(c);
    return c.json({ stand: await auftragLesen(getGatewayPool(), a.actorId) }, 200);
  },
);

onboardingRouter.openapi(
  createRoute({
    method: "post", path: "/onboarding/start/website", tags: [tag], summary: "Website nachreichen (nur solange nichts abgeholt ist)",
    request: { body: { content: { "application/json": { schema: z.object({ website: WebsiteFeld }) } }, required: true } },
    responses: {
      202: { content: { "application/json": { schema: Passthrough } }, description: "Analyse laeuft" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" },
      409: { content: { "application/json": { schema: ErrorShape } }, description: "schon abgeholt oder laeuft bereits" },
    },
  }),
  async (c) => {
    const a = auth(c);
    const body = (await c.req.json().catch(() => ({}))) as { website?: unknown };
    const p = WebsiteFeld.safeParse(body.website);
    if (!p.success) return c.json({ error: "invalid_input", message: "Keine gültige Website." }, 400);
    const ok = await websiteNachreichen(getGatewayPool(), a.actorId, p.data);
    if (!ok) return c.json({ error: "conflict", message: "Die Analyse läuft schon oder wurde bereits übernommen." }, 409);
    return c.json({ ok: true, stand: await auftragLesen(getGatewayPool(), a.actorId) }, 202);
  },
);

onboardingRouter.openapi(
  createRoute({
    method: "post", path: "/onboarding/start/abholen", tags: [tag],
    summary: "EINMALIG: ICP-Vorschlag abholen (lokalLeer=true) oder verwerfen (lokalLeer=false). Jeder spaetere Aufruf: schon_abgeholt",
    request: { body: { content: { "application/json": { schema: z.object({ instanz: z.string().min(1).max(120), lokalLeer: z.boolean() }) } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: Passthrough } }, description: "art: vorschlag | verworfen | schon_abgeholt | nicht_fertig" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" },
    },
  }),
  async (c) => {
    const a = auth(c);
    const body = (await c.req.json().catch(() => null)) as { instanz?: unknown; lokalLeer?: unknown } | null;
    if (!body || typeof body.instanz !== "string" || !body.instanz.trim() || typeof body.lokalLeer !== "boolean") {
      return c.json({ error: "invalid_input", message: "instanz und lokalLeer sind Pflicht." }, 400);
    }
    return c.json(await abholen(getGatewayPool(), a.actorId, { instanz: body.instanz.trim(), lokalLeer: body.lokalLeer }), 200);
  },
);

// O5: "Deine Top 10" nach dem Start-Workflow (Import fertig). Die App schickt den
// Vorgang und die Radar-Gruende; die Firmen-IDs kommen aus dem Vorgang, damit jeder
// Name in der Mail auf die Firmenseite der Web-App zeigt. Genau einmal je Konto.
const Top10Body = z.object({
  transactionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  firmen: z.array(z.object({ name: z.string().max(300), ort: z.string().max(200).nullable(), branche: z.string().max(200).nullable(), score: z.number().min(0).max(100), grund: z.string().max(600) })).max(10),
});

function nameSchluessel(s: string): string {
  return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .replace(/\b(gmbh|ag|kg|se|ug|ohg|mbh|co|haftungsbeschraenkt|e\.?\s?k|ltd|sa|sarl)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

onboardingRouter.openapi(
  createRoute({
    method: "post", path: "/onboarding/mail/top10", tags: [tag], summary: "Mail \"Deine Top 10\" (einmalig, nur mit Zustimmung)",
    request: { body: { content: { "application/json": { schema: Top10Body } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: Passthrough } }, description: "gesendet oder uebersprungen (mit Grund)" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "ungueltig" },
    },
  }),
  async (c) => {
    const a = auth(c);
    const p = Top10Body.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "invalid_input", message: "transactionId und firmen erwartet." }, 400);
    const pool = getGatewayPool();
    const schon = await pool.query(`SELECT 1 FROM "MailVersand" WHERE "actorId" = $1 AND "art" = 'top10' AND "status" = 'gesendet' LIMIT 1`, [a.actorId]);
    if (schon.rows.length > 0) return c.json({ gesendet: false, grund: "schon gesendet" }, 200);
    await assertTransactionOwnershipById(c as never, p.data.transactionId);
    const ids = (await pool.query<{ companyId: string }>(`SELECT DISTINCT "companyId" FROM "EntityProgress" WHERE "transactionId" = $1 LIMIT 50`, [p.data.transactionId])).rows.map((r) => r.companyId);
    const namen = ids.length
      ? (await getProducerPool("company-contact").query<{ id: string; name: string | null }>(`SELECT "id", "name" FROM "Company" WHERE "id" = ANY($1::text[])`, [ids]).catch(() => ({ rows: [] as Array<{ id: string; name: string | null }> }))).rows
      : [];
    const nachName = new Map(namen.filter((n) => n.name).map((n) => [nameSchluessel(n.name!), n.id]));
    const firmen = p.data.firmen.map((f) => {
      const k = nameSchluessel(f.name);
      const id = nachName.get(k) ?? [...nachName.entries()].find(([n]) => n.length >= 4 && (n.includes(k) || k.includes(n)))?.[1] ?? null;
      return { ...f, companyId: id };
    });
    const email = a.email ?? (await mailKontoLesen(pool, a.actorId))?.email ?? null;
    if (!email) return c.json({ gesendet: false, grund: "keine Adresse" }, 200);
    const konto = await mailKonto(pool, { actorId: a.actorId, email, vorname: a.name ?? null });
    const env = loadEnv();
    const erg = await mailSenden(pool, konto, "top10", top10Mail({ vorname: konto.vorname, firmen, appBasis: env.AVA_APP_URL, abmeldenUrl: linkAdressen(konto.token).abmelden }));
    return c.json({ gesendet: erg.ok, ...(erg.grund ? { grund: erg.grund } : {}), verlinkt: firmen.filter((f) => f.companyId).length }, 200);
  },
);
