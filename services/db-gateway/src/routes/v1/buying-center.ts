// Buying Center / Power Map (docs/PLAN_BUYING_CENTER.md, BC0).
//
//   POST   /buying-center                       anlegen (+ Fokuskunde, Entwurf)
//   GET    /buying-center?companyId=            eigene zu einer Firma (oder alle)
//   GET    /buying-center/{id}                  lesen (Eigentuemer oder Freigabe)
//   POST   /buying-center/{id}/mitglieder       Person aufnehmen
//   POST   /buying-center/{id}/mitglieder/{mid}/angaben   Dimension setzen, mit Grund
//   PUT    /buying-center/{id}/positionen       x/y nach dem Verschieben
//   POST   /buying-center/{id}/kanten           Einfluss / Vertraut / Animositaet
//   DELETE /buying-center/{id}/kanten/{kid}
//   POST   /buying-center/{id}/status           abschliessen / archivieren / aktiv
//   GET    /buying-center/{id}/vorschlaege      offene Vorschlaege + Leitfragen
//
// Zugriffsregel, HIER erzwungen und nirgends sonst:
//   lesen      Eigentuemer ODER Freigabe fuer mich
//   schreiben  nur Eigentuemer
// tenantId und actorId kommen aus dem JWT. Es gibt keinen Parameter, ueber
// den sich ein anderer Eigentuemer adressieren liesse.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";
import {
  ROLLEN, EINSTELLUNGEN, KONTAKTE, EINFLUESSE, KANTEN_ARTEN,
  vorschlaegeAusTitel, unbesetzteRollen, ohneKontakt,
} from "../../lib/buying-center-vorschlag";

export const buyingCenterRouter = new OpenAPIHono();
buyingCenterRouter.use("*", requireScope("company:read"));

const tag = "buying-center";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "nicht der Eigentuemer" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "conflict" },
};

/** Deckel je Nutzer: Fokuskunden sollen wenige sein — das ist ihr Zweck. */
const FOKUS_DECKEL = 25;

function auth(c: { get: (k: "auth") => unknown }): { tenantId: string; actorId: string } {
  const a = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  if (!a?.tenantId || !a.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return { tenantId: a.tenantId, actorId: a.actorId };
}

function cuid(): string {
  // Gleiche Form wie Prisma-cuid, ohne Prisma-Client: Zeit + Zufall.
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// ---- Zugriff ---------------------------------------------------------------

interface BcKopf {
  id: string; tenantId: string; eigentuemerActorId: string; companyId: string;
  anlass: string; status: string; angelegtAt: Date; updatedAt: Date;
}

/** Laedt den Kopf und prueft: Eigentuemer, oder (bei lesend) Freigabe. */
async function ladeMitZugriff(id: string, wer: { tenantId: string; actorId: string }, schreibend: boolean): Promise<BcKopf & { eigenes: boolean }> {
  const pool = getGatewayPool();
  const r = await pool.query<BcKopf>(`SELECT * FROM "BuyingCenter" WHERE "id" = $1 AND "tenantId" = $2`, [id, wer.tenantId]);
  const bc = r.rows[0];
  if (!bc) throw new HTTPException(404, { message: "buying_center_not_found" });
  const eigenes = bc.eigentuemerActorId === wer.actorId;
  if (eigenes) return { ...bc, eigenes: true };
  if (schreibend) {
    throw new HTTPException(403, { message: "Dieses Buying Center gehoert jemand anderem. Aendern kann es nur der Eigentuemer." });
  }
  const f = await pool.query(`SELECT 1 FROM "BuyingCenterFreigabe" WHERE "buyingCenterId" = $1 AND "actorId" = $2`, [id, wer.actorId]);
  if (f.rowCount === 0) throw new HTTPException(404, { message: "buying_center_not_found" });
  return { ...bc, eigenes: false };
}

// ---- Formen ----------------------------------------------------------------

const AngabeShape = z.object({
  id: z.string(), dimension: z.string(), wert: z.string().nullable(), herkunft: z.string(),
  grund: z.string(), vonActorId: z.string().nullable(), entschieden: z.string().nullable(), erfasstAt: z.string(),
});
const MitgliedShape = z.object({
  id: z.string(), personId: z.string().nullable(), name: z.string(), funktion: z.string().nullable(),
  rollen: z.array(z.string()), einstellung: z.string().nullable(), kontakt: z.string().nullable(),
  einfluss: z.string().nullable(), ansprechpartnerBeiUns: z.string().nullable(),
  x: z.number().nullable(), y: z.number().nullable(), angaben: z.array(AngabeShape),
});
const KanteShape = z.object({
  id: z.string(), vonMitgliedId: z.string(), nachMitgliedId: z.string(), art: z.string(),
  staerke: z.string().nullable(), grund: z.string().nullable(), herkunft: z.string(), erfasstAt: z.string(),
});
const BuyingCenterShape = z.object({
  id: z.string(), companyId: z.string(), anlass: z.string(), status: z.string(),
  eigenes: z.boolean(), eigentuemerActorId: z.string(),
  angelegtAt: z.string(), updatedAt: z.string(),
  mitglieder: z.array(MitgliedShape), kanten: z.array(KanteShape),
});

async function ladeVoll(bc: BcKopf & { eigenes: boolean }): Promise<z.infer<typeof BuyingCenterShape>> {
  const pool = getGatewayPool();
  const m = await pool.query(`SELECT * FROM "BuyingCenterMitglied" WHERE "buyingCenterId" = $1 ORDER BY "angelegtAt"`, [bc.id]);
  const ids = m.rows.map((r: Record<string, unknown>) => r.id as string);
  const a = ids.length
    ? await pool.query(`SELECT * FROM "BuyingCenterAngabe" WHERE "mitgliedId" = ANY($1::text[]) ORDER BY "erfasstAt" DESC`, [ids])
    : { rows: [] as Record<string, unknown>[] };
  const k = await pool.query(`SELECT * FROM "BuyingCenterKante" WHERE "buyingCenterId" = $1 ORDER BY "erfasstAt"`, [bc.id]);
  const angabenJe = new Map<string, z.infer<typeof AngabeShape>[]>();
  for (const r of a.rows as Record<string, unknown>[]) {
    const liste = angabenJe.get(r.mitgliedId as string) ?? [];
    liste.push({
      id: String(r.id), dimension: String(r.dimension), wert: (r.wert as string | null) ?? null,
      herkunft: String(r.herkunft), grund: String(r.grund), vonActorId: (r.vonActorId as string | null) ?? null,
      entschieden: (r.entschieden as string | null) ?? null, erfasstAt: new Date(r.erfasstAt as string).toISOString(),
    });
    angabenJe.set(r.mitgliedId as string, liste);
  }
  return {
    id: bc.id, companyId: bc.companyId, anlass: bc.anlass, status: bc.status, eigenes: bc.eigenes,
    eigentuemerActorId: bc.eigentuemerActorId,
    angelegtAt: bc.angelegtAt.toISOString(), updatedAt: bc.updatedAt.toISOString(),
    mitglieder: (m.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), personId: (r.personId as string | null) ?? null, name: String(r.name),
      funktion: (r.funktion as string | null) ?? null, rollen: (r.rollen as string[]) ?? [],
      einstellung: (r.einstellung as string | null) ?? null, kontakt: (r.kontakt as string | null) ?? null,
      einfluss: (r.einfluss as string | null) ?? null, ansprechpartnerBeiUns: (r.ansprechpartnerBeiUns as string | null) ?? null,
      x: (r.x as number | null) ?? null, y: (r.y as number | null) ?? null,
      angaben: angabenJe.get(r.id as string) ?? [],
    })),
    kanten: (k.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), vonMitgliedId: String(r.vonMitgliedId), nachMitgliedId: String(r.nachMitgliedId),
      art: String(r.art), staerke: (r.staerke as string | null) ?? null, grund: (r.grund as string | null) ?? null,
      herkunft: String(r.herkunft), erfasstAt: new Date(r.erfasstAt as string).toISOString(),
    })),
  };
}

// ---- Angabe setzen: der eine Weg, auf dem eine Dimension sich aendert -------

const DIMENSIONEN = ["rolle", "einstellung", "kontakt", "einfluss", "ansprechpartner", "notiz"] as const;

function pruefeWert(dimension: string, wert: string | null): void {
  if (wert === null || wert === "") return;
  const ok =
    (dimension === "rolle" && (ROLLEN as readonly string[]).includes(wert)) ||
    (dimension === "einstellung" && (EINSTELLUNGEN as readonly string[]).includes(wert)) ||
    (dimension === "kontakt" && (KONTAKTE as readonly string[]).includes(wert)) ||
    (dimension === "einfluss" && (EINFLUESSE as readonly string[]).includes(wert)) ||
    dimension === "ansprechpartner" || dimension === "notiz";
  if (!ok) throw new HTTPException(400, { message: `Unbekannter Wert "${wert}" fuer ${dimension}.` });
}

/**
 * Schreibt eine Angabe in die Belegkette und zieht — nur bei Herkunft
 * "nutzer" oder bei angenommenem Vorschlag — den aktuellen Stand nach.
 *
 * Rollen sind eine Menge: "rolle" mit wert "B" fuegt hinzu, mit wert
 * "-B" nimmt weg. Alle anderen Dimensionen sind Einzelwerte; null loescht.
 */
async function angabeSetzen(p: {
  mitgliedId: string; dimension: string; wert: string | null; herkunft: string; grund: string;
  vonActorId: string | null; uebernehmen: boolean;
}): Promise<void> {
  const pool = getGatewayPool();
  const roh = p.wert;
  const entfernen = p.dimension === "rolle" && roh?.startsWith("-");
  const wert = entfernen ? roh!.slice(1) : roh;
  pruefeWert(p.dimension, wert ?? null);

  await pool.query(
    `INSERT INTO "BuyingCenterAngabe" ("id","mitgliedId","dimension","wert","herkunft","grund","vonActorId","entschieden")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [cuid(), p.mitgliedId, p.dimension, roh, p.herkunft, p.grund, p.vonActorId, p.uebernehmen && p.herkunft !== "nutzer" ? "angenommen" : null],
  );
  if (!p.uebernehmen) return;

  if (p.dimension === "rolle") {
    if (!wert) return;
    await pool.query(
      entfernen
        ? `UPDATE "BuyingCenterMitglied" SET "rollen" = array_remove("rollen", $2), "updatedAt" = NOW() WHERE "id" = $1`
        : `UPDATE "BuyingCenterMitglied" SET "rollen" = (SELECT array_agg(DISTINCT r) FROM unnest(array_append("rollen", $2)) r), "updatedAt" = NOW() WHERE "id" = $1`,
      [p.mitgliedId, wert],
    );
    return;
  }
  const spalte: Record<string, string> = {
    einstellung: "einstellung", kontakt: "kontakt", einfluss: "einfluss", ansprechpartner: "ansprechpartnerBeiUns",
  };
  const s = spalte[p.dimension];
  if (!s) return; // notiz: nur Belegkette
  await pool.query(`UPDATE "BuyingCenterMitglied" SET "${s}" = $2, "updatedAt" = NOW() WHERE "id" = $1`, [p.mitgliedId, wert || null]);
}

// ---- POST /buying-center ---------------------------------------------------

const anlegenRoute = createRoute({
  method: "post", path: "/buying-center", tags: [tag],
  summary: "Buying Center anlegen: Firma wird Fokuskunde, Entwurf aus dem Kontakt-Bestand",
  request: { body: { content: { "application/json": { schema: z.object({
    companyId: z.string().min(1).max(200),
    anlass: z.string().max(200).optional(),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: BuyingCenterShape } }, description: "angelegt oder vorhanden" }, ...errorResponses },
});

buyingCenterRouter.openapi(anlegenRoute, async (c) => {
  const wer = auth(c);
  const { companyId, anlass = "" } = c.req.valid("json");
  const pool = getGatewayPool();

  // Vorhandenes zurueckgeben statt zu verdoppeln.
  const vorhanden = await pool.query<BcKopf>(
    `SELECT * FROM "BuyingCenter" WHERE "tenantId" = $1 AND "eigentuemerActorId" = $2 AND "companyId" = $3 AND "anlass" = $4`,
    [wer.tenantId, wer.actorId, companyId, anlass],
  );
  if (vorhanden.rows[0]) return c.json(await ladeVoll({ ...vorhanden.rows[0], eigenes: true }), 200);

  // Deckel: Hinweis, kein hartes Nein — aber ab dem Deckel wird der neue
  // nicht mehr Fokuskunde (und damit ohne Mehraufwand).
  const fokusZahl = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "FokusKunde" WHERE "tenantId" = $1 AND "actorId" = $2`, [wer.tenantId, wer.actorId],
  );
  const fokusFrei = (fokusZahl.rows[0]?.n ?? 0) < FOKUS_DECKEL;

  const id = cuid();
  await pool.query(
    `INSERT INTO "BuyingCenter" ("id","tenantId","eigentuemerActorId","companyId","anlass","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())`,
    [id, wer.tenantId, wer.actorId, companyId, anlass],
  );
  if (fokusFrei) {
    await pool.query(
      `INSERT INTO "FokusKunde" ("tenantId","actorId","companyId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [wer.tenantId, wer.actorId, companyId],
    );
  }

  // Entwurf: Personen aus dem Kontakt-Bestand mit Titel-Vorschlaegen.
  // Hoechstens 25 — ein Buying Center mit achtzig Namen ist keins.
  const kontakte = getProducerPool("company-contact");
  const personen = await kontakte.query<{ personId: string; fullName: string; title: string | null }>(
    `SELECT DISTINCT ON (p.id) p.id AS "personId", p."fullName", e.title
       FROM "Employment" e JOIN "Person" p ON p.id = e."personId"
      WHERE e."companyId" = $1 AND (e."isCurrent" IS DISTINCT FROM false)
      ORDER BY p.id, e."lastSeen" DESC NULLS LAST
      LIMIT 25`,
    [companyId],
  );
  for (const p of personen.rows) {
    const mid = cuid();
    await pool.query(
      `INSERT INTO "BuyingCenterMitglied" ("id","buyingCenterId","personId","name","funktion","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())`,
      [mid, id, p.personId, p.fullName, p.title],
    );
    // Vorschlaege landen als OFFENE Angaben (nicht uebernommen). Der Stand
    // bleibt bei Fragezeichen, bis der Nutzer entscheidet — ein Buying
    // Center aus duennen Daten ist gefaehrlicher als keins.
    for (const v of vorschlaegeAusTitel(p.title)) {
      await angabeSetzen({ mitgliedId: mid, dimension: v.dimension, wert: v.wert, herkunft: "ava:titel", grund: v.grund, vonActorId: null, uebernehmen: false });
    }
  }

  const kopf = (await pool.query<BcKopf>(`SELECT * FROM "BuyingCenter" WHERE "id" = $1`, [id])).rows[0]!;
  return c.json(await ladeVoll({ ...kopf, eigenes: true }), 200);
});

// ---- GET /buying-center ----------------------------------------------------

const listeRoute = createRoute({
  method: "get", path: "/buying-center", tags: [tag],
  summary: "Eigene Buying Center, optional je Firma",
  request: { query: z.object({ companyId: z.string().max(200).optional(), status: z.string().max(20).optional() }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(BuyingCenterShape.omit({ mitglieder: true, kanten: true }).extend({ mitglieder: z.number() })) }) } }, description: "ok" }, ...errorResponses },
});

buyingCenterRouter.openapi(listeRoute, async (c) => {
  const wer = auth(c);
  const { companyId, status } = c.req.valid("query");
  const r = await getGatewayPool().query(
    `SELECT b.*, (SELECT COUNT(*)::int FROM "BuyingCenterMitglied" m WHERE m."buyingCenterId" = b."id") AS "anzahl"
       FROM "BuyingCenter" b
      WHERE b."tenantId" = $1 AND b."eigentuemerActorId" = $2
        AND ($3::text IS NULL OR b."companyId" = $3)
        AND ($4::text IS NULL OR b."status" = $4)
      ORDER BY b."updatedAt" DESC`,
    [wer.tenantId, wer.actorId, companyId ?? null, status ?? null],
  );
  return c.json({
    items: (r.rows as Array<BcKopf & { anzahl: number }>).map((b) => ({
      id: b.id, companyId: b.companyId, anlass: b.anlass, status: b.status, eigenes: true,
      eigentuemerActorId: b.eigentuemerActorId, angelegtAt: b.angelegtAt.toISOString(), updatedAt: b.updatedAt.toISOString(),
      mitglieder: b.anzahl,
    })),
  }, 200);
});

// ---- GET /buying-center/{id} -----------------------------------------------

const IdParam = z.object({ id: z.string().min(1).max(64) });

const lesenRoute = createRoute({
  method: "get", path: "/buying-center/{id}", tags: [tag],
  summary: "Ein Buying Center vollstaendig (Eigentuemer oder Freigabe)",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: BuyingCenterShape } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(lesenRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), false);
  return c.json(await ladeVoll(bc), 200);
});

// ---- POST /buying-center/{id}/mitglieder -----------------------------------

const mitgliedRoute = createRoute({
  method: "post", path: "/buying-center/{id}/mitglieder", tags: [tag],
  summary: "Person aufnehmen — aus dem Bestand (personId) oder frei (name)",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({
    personId: z.string().max(64).optional(),
    name: z.string().min(2).max(200),
    funktion: z.string().max(200).optional(),
    grund: z.string().max(500).optional(),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: MitgliedShape } }, description: "aufgenommen" }, ...errorResponses },
});
buyingCenterRouter.openapi(mitgliedRoute, async (c) => {
  const wer = auth(c);
  const bc = await ladeMitZugriff(c.req.valid("param").id, wer, true);
  const { personId, name, funktion, grund } = c.req.valid("json");
  const pool = getGatewayPool();
  // Dieselbe Person nicht zweimal.
  if (personId) {
    const d = await pool.query(`SELECT "id" FROM "BuyingCenterMitglied" WHERE "buyingCenterId" = $1 AND "personId" = $2`, [bc.id, personId]);
    if (d.rows[0]) throw new HTTPException(409, { message: "Diese Person ist bereits im Buying Center." });
  }
  const mid = cuid();
  await pool.query(
    `INSERT INTO "BuyingCenterMitglied" ("id","buyingCenterId","personId","name","funktion","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())`,
    [mid, bc.id, personId ?? null, name.trim(), funktion?.trim() || null],
  );
  await angabeSetzen({ mitgliedId: mid, dimension: "notiz", wert: null, herkunft: "nutzer", grund: grund?.trim() || "vom Nutzer aufgenommen", vonActorId: wer.actorId, uebernehmen: false });
  for (const v of vorschlaegeAusTitel(funktion)) {
    await angabeSetzen({ mitgliedId: mid, dimension: v.dimension, wert: v.wert, herkunft: "ava:titel", grund: v.grund, vonActorId: null, uebernehmen: false });
  }
  await pool.query(`UPDATE "BuyingCenter" SET "updatedAt" = NOW() WHERE "id" = $1`, [bc.id]);
  const voll = await ladeVoll(bc);
  return c.json(voll.mitglieder.find((m) => m.id === mid)!, 200);
});

// ---- POST /buying-center/{id}/mitglieder/{mid}/angaben ---------------------

const angabeRoute = createRoute({
  method: "post", path: "/buying-center/{id}/mitglieder/{mid}/angaben", tags: [tag],
  summary: "Dimension setzen (Nutzerangabe) oder AVA-Vorschlag annehmen/verwerfen",
  request: { params: IdParam.extend({ mid: z.string().min(1).max(64) }), body: { content: { "application/json": { schema: z.object({
    dimension: z.enum(DIMENSIONEN),
    /** Bei rolle: "B" fuegt hinzu, "-B" nimmt weg. Sonst Einzelwert; null loescht. */
    wert: z.string().max(200).nullable(),
    grund: z.string().min(1).max(500),
    /** Einen offenen AVA-Vorschlag beantworten statt selbst zu setzen. */
    vorschlagId: z.string().max(64).optional(),
    entscheidung: z.enum(["angenommen", "verworfen"]).optional(),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: MitgliedShape } }, description: "gesetzt" }, ...errorResponses },
});
buyingCenterRouter.openapi(angabeRoute, async (c) => {
  const wer = auth(c);
  const { id, mid } = c.req.valid("param");
  const bc = await ladeMitZugriff(id, wer, true);
  const { dimension, wert, grund, vorschlagId, entscheidung } = c.req.valid("json");
  const pool = getGatewayPool();
  const m = await pool.query(`SELECT "id" FROM "BuyingCenterMitglied" WHERE "id" = $1 AND "buyingCenterId" = $2`, [mid, bc.id]);
  if (!m.rows[0]) throw new HTTPException(404, { message: "mitglied_not_found" });

  if (vorschlagId && entscheidung) {
    // Vorschlag beantworten: markieren, und bei Annahme den Stand nachziehen.
    const v = await pool.query(`SELECT * FROM "BuyingCenterAngabe" WHERE "id" = $1 AND "mitgliedId" = $2 AND "herkunft" LIKE 'ava:%'`, [vorschlagId, mid]);
    const vs = v.rows[0] as Record<string, unknown> | undefined;
    if (!vs) throw new HTTPException(404, { message: "vorschlag_not_found" });
    await pool.query(`UPDATE "BuyingCenterAngabe" SET "entschieden" = $2 WHERE "id" = $1`, [vorschlagId, entscheidung]);
    if (entscheidung === "angenommen") {
      await angabeSetzen({ mitgliedId: mid, dimension: String(vs.dimension), wert: (vs.wert as string | null) ?? null, herkunft: "nutzer", grund: `Vorschlag angenommen: ${grund}`, vonActorId: wer.actorId, uebernehmen: true });
    } else {
      await angabeSetzen({ mitgliedId: mid, dimension: String(vs.dimension), wert: null, herkunft: "nutzer", grund: `Vorschlag verworfen: ${grund}`, vonActorId: wer.actorId, uebernehmen: false });
    }
  } else {
    await angabeSetzen({ mitgliedId: mid, dimension, wert, herkunft: "nutzer", grund, vonActorId: wer.actorId, uebernehmen: true });
  }
  await pool.query(`UPDATE "BuyingCenter" SET "updatedAt" = NOW() WHERE "id" = $1`, [bc.id]);
  const voll = await ladeVoll(bc);
  return c.json(voll.mitglieder.find((x) => x.id === mid)!, 200);
});

// ---- PUT /buying-center/{id}/positionen ------------------------------------

const positionenRoute = createRoute({
  method: "put", path: "/buying-center/{id}/positionen", tags: [tag],
  summary: "Knotenpositionen nach dem Verschieben speichern (nur Eigentuemer)",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({
    positionen: z.array(z.object({ mitgliedId: z.string().max(64), x: z.number(), y: z.number() })).max(200),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(positionenRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), true);
  const { positionen } = c.req.valid("json");
  const pool = getGatewayPool();
  for (const p of positionen) {
    await pool.query(`UPDATE "BuyingCenterMitglied" SET "x" = $3, "y" = $4 WHERE "id" = $1 AND "buyingCenterId" = $2`, [p.mitgliedId, bc.id, p.x, p.y]);
  }
  return c.json({ ok: true }, 200);
});

// ---- Kanten ----------------------------------------------------------------

const kanteRoute = createRoute({
  method: "post", path: "/buying-center/{id}/kanten", tags: [tag],
  summary: "Beziehung zwischen zwei Personen: Einfluss, Vertraut, Animositaet",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({
    vonMitgliedId: z.string().max(64), nachMitgliedId: z.string().max(64),
    art: z.enum(KANTEN_ARTEN), staerke: z.enum(EINFLUESSE).optional(), grund: z.string().max(500).optional(),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: KanteShape } }, description: "angelegt" }, ...errorResponses },
});
buyingCenterRouter.openapi(kanteRoute, async (c) => {
  const wer = auth(c);
  const bc = await ladeMitZugriff(c.req.valid("param").id, wer, true);
  const { vonMitgliedId, nachMitgliedId, art, staerke, grund } = c.req.valid("json");
  if (vonMitgliedId === nachMitgliedId) throw new HTTPException(400, { message: "Eine Person kann sich nicht selbst beeinflussen." });
  const pool = getGatewayPool();
  const beide = await pool.query(`SELECT COUNT(*)::int AS n FROM "BuyingCenterMitglied" WHERE "buyingCenterId" = $1 AND "id" = ANY($2::text[])`, [bc.id, [vonMitgliedId, nachMitgliedId]]);
  if ((beide.rows[0]?.n ?? 0) !== 2) throw new HTTPException(404, { message: "mitglied_not_found" });
  // Dieselbe Beziehung nicht doppelt: ersetzen.
  await pool.query(`DELETE FROM "BuyingCenterKante" WHERE "buyingCenterId" = $1 AND "vonMitgliedId" = $2 AND "nachMitgliedId" = $3 AND "art" = $4`, [bc.id, vonMitgliedId, nachMitgliedId, art]);
  const kid = cuid();
  await pool.query(
    `INSERT INTO "BuyingCenterKante" ("id","buyingCenterId","vonMitgliedId","nachMitgliedId","art","staerke","grund","herkunft","vonActorId") VALUES ($1,$2,$3,$4,$5,$6,$7,'nutzer',$8)`,
    [kid, bc.id, vonMitgliedId, nachMitgliedId, art, staerke ?? null, grund?.trim() || null, wer.actorId],
  );
  await pool.query(`UPDATE "BuyingCenter" SET "updatedAt" = NOW() WHERE "id" = $1`, [bc.id]);
  const voll = await ladeVoll(bc);
  return c.json(voll.kanten.find((k) => k.id === kid)!, 200);
});

const kanteLoeschenRoute = createRoute({
  method: "delete", path: "/buying-center/{id}/kanten/{kid}", tags: [tag],
  summary: "Beziehung entfernen",
  request: { params: IdParam.extend({ kid: z.string().max(64) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(kanteLoeschenRoute, async (c) => {
  const { id, kid } = c.req.valid("param");
  const bc = await ladeMitZugriff(id, auth(c), true);
  await getGatewayPool().query(`DELETE FROM "BuyingCenterKante" WHERE "id" = $1 AND "buyingCenterId" = $2`, [kid, bc.id]);
  return c.json({ ok: true }, 200);
});

// ---- POST /buying-center/{id}/status ---------------------------------------

const statusRoute = createRoute({
  method: "post", path: "/buying-center/{id}/status", tags: [tag],
  summary: "abgeschlossen/archiviert nimmt den Fokus, aktiv setzt ihn wieder",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ status: z.enum(["aktiv", "abgeschlossen", "archiviert"]) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), fokus: z.boolean() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(statusRoute, async (c) => {
  const wer = auth(c);
  const bc = await ladeMitZugriff(c.req.valid("param").id, wer, true);
  const { status } = c.req.valid("json");
  const pool = getGatewayPool();
  await pool.query(`UPDATE "BuyingCenter" SET "status" = $2, "updatedAt" = NOW() WHERE "id" = $1`, [bc.id, status]);
  // Fokus haengt an der Firma je Nutzer: weg, wenn kein aktives Buying
  // Center zu ihr mehr existiert; da, sobald wieder eines aktiv ist.
  const aktive = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM "BuyingCenter" WHERE "tenantId" = $1 AND "eigentuemerActorId" = $2 AND "companyId" = $3 AND "status" = 'aktiv'`,
    [wer.tenantId, wer.actorId, bc.companyId],
  );
  const fokus = (aktive.rows[0]?.n ?? 0) > 0;
  if (fokus) await pool.query(`INSERT INTO "FokusKunde" ("tenantId","actorId","companyId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [wer.tenantId, wer.actorId, bc.companyId]);
  else await pool.query(`DELETE FROM "FokusKunde" WHERE "tenantId" = $1 AND "actorId" = $2 AND "companyId" = $3`, [wer.tenantId, wer.actorId, bc.companyId]);
  return c.json({ ok: true, fokus }, 200);
});

// ---- GET /buying-center/{id}/vorschlaege -----------------------------------

const vorschlaegeRoute = createRoute({
  method: "get", path: "/buying-center/{id}/vorschlaege", tags: [tag],
  summary: "Offene AVA-Vorschlaege und Hinweise aus den Leitfragen 1 und 3",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: z.object({
    offen: z.array(z.object({ vorschlagId: z.string(), mitgliedId: z.string(), name: z.string(), dimension: z.string(), wert: z.string().nullable(), grund: z.string() })),
    unbesetzteRollen: z.array(z.string()),
    ohneKontakt: z.array(z.string()),
  }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(vorschlaegeRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), false);
  const voll = await ladeVoll(bc);
  const offen = voll.mitglieder.flatMap((m) =>
    m.angaben
      .filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null)
      .map((a) => ({ vorschlagId: a.id, mitgliedId: m.id, name: m.name, dimension: a.dimension, wert: a.wert, grund: a.grund })),
  );
  return c.json({ offen, unbesetzteRollen: unbesetzteRollen(voll.mitglieder), ohneKontakt: ohneKontakt(voll.mitglieder) }, 200);
});
