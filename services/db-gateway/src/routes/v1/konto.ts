// Konto loeschen / deaktivieren (docs/PLAN_KONTO_LOESCHEN.md, Joyce 2026-11-08).
// GET  /konto/loeschen      Pruefung (Organisationsregeln), ohne Wirkung
// POST /konto/loeschen      { bestaetigung: "LÖSCHEN" }      unumkehrbar, anonymisiert
// POST /konto/deaktivieren  { bestaetigung: "DEAKTIVIEREN" } nur wer allein in der Organisation ist
// POST /konten/status       { subs: [...] } → welche Konten geloescht/deaktiviert sind (Kontowechsler)
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { getGatewayPool } from "../../lib/producer-pools";
import { getMasterDataPool } from "../../lib/discovery";
import { geloeschteKonten, kontoDeaktivieren, kontoLoeschen, pruefen } from "../../lib/konto-loeschen";
import type { AuthContext } from "../../middleware/auth";
import { ErrorShape } from "./schemas";

export const kontoRouter = new OpenAPIHono();
const tag = "konto";
const Passthrough = z.object({}).passthrough();

function auth(c: { get: (k: "auth") => AuthContext }): AuthContext {
  const a = c.get("auth");
  if (!a?.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return a;
}

async function masterDataAnonymisieren(sub: string, anon: string): Promise<void> {
  // Benutzername ist eindeutig; die anonyme Adresse enthaelt die sub und ist es damit auch.
  await getMasterDataPool().query(`UPDATE "User" SET "email" = $2, "username" = $2 WHERE "userId" = $1`, [sub, anon]);
}

kontoRouter.openapi(
  createRoute({ method: "get", path: "/konto/loeschen", tags: [tag], summary: "Darf das Konto geloescht werden? (Organisationsregeln)", responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "Pruefung" } } }),
  async (c) => c.json(await pruefen(getGatewayPool(), auth(c).actorId), 200),
);

kontoRouter.openapi(
  createRoute({
    method: "post", path: "/konto/loeschen", tags: [tag], summary: "Konto unumkehrbar loeschen (anonymisieren)",
    request: { body: { content: { "application/json": { schema: z.object({ bestaetigung: z.literal("LÖSCHEN") }) } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: Passthrough } }, description: "geloescht" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "Bestaetigung fehlt" },
      409: { content: { "application/json": { schema: Passthrough } }, description: "Organisationsregel verhindert das Loeschen" },
    },
  }),
  async (c) => {
    const a = auth(c);
    const body = (await c.req.json().catch(() => null)) as { bestaetigung?: unknown } | null;
    if (body?.bestaetigung !== "LÖSCHEN") return c.json({ error: "invalid_input", message: "Bitte zur Bestätigung LÖSCHEN eingeben." }, 400);
    const r = await kontoLoeschen(getGatewayPool(), a, { masterDataAnonymisieren });
    if ("abgelehnt" in r) return c.json({ error: "nicht_moeglich", pruefung: r.abgelehnt }, 409);
    return c.json({ ok: true, ...r }, 200);
  },
);

kontoRouter.openapi(
  createRoute({
    method: "post", path: "/konto/deaktivieren", tags: [tag], summary: "Konto deaktivieren (nur allein in der Organisation)",
    request: { body: { content: { "application/json": { schema: z.object({ bestaetigung: z.literal("DEAKTIVIEREN") }) } }, required: true } },
    responses: {
      200: { content: { "application/json": { schema: Passthrough } }, description: "deaktiviert" },
      400: { content: { "application/json": { schema: ErrorShape } }, description: "Bestaetigung fehlt" },
      409: { content: { "application/json": { schema: Passthrough } }, description: "nicht der Fall allein in der Organisation" },
    },
  }),
  async (c) => {
    const a = auth(c);
    const body = (await c.req.json().catch(() => null)) as { bestaetigung?: unknown } | null;
    if (body?.bestaetigung !== "DEAKTIVIEREN") return c.json({ error: "invalid_input", message: "Bitte zur Bestätigung DEAKTIVIEREN eingeben." }, 400);
    const r = await kontoDeaktivieren(getGatewayPool(), a);
    if ("abgelehnt" in r) return c.json({ error: "nicht_moeglich", pruefung: r.abgelehnt }, 409);
    return c.json(r, 200);
  },
);

kontoRouter.openapi(
  createRoute({
    method: "post", path: "/konten/status", tags: [tag], summary: "Welche der Konten sind geloescht oder deaktiviert? (Kontowechsler)",
    request: { body: { content: { "application/json": { schema: z.object({ subs: z.array(z.string().max(64)).max(50) }) } }, required: true } },
    responses: { 200: { content: { "application/json": { schema: Passthrough } }, description: "entfernt: [sub]" } },
  }),
  async (c) => {
    auth(c);
    const body = (await c.req.json().catch(() => ({}))) as { subs?: unknown };
    const subs = Array.isArray(body.subs) ? body.subs.filter((s): s is string => typeof s === "string").slice(0, 50) : [];
    return c.json({ entfernt: await geloeschteKonten(getGatewayPool(), subs) }, 200);
  },
);
