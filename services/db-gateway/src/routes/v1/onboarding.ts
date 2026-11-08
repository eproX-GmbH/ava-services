// Onboarding O1/O2 (docs/PLAN_ONBOARDING.md): Start-Analyse und EINMALIGE Abholung.
// POST /onboarding/start          Auftrag anlegen (Website-Registrierung ruft das mit dem frischen Token)
// GET  /onboarding/start          Stand fuer die App (ohne Vorschlag)
// POST /onboarding/start/website  Website nachreichen (Freemail, fehlgeschlagen)
// POST /onboarding/start/abholen  einmalige Uebergabe des ICP-Vorschlags an die App
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { abholen, auftragAnlegen, auftragLesen, websiteNachreichen } from "../../lib/start-analyse/auftrag";
import { ErrorShape } from "./schemas";

export const onboardingRouter = new OpenAPIHono();
const tag = "onboarding";
const Passthrough = z.object({}).passthrough();

function auth(c: { get: (k: "auth") => { actorId: string; email?: string | null } }) {
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
    await auftragAnlegen(getGatewayPool(), { actorId: a.actorId, email: a.email ?? null, website });
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
