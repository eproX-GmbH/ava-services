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
//   GET    /buying-center/{id}/vorschlaege      offene Vorschlaege + Leitfragen (+ verknuepfbare Personen, BC5)
//   POST   /buying-center/{id}/mitglieder/{mid}/verknuepfen   freies Mitglied an eine Bestandsperson binden (BC5)
//   POST   /buying-center/{id}/nachgefragt      monatliche Nachfrage vermerken (BC5)
//   GET    /buying-center/{id}/verlauf          Protokoll der Laeufe (Eigentuemer oder Freigabe)
//   POST   /buying-center/{id}/verlauf          Lauf vom Desktop protokollieren (CRM-Abgleich, Watchlist)
//   GET    /buying-center/{id}/freigaben        wer ansehen darf (BC7, nur Eigentuemer)
//   POST   /buying-center/{id}/freigaben        Sicht erteilen {actorId} (BC7)
//   DELETE /buying-center/{id}/freigaben/{actorId}   Sicht entziehen (BC7)
//   GET    /buying-center-geteilt?companyId=    was Kollegen mir freigegeben haben (BC7)
//
// Zugriffsregel, HIER erzwungen und nirgends sonst:
//   lesen      Eigentuemer ODER Freigabe fuer mich
//   schreiben  nur Eigentuemer
// tenantId und actorId kommen aus dem JWT. Es gibt keinen Parameter, ueber
// den sich ein anderer Eigentuemer adressieren liesse.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope, type AuthContext } from "../../middleware/auth";
import { requireFeature } from "../../lib/policy-guard";
import { getGatewayPool, getProducerPool } from "../../lib/producer-pools";
import { ErrorShape } from "./schemas";
import {
  ROLLEN, EINSTELLUNGEN, KONTAKTE, EINFLUESSE, KANTEN_ARTEN,
  vorschlaegeAusTitel, unbesetzteRollen, ohneKontakt, gleicherName, vorschlagAusHervorhebung,
} from "../../lib/buying-center-vorschlag";
import { HERVORHEBUNG_FELD, hervorhebungAusWert } from "../../lib/contact-extraction/hervorhebung";

export const buyingCenterRouter = new OpenAPIHono();
buyingCenterRouter.use("*", requireScope("company:read"));
// BC6 — Organisationsschalter `buyingcenter`: abgeschaltet heisst 403 fuer
// jede Route, auch fuer das Lesen. Der Desktop blendet Reiter, Karte und
// Werkzeuge aus; hier steht die Schranke, die ohne Desktop gilt.
buyingCenterRouter.use("*", async (c, next) => {
  await requireFeature(getGatewayPool(), c.get("auth") as AuthContext, "buyingcenter");
  await next();
});

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
/** BC5: Nach so vielen Tagen ohne Aenderung fragt AVA, ob das Buying Center noch stimmt. */
const NACHFRAGE_TAGE = 30;

function auth(c: { get: (k: "auth") => unknown }): { tenantId: string; actorId: string } {
  const a = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  if (!a?.tenantId || !a.actorId) throw new HTTPException(401, { message: "auth_context_missing" });
  return { tenantId: a.tenantId, actorId: a.actorId };
}

function cuid(): string {
  // Gleiche Form wie Prisma-cuid, ohne Prisma-Client: Zeit + Zufall.
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

/** Arten der protokollierten Laeufe — der Desktop darf nur seine eigenen melden. */
const LAUF_ARTEN = ["entwurf", "crm-abgleich", "website-abgleich", "nachfrage", "watchlist", "verknuepfung", "status", "freigabe"] as const;
const DESKTOP_LAUF_ARTEN = ["crm-abgleich", "watchlist"] as const;

/**
 * Protokoll: eine Zeile je Lauf. Nie ein Fehler nach aussen — ein
 * misslungener Eintrag darf den Lauf selbst nicht kippen.
 */
async function lauf(buyingCenterId: string, art: (typeof LAUF_ARTEN)[number], ergebnis: string, details?: Record<string, unknown>): Promise<void> {
  try {
    await getGatewayPool().query(
      `INSERT INTO "BuyingCenterLauf" ("id","buyingCenterId","art","ergebnis","details") VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [cuid(), buyingCenterId, art, ergebnis.slice(0, 500), details ? JSON.stringify(details) : null],
    );
  } catch { /* Protokoll ist Beiwerk. */ }
}

// ---- Zugriff ---------------------------------------------------------------

interface BcKopf {
  id: string; tenantId: string; eigentuemerActorId: string; companyId: string;
  anlass: string; status: string; angelegtAt: Date; updatedAt: Date;
  nachgefragtAt: Date | null;
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
  /** Beschaeftigungsbeginn "JJJJ-MM" / "JJJJ" aus dem Kontakt-Bestand, sonst null. */
  seit: z.string().nullable(),
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
  angelegtAt: z.string(), updatedAt: z.string(), nachgefragtAt: z.string().nullable(),
  mitglieder: z.array(MitgliedShape), kanten: z.array(KanteShape),
});

/** Beschaeftigungsbeginn je Bestandsperson (Fakt employmentSince, Apify Full-Modus). */
async function seitJePerson(personIds: Array<string | null>): Promise<Map<string, string>> {
  const ids = personIds.filter((p): p is string => !!p);
  const aus = new Map<string, string>();
  if (ids.length === 0) return aus;
  const r = await getProducerPool("company-contact").query<{ personId: string; value: string }>(
    `SELECT DISTINCT ON ("personId") "personId", "value" FROM "Fact"
      WHERE "personId" = ANY($1::text[]) AND "field" = 'employmentSince' AND "status" = 'ACTIVE'
      ORDER BY "personId", "lastSeen" DESC`,
    [ids],
  );
  for (const row of r.rows) aus.set(row.personId, row.value);
  return aus;
}

/** Monate zwischen "JJJJ-MM"/"JJJJ" und jetzt; null bei unlesbarem Wert. */
export function monateSeit(seit: string, jetzt = new Date()): number | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(seit);
  if (!m) return null;
  const jahr = Number(m[1]), monat = m[2] ? Number(m[2]) : 1;
  return (jetzt.getUTCFullYear() - jahr) * 12 + (jetzt.getUTCMonth() + 1 - monat);
}

async function ladeVoll(bc: BcKopf & { eigenes: boolean }): Promise<z.infer<typeof BuyingCenterShape>> {
  const pool = getGatewayPool();
  const m = await pool.query(`SELECT * FROM "BuyingCenterMitglied" WHERE "buyingCenterId" = $1 ORDER BY "angelegtAt"`, [bc.id]);
  const ids = m.rows.map((r: Record<string, unknown>) => r.id as string);
  const a = ids.length
    ? await pool.query(`SELECT * FROM "BuyingCenterAngabe" WHERE "mitgliedId" = ANY($1::text[]) ORDER BY "erfasstAt" DESC`, [ids])
    : { rows: [] as Record<string, unknown>[] };
  const k = await pool.query(`SELECT * FROM "BuyingCenterKante" WHERE "buyingCenterId" = $1 ORDER BY "erfasstAt"`, [bc.id]);
  const seitJe = await seitJePerson((m.rows as Array<{ personId: string | null }>).map((r) => r.personId));
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
    nachgefragtAt: bc.nachgefragtAt ? bc.nachgefragtAt.toISOString() : null,
    mitglieder: (m.rows as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), personId: (r.personId as string | null) ?? null, name: String(r.name),
      funktion: (r.funktion as string | null) ?? null, rollen: (r.rollen as string[]) ?? [],
      seit: r.personId ? seitJe.get(r.personId as string) ?? null : null,
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
  const neueMitglieder: Array<{ id: string; personId: string | null; einfluss: string | null }> = [];
  let titelVorschlaege = 0;
  for (const p of personen.rows) {
    const mid = cuid();
    await pool.query(
      `INSERT INTO "BuyingCenterMitglied" ("id","buyingCenterId","personId","name","funktion","updatedAt") VALUES ($1,$2,$3,$4,$5,NOW())`,
      [mid, id, p.personId, p.fullName, p.title],
    );
    neueMitglieder.push({ id: mid, personId: p.personId, einfluss: null });
    // Vorschlaege landen als OFFENE Angaben (nicht uebernommen). Der Stand
    // bleibt bei Fragezeichen, bis der Nutzer entscheidet — ein Buying
    // Center aus duennen Daten ist gefaehrlicher als keins.
    for (const v of vorschlaegeAusTitel(p.title)) {
      await angabeSetzen({ mitgliedId: mid, dimension: v.dimension, wert: v.wert, herkunft: "ava:titel", grund: v.grund, vonActorId: null, uebernehmen: false });
      titelVorschlaege++;
    }
  }
  // BC4 — was die Website hervorhebt, als Einfluss-Vorschlag dazu.
  const websiteAbgelegt = await websiteVorschlaege(neueMitglieder);
  await lauf(id, "entwurf",
    `Entwurf aus dem Kontakt-Bestand: ${personen.rows.length} Personen, ${titelVorschlaege} Vorschläge aus Titeln, ${websiteAbgelegt} von der Website${fokusFrei ? "" : " — Fokus-Deckel erreicht, kein Fokuskunde"}`,
    { personen: personen.rows.length, titelVorschlaege, websiteAbgelegt, fokus: fokusFrei });

  const kopf = (await pool.query<BcKopf>(`SELECT * FROM "BuyingCenter" WHERE "id" = $1`, [id])).rows[0]!;
  return c.json(await ladeVoll({ ...kopf, eigenes: true }), 200);
});

// ---- GET /buying-center ----------------------------------------------------

const listeRoute = createRoute({
  method: "get", path: "/buying-center", tags: [tag],
  summary: "Eigene Buying Center, optional je Firma",
  request: { query: z.object({
    companyId: z.string().max(200).optional(), status: z.string().max(20).optional(),
    // BC5: nur die, bei denen die monatliche Nachfrage ansteht (aktiv, seit
    // NACHFRAGE_TAGE unveraendert, nicht innerhalb dieser Frist gefragt).
    faellig: z.enum(["true"]).optional(),
  }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(BuyingCenterShape.omit({ mitglieder: true, kanten: true }).extend({ mitglieder: z.number() })) }) } }, description: "ok" }, ...errorResponses },
});

buyingCenterRouter.openapi(listeRoute, async (c) => {
  const wer = auth(c);
  const { companyId, status, faellig } = c.req.valid("query");
  const r = await getGatewayPool().query(
    `SELECT b.*, (SELECT COUNT(*)::int FROM "BuyingCenterMitglied" m WHERE m."buyingCenterId" = b."id") AS "anzahl"
       FROM "BuyingCenter" b
      WHERE b."tenantId" = $1 AND b."eigentuemerActorId" = $2
        AND ($3::text IS NULL OR b."companyId" = $3)
        AND ($4::text IS NULL OR b."status" = $4)
        AND ($5::boolean IS NOT TRUE OR (
          b."status" = 'aktiv'
          AND b."updatedAt" < NOW() - ($6::int || ' days')::interval
          AND (b."nachgefragtAt" IS NULL OR b."nachgefragtAt" < NOW() - ($6::int || ' days')::interval)
        ))
      ORDER BY b."updatedAt" DESC`,
    [wer.tenantId, wer.actorId, companyId ?? null, status ?? null, faellig === "true", NACHFRAGE_TAGE],
  );
  return c.json({
    items: (r.rows as Array<BcKopf & { anzahl: number }>).map((b) => ({
      id: b.id, companyId: b.companyId, anlass: b.anlass, status: b.status, eigenes: true,
      eigentuemerActorId: b.eigentuemerActorId, angelegtAt: b.angelegtAt.toISOString(), updatedAt: b.updatedAt.toISOString(),
      nachgefragtAt: b.nachgefragtAt ? b.nachgefragtAt.toISOString() : null,
      mitglieder: b.anzahl,
    })),
  }, 200);
});

const IdParam = z.object({ id: z.string().min(1).max(64) });

// ---- GET /buying-center-geteilt (BC7) --------------------------------------
//
// Was Kollegen mir zum Ansehen freigegeben haben — getrennt von allem
// Eigenen (Abschnitt 8.3). Eigener Pfad statt /buying-center/geteilt, damit
// er nie mit /buying-center/{id} kollidiert. Nur innerhalb der eigenen
// Organisation: Wer die Organisation verlaesst, sieht nichts mehr, auch
// wenn die Freigabe-Zeile noch steht.

const EigentuemerShape = z.object({ actorId: z.string(), email: z.string().nullable(), name: z.string().nullable() });
const GeteiltShape = z.object({
  id: z.string(), companyId: z.string(), companyName: z.string().nullable(), anlass: z.string(), status: z.string(),
  eigentuemer: EigentuemerShape, angelegtAt: z.string(), updatedAt: z.string(), mitglieder: z.number(),
});

const geteiltRoute = createRoute({
  method: "get", path: "/buying-center-geteilt", tags: [tag],
  summary: "Buying Center, die Kollegen mir zum Ansehen freigegeben haben",
  request: { query: z.object({ companyId: z.string().max(200).optional() }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(GeteiltShape) }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(geteiltRoute, async (c) => {
  const wer = auth(c);
  const { companyId } = c.req.valid("query");
  const r = await getGatewayPool().query<BcKopf & { email: string | null; name: string | null; anzahl: number }>(
    `SELECT b.*, t."email", t."name",
            (SELECT COUNT(*)::int FROM "BuyingCenterMitglied" m WHERE m."buyingCenterId" = b."id") AS "anzahl"
       FROM "BuyingCenterFreigabe" f
       JOIN "BuyingCenter" b ON b."id" = f."buyingCenterId"
       LEFT JOIN "TenantMember" t ON t."actorId" = b."eigentuemerActorId"
      WHERE f."actorId" = $1 AND b."tenantId" = $2
        AND ($3::text IS NULL OR b."companyId" = $3)
      ORDER BY b."companyId", b."updatedAt" DESC`,
    [wer.actorId, wer.tenantId, companyId ?? null],
  );
  const firmenIds = Array.from(new Set(r.rows.map((b) => b.companyId)));
  const namen = firmenIds.length
    ? await getProducerPool("company-contact").query<{ id: string; name: string | null }>(`SELECT "id", "name" FROM "Company" WHERE "id" = ANY($1::text[])`, [firmenIds]).catch(() => ({ rows: [] as Array<{ id: string; name: string | null }> }))
    : { rows: [] as Array<{ id: string; name: string | null }> };
  const firmenname = new Map(namen.rows.map((x) => [x.id, x.name]));
  return c.json({
    items: r.rows.map((b) => ({
      id: b.id, companyId: b.companyId, companyName: firmenname.get(b.companyId) ?? null, anlass: b.anlass, status: b.status,
      eigentuemer: { actorId: b.eigentuemerActorId, email: b.email, name: b.name },
      angelegtAt: b.angelegtAt.toISOString(), updatedAt: b.updatedAt.toISOString(), mitglieder: b.anzahl,
    })),
  }, 200);
});

// ---- Freigaben (BC7) --------------------------------------------------------
//
// Sichtfreigabe an einzelne Mitglieder der eigenen Organisation. Nur der
// Eigentuemer erteilt und entzieht; der Freigegebene liest (ladeMitZugriff)
// und schreibt nie. Eine Freigabe gibt Einschaetzungen ueber Menschen
// weiter — der Desktop fragt deshalb vorher nach.

const FreigabeShape = z.object({ actorId: z.string(), email: z.string().nullable(), name: z.string().nullable(), erteiltAt: z.string() });

async function ladeFreigaben(bcId: string): Promise<z.infer<typeof FreigabeShape>[]> {
  const r = await getGatewayPool().query<{ actorId: string; email: string | null; name: string | null; erteiltAt: Date }>(
    `SELECT f."actorId", t."email", t."name", f."erteiltAt"
       FROM "BuyingCenterFreigabe" f LEFT JOIN "TenantMember" t ON t."actorId" = f."actorId"
      WHERE f."buyingCenterId" = $1 ORDER BY f."erteiltAt"`,
    [bcId],
  );
  return r.rows.map((x) => ({ actorId: x.actorId, email: x.email, name: x.name, erteiltAt: x.erteiltAt.toISOString() }));
}

const freigabenRoute = createRoute({
  method: "get", path: "/buying-center/{id}/freigaben", tags: [tag],
  summary: "Wer dieses Buying Center ansehen darf (nur Eigentuemer)",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(FreigabeShape) }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(freigabenRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), true);
  return c.json({ items: await ladeFreigaben(bc.id) }, 200);
});

const freigebenRoute = createRoute({
  method: "post", path: "/buying-center/{id}/freigaben", tags: [tag],
  summary: "Sicht fuer ein Organisationsmitglied erteilen (nur Eigentuemer)",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({ actorId: z.string().min(1).max(128) }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(FreigabeShape) }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(freigebenRoute, async (c) => {
  const wer = auth(c);
  const bc = await ladeMitZugriff(c.req.valid("param").id, wer, true);
  const { actorId } = c.req.valid("json");
  if (actorId === wer.actorId) throw new HTTPException(400, { message: "Dir selbst musst du nichts freigeben." });
  const pool = getGatewayPool();
  // Nur an Mitglieder der EIGENEN Organisation — nie darueber hinaus (Abschnitt 10.3).
  const m = await pool.query(`SELECT 1 FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [wer.tenantId, actorId]);
  if (!m.rowCount) throw new HTTPException(404, { message: "Kein Mitglied deiner Organisation." });
  await pool.query(
    `INSERT INTO "BuyingCenterFreigabe" ("buyingCenterId","actorId","erteiltVon") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [bc.id, actorId, wer.actorId],
  );
  await lauf(bc.id, "freigabe", "Sicht freigegeben", { actorId });
  return c.json({ items: await ladeFreigaben(bc.id) }, 200);
});

const freigabeEntziehenRoute = createRoute({
  method: "delete", path: "/buying-center/{id}/freigaben/{actorId}", tags: [tag],
  summary: "Sicht entziehen (nur Eigentuemer)",
  request: { params: IdParam.extend({ actorId: z.string().min(1).max(128) }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(FreigabeShape) }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(freigabeEntziehenRoute, async (c) => {
  const { id, actorId } = c.req.valid("param");
  const bc = await ladeMitZugriff(id, auth(c), true);
  await getGatewayPool().query(`DELETE FROM "BuyingCenterFreigabe" WHERE "buyingCenterId" = $1 AND "actorId" = $2`, [bc.id, actorId]);
  await lauf(bc.id, "freigabe", "Sicht entzogen", { actorId });
  return c.json({ items: await ladeFreigaben(bc.id) }, 200);
});

// ---- GET /buying-center/{id} -----------------------------------------------

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

// ---- POST /buying-center/{id}/mitglieder/{mid}/vorschlaege ------------------
//
// AVA-Vorschlaege aus Daten (BC3: CRM aus dem Desktop; BC4: Website aus dem
// Gateway selbst). Landen als OFFENE Angaben, aendern den Stand nicht.

/**
 * Legt einen AVA-Vorschlag ab — mit drei Schranken, damit die Seitenleiste
 * nicht zumuellt: nicht, wenn der Nutzer die Dimension selbst gesetzt hat;
 * nicht, wenn derselbe Vorschlag schon offen ist; nicht, wenn er bereits
 * verworfen wurde. Der eine Weg fuer alle Herkuenfte.
 */
async function vorschlagAblegen(p: { mitgliedId: string; dimension: string; wert: string; herkunft: string; grund: string }): Promise<{ abgelegt: boolean; grund?: string }> {
  const pool = getGatewayPool();
  // Vom Nutzer gesetzt? Dann kein Vorschlag — seine Angabe gilt.
  const gesetzt = await pool.query(
    `SELECT 1 FROM "BuyingCenterAngabe" WHERE "mitgliedId" = $1 AND "dimension" = $2 AND "herkunft" = 'nutzer' AND "wert" IS NOT NULL LIMIT 1`,
    [p.mitgliedId, p.dimension],
  );
  if (gesetzt.rowCount) return { abgelegt: false, grund: "vom Nutzer gesetzt" };
  // Denselben offenen Vorschlag nicht wiederholen.
  const doppelt = await pool.query(
    `SELECT 1 FROM "BuyingCenterAngabe" WHERE "mitgliedId" = $1 AND "dimension" = $2 AND "wert" = $3 AND "herkunft" LIKE 'ava:%' AND "entschieden" IS NULL LIMIT 1`,
    [p.mitgliedId, p.dimension, p.wert],
  );
  if (doppelt.rowCount) return { abgelegt: false, grund: "liegt schon vor" };
  // Bereits verworfen? Dann auch nicht — der Nutzer hat entschieden.
  const verworfen = await pool.query(
    `SELECT 1 FROM "BuyingCenterAngabe" WHERE "mitgliedId" = $1 AND "dimension" = $2 AND "wert" = $3 AND "entschieden" = 'verworfen' LIMIT 1`,
    [p.mitgliedId, p.dimension, p.wert],
  );
  if (verworfen.rowCount) return { abgelegt: false, grund: "bereits verworfen" };

  await angabeSetzen({ mitgliedId: p.mitgliedId, dimension: p.dimension, wert: p.wert, herkunft: p.herkunft, grund: p.grund, vonActorId: null, uebernehmen: false });
  return { abgelegt: true };
}

/**
 * BC4 — Hervorhebung auf der Website als Einfluss-Vorschlag. Liest je
 * Bestandsperson die "websiteHervorhebung"-Fakten aus dem Kontakt-Bestand
 * (Seite in Observation.evidenceUrl; hoechstens 180 Tage alt, aeltere
 * Team-Seiten sind laengst umgebaut) und legt einen offenen Vorschlag ab,
 * wenn die Seite etwas hergibt. Nur fuer Mitglieder, deren Einfluss noch
 * offen ist. Liefert, wie viele Vorschlaege neu abgelegt wurden.
 */
async function websiteVorschlaege(mitglieder: Array<{ id: string; personId: string | null; einfluss: string | null }>): Promise<number> {
  const offen = mitglieder.filter((m) => m.personId !== null && m.einfluss === null);
  if (offen.length === 0) return 0;
  const r = await getProducerPool("company-contact").query<{ personId: string; value: string; url: string | null }>(
    `SELECT f."personId", f."value", o."evidenceUrl" AS url
       FROM "Fact" f LEFT JOIN "Observation" o ON o."id" = f."lastObsId"
      WHERE f."personId" = ANY($1::text[]) AND f."field" = $2 AND f."status" = 'ACTIVE'
        AND f."lastSeen" > NOW() - INTERVAL '180 days'`,
    [offen.map((m) => m.personId), HERVORHEBUNG_FELD],
  );
  let abgelegt = 0;
  for (const m of offen) {
    const hs = r.rows
      .filter((x) => x.personId === m.personId)
      .flatMap((x) => { const h = hervorhebungAusWert(x.value); return h ? [{ ...h, url: x.url }] : []; });
    const v = vorschlagAusHervorhebung(hs);
    if (!v) continue;
    const ergebnis = await vorschlagAblegen({ mitgliedId: m.id, dimension: v.dimension, wert: v.wert, herkunft: "ava:website", grund: v.grund });
    if (ergebnis.abgelegt) abgelegt++;
  }
  return abgelegt;
}

const vorschlagRoute = createRoute({
  method: "post", path: "/buying-center/{id}/mitglieder/{mid}/vorschlaege", tags: [tag],
  summary: "AVA-Vorschlag ablegen (offen, aendert den Stand nicht)",
  request: { params: IdParam.extend({ mid: z.string().min(1).max(64) }), body: { content: { "application/json": { schema: z.object({
    dimension: z.enum(["rolle", "kontakt", "einfluss"]),
    wert: z.string().min(1).max(20),
    herkunft: z.enum(["ava:titel", "ava:website", "ava:linkedin", "ava:crm"]),
    grund: z.string().min(1).max(500),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ abgelegt: z.boolean(), grund: z.string().optional() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(vorschlagRoute, async (c) => {
  const wer = auth(c);
  const { id, mid } = c.req.valid("param");
  const bc = await ladeMitZugriff(id, wer, true);
  const { dimension, wert, herkunft, grund } = c.req.valid("json");
  pruefeWert(dimension, wert);
  const m = await getGatewayPool().query(`SELECT 1 FROM "BuyingCenterMitglied" WHERE "id" = $1 AND "buyingCenterId" = $2`, [mid, bc.id]);
  if (!m.rows[0]) throw new HTTPException(404, { message: "mitglied_not_found" });
  return c.json(await vorschlagAblegen({ mitgliedId: mid, dimension, wert, herkunft, grund }), 200);
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
  await lauf(bc.id, "status", `Status "${status}" gesetzt — Firma ${fokus ? "bleibt" : "ist kein"} Fokuskunde`, { status, fokus });
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
    // BC5: frei aufgenommene Mitglieder, zu denen im Kontakt-Bestand eine
    // gleichnamige Person bei dieser Firma liegt.
    verknuepfbar: z.array(z.object({ mitgliedId: z.string(), name: z.string(), personId: z.string(), fullName: z.string(), title: z.string().nullable() })),
    // Buch-Checkliste (Sieck): Hinweise ohne Zuordnung, z. B. "neu in der Position".
    hinweise: z.array(z.string()),
  }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(vorschlaegeRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), false);
  let voll = await ladeVoll(bc);
  // BC4 — Website-Hervorhebung beim Oeffnen nachziehen: Ein Kontakte-Lauf
  // nach dem Anlegen bringt neue Fakten, die hier ankommen sollen. Nur im
  // eigenen — ein Freigegebener loest keine Schreibvorgaenge aus.
  if (bc.eigenes) {
    const neu = await websiteVorschlaege(voll.mitglieder);
    if (neu > 0) {
      await lauf(bc.id, "website-abgleich", `Website-Hervorhebung: ${neu} ${neu === 1 ? "Vorschlag" : "Vorschläge"} abgelegt`, { abgelegt: neu });
      voll = await ladeVoll(bc);
    }
  }
  const verknuepfbar = await verknuepfbarePersonen(bc.companyId, voll.mitglieder);
  // Neu in der Position (< 6 Monate): Wer gerade angefangen hat, kennt die
  // alten Lieferanten nicht und hat noch keine Loyalitaeten — laut Buch ein
  // moeglicher Informationsvorsprung. Nur ein Hinweis, keine Zuordnung.
  const hinweise = voll.mitglieder.flatMap((m) => {
    const monate = m.seit ? monateSeit(m.seit) : null;
    if (monate === null || monate >= 6 || monate < 0) return [];
    return [`${m.name} ist erst seit ${m.seit} bei der Firma (${monate === 0 ? "diesen Monat" : `${monate} Monate`}) — neu in der Position, Informationsvorsprung möglich.`];
  });
  const offen = voll.mitglieder.flatMap((m) =>
    m.angaben
      .filter((a) => a.herkunft.startsWith("ava:") && a.entschieden === null)
      .map((a) => ({ vorschlagId: a.id, mitgliedId: m.id, name: m.name, dimension: a.dimension, wert: a.wert, grund: a.grund })),
  );
  return c.json({ offen, unbesetzteRollen: unbesetzteRollen(voll.mitglieder), ohneKontakt: ohneKontakt(voll.mitglieder), verknuepfbar, hinweise }, 200);
});

/**
 * BC5 — Verknuepfen freier Personen mit dem Bestand. Ein im Chat frei
 * aufgenommenes Mitglied ("Frau Meier aus dem Einkauf") bekommt keine
 * Personensignale, keine Watchlist, keinen Herkunftsnachweis. Taucht
 * spaeter eine gleichnamige Person bei der Firma im Kontakt-Bestand auf,
 * wird das hier vorgeschlagen — verbunden wird erst auf Zuruf.
 */
async function verknuepfbarePersonen(
  companyId: string,
  mitglieder: Array<{ id: string; personId: string | null; name: string }>,
): Promise<Array<{ mitgliedId: string; name: string; personId: string; fullName: string; title: string | null }>> {
  const frei = mitglieder.filter((m) => m.personId === null);
  if (frei.length === 0) return [];
  const schonVerbunden = new Set(mitglieder.map((m) => m.personId).filter((p): p is string => p !== null));
  const kontakte = getProducerPool("company-contact");
  const personen = await kontakte.query<{ personId: string; fullName: string; title: string | null }>(
    `SELECT DISTINCT ON (p.id) p.id AS "personId", p."fullName", e.title
       FROM "Employment" e JOIN "Person" p ON p.id = e."personId"
      WHERE e."companyId" = $1 AND (e."isCurrent" IS DISTINCT FROM false)
      ORDER BY p.id, e."lastSeen" DESC NULLS LAST
      LIMIT 200`,
    [companyId],
  );
  const treffer: Array<{ mitgliedId: string; name: string; personId: string; fullName: string; title: string | null }> = [];
  for (const m of frei) {
    const p = personen.rows.find((x) => !schonVerbunden.has(x.personId) && gleicherName(x.fullName, m.name));
    if (p) treffer.push({ mitgliedId: m.id, name: m.name, personId: p.personId, fullName: p.fullName, title: p.title });
  }
  return treffer;
}

// ---- POST /buying-center/{id}/mitglieder/{mid}/verknuepfen -----------------

const verknuepfenRoute = createRoute({
  method: "post", path: "/buying-center/{id}/mitglieder/{mid}/verknuepfen", tags: [tag],
  summary: "Freies Mitglied an eine Person aus dem Kontakt-Bestand binden",
  request: {
    params: z.object({ id: z.string(), mid: z.string() }),
    body: { content: { "application/json": { schema: z.object({ personId: z.string().min(1).max(64) }) } } },
  },
  responses: { 200: { content: { "application/json": { schema: MitgliedShape } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(verknuepfenRoute, async (c) => {
  const { id, mid } = c.req.valid("param");
  const { personId } = c.req.valid("json");
  const bc = await ladeMitZugriff(id, auth(c), true);
  const pool = getGatewayPool();
  const m = await pool.query(`SELECT "id", "personId" FROM "BuyingCenterMitglied" WHERE "id" = $1 AND "buyingCenterId" = $2`, [mid, bc.id]);
  if (m.rowCount === 0) throw new HTTPException(404, { message: "mitglied_not_found" });
  const d = await pool.query(`SELECT 1 FROM "BuyingCenterMitglied" WHERE "buyingCenterId" = $1 AND "personId" = $2 AND "id" <> $3`, [bc.id, personId, mid]);
  if ((d.rowCount ?? 0) > 0) throw new HTTPException(409, { message: "Diese Person ist bereits als anderes Mitglied im Buying Center." });
  const p = await getProducerPool("company-contact").query<{ fullName: string }>(`SELECT "fullName" FROM "Person" WHERE "id" = $1`, [personId]);
  if (p.rowCount === 0) throw new HTTPException(404, { message: "person_not_found" });
  await pool.query(`UPDATE "BuyingCenterMitglied" SET "personId" = $1, "updatedAt" = NOW() WHERE "id" = $2`, [personId, mid]);
  await lauf(bc.id, "verknuepfung", `Mitglied mit Bestandsperson "${p.rows[0]!.fullName}" verbunden`, { mitgliedId: mid, personId });
  await pool.query(`UPDATE "BuyingCenter" SET "updatedAt" = NOW() WHERE "id" = $1`, [bc.id]);
  const voll = await ladeVoll(bc);
  const neu = voll.mitglieder.find((x) => x.id === mid);
  if (!neu) throw new HTTPException(404, { message: "mitglied_not_found" });
  return c.json(neu, 200);
});

// ---- POST /buying-center/{id}/nachgefragt ----------------------------------
//
// BC5: Der Heartbeat fragt einmal im Monat, ob ein unveraendertes Buying
// Center noch stimmt, und vermerkt das hier — sonst fragt er jeden Tag.

const nachgefragtRoute = createRoute({
  method: "post", path: "/buying-center/{id}/nachgefragt", tags: [tag],
  summary: "Monatliche Nachfrage vermerken",
  request: { params: IdParam },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean(), nachgefragtAt: z.string() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(nachgefragtRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), true);
  const r = await getGatewayPool().query<{ nachgefragtAt: Date }>(
    `UPDATE "BuyingCenter" SET "nachgefragtAt" = NOW() WHERE "id" = $1 RETURNING "nachgefragtAt"`, [bc.id],
  );
  await lauf(bc.id, "nachfrage", "Monatliche Nachfrage gestellt: Stimmt das Buying Center noch?");
  return c.json({ ok: true, nachgefragtAt: r.rows[0].nachgefragtAt.toISOString() }, 200);
});

// ---- GET/POST /buying-center/{id}/verlauf ----------------------------------

const LaufShape = z.object({ id: z.string(), art: z.string(), ergebnis: z.string(), details: z.record(z.string(), z.unknown()).nullable(), zeitpunkt: z.string() });

const verlaufRoute = createRoute({
  method: "get", path: "/buying-center/{id}/verlauf", tags: [tag],
  summary: "Protokoll der Laeufe (neueste zuerst)",
  request: { params: IdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) },
  responses: { 200: { content: { "application/json": { schema: z.object({ items: z.array(LaufShape) }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(verlaufRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), false);
  const limit = c.req.valid("query").limit ?? 50;
  const r = await getGatewayPool().query(
    `SELECT "id","art","ergebnis","details","zeitpunkt" FROM "BuyingCenterLauf" WHERE "buyingCenterId" = $1 ORDER BY "zeitpunkt" DESC LIMIT $2`,
    [bc.id, limit],
  );
  return c.json({
    items: (r.rows as Array<Record<string, unknown>>).map((x) => ({
      id: String(x.id), art: String(x.art), ergebnis: String(x.ergebnis),
      details: (x.details as Record<string, unknown> | null) ?? null,
      zeitpunkt: new Date(x.zeitpunkt as string).toISOString(),
    })),
  }, 200);
});

const laufMeldenRoute = createRoute({
  method: "post", path: "/buying-center/{id}/verlauf", tags: [tag],
  summary: "Lauf vom Desktop protokollieren (CRM-Abgleich, Watchlist)",
  request: { params: IdParam, body: { content: { "application/json": { schema: z.object({
    art: z.enum(DESKTOP_LAUF_ARTEN), ergebnis: z.string().min(1).max(500), details: z.record(z.string(), z.unknown()).optional(),
  }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ ok: z.boolean() }) } }, description: "ok" }, ...errorResponses },
});
buyingCenterRouter.openapi(laufMeldenRoute, async (c) => {
  const bc = await ladeMitZugriff(c.req.valid("param").id, auth(c), true);
  const { art, ergebnis, details } = c.req.valid("json");
  await lauf(bc.id, art, ergebnis, details);
  return c.json({ ok: true }, 200);
});
