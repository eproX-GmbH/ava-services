// Relevanz (docs/PLAN_RELEVANZ.md) — Naehe je Nutzer und Ziel.
//
//   POST   /relevanz/signale     Buendel von Signalen schreiben
//   GET    /relevanz             Werte bestimmter Ziele lesen
//   GET    /relevanz/vorschau    nach Rang sortiert, fuer den Heartbeat
//   GET    /relevanz/signale     Rohsignale eines Ziels (Einsicht)
//   DELETE /relevanz/signale     alles oder ein Ziel vergessen
//   GET    /relevanz/thema       Organisationsaggregat: Anzahl ohne Namen
//
// Mandant und Nutzer kommen AUSSCHLIESSLICH aus dem JWT. Es gibt bewusst
// keinen Parameter, ueber den ein anderer Nutzer adressierbar waere — auch
// nicht fuer Administratoren der Organisation. Diese Zusage traegt den
// Standardzustand "eingeschaltet"; sie zu lockern hiesse, ihn neu zu
// verhandeln (Plan 9.3).
//
// Gerechnet wird hier, nicht auf dem Geraet: Der Wert soll ueber Geraete
// hinweg gleich sein, und eine gewichtete Summe ist keine Rechenlast, die
// zum Nutzer gehoert. Das Gewicht (ICP, Firmenstatus) entsteht dagegen
// lokal und kommt als blosse Zahl mit.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import {
  naehe as berechneNaehe,
  naeheMitVererbung,
  naeheMitFokus,
  begruendung as berechneBegruendung,
  rang as berechneRang,
  WARM_AB,
  type Signal,
} from "../../lib/relevanz-score";
import { ErrorShape } from "./schemas";

export const relevanzRouter = new OpenAPIHono();
relevanzRouter.use("*", requireScope("company:read"));

const tag = "relevanz";
const errorResponses = {
  400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
};

const ZielArt = z.enum(["firma", "person"]);

function auth(c: { get: (k: "auth") => unknown }): { tenantId: string; actorId: string } {
  const a = c.get("auth") as { tenantId?: string; actorId?: string } | undefined;
  return { tenantId: a?.tenantId ?? "", actorId: a?.actorId ?? "" };
}

// ---- Neuberechnung ---------------------------------------------------------

/**
 * Wert eines Ziels neu bilden und schreiben.
 *
 * Wird nach jedem Buendel fuer genau die betroffenen Ziele aufgerufen —
 * nicht fuer alle. Die Rechnung liest nur die Signale eines Ziels; das
 * bleibt billig, auch wenn ein Nutzer Jahre an Signalen angesammelt hat.
 */
/** Fokuskunde des Nutzers (Firma) oder Mitglied eines seiner aktiven Buying Center (Person)? */
async function istFokus(
  pool: ReturnType<typeof getGatewayPool>,
  tenantId: string,
  actorId: string,
  ziel: { zielArt: string; zielId: string },
): Promise<boolean> {
  const r = ziel.zielArt === "firma"
    ? await pool.query(
        `SELECT 1 FROM "FokusKunde" WHERE "tenantId" = $1 AND "actorId" = $2 AND "companyId" = $3 LIMIT 1`,
        [tenantId, actorId, ziel.zielId],
      )
    : await pool.query(
        `SELECT 1 FROM "BuyingCenterMitglied" m
           JOIN "BuyingCenter" b ON b."id" = m."buyingCenterId"
          WHERE b."tenantId" = $1 AND b."eigentuemerActorId" = $2 AND b."status" = 'aktiv'
            AND m."personId" = $3 LIMIT 1`,
        [tenantId, actorId, ziel.zielId],
      );
  return (r.rowCount ?? 0) > 0;
}

async function werteNeu(
  tenantId: string,
  actorId: string,
  ziele: Array<{ zielArt: string; zielId: string }>,
  gewichte: Map<string, number>,
  jetzt: Date,
): Promise<void> {
  const pool = getGatewayPool();
  for (const ziel of ziele) {
    const r = await pool.query(
      `SELECT "art", "punkte", "halbwertT", "zeitpunkt"
         FROM "RelevanzSignal"
        WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = $3 AND "zielId" = $4
        ORDER BY "zeitpunkt" DESC
        LIMIT 500`,
      [tenantId, actorId, ziel.zielArt, ziel.zielId],
    );
    const signale: Signal[] = r.rows.map((row: Record<string, unknown>) => ({
      art: String(row.art),
      punkte: Number(row.punkte),
      halbwertT: Number(row.halbwertT),
      zeitpunkt: new Date(row.zeitpunkt as string),
    }));

    let naehe = berechneNaehe(signale, jetzt);

    // Personen erben die halbe Naehe ihrer Firma als Untergrenze. Gesucht
    // wird die Firma ueber das juengste Signal, das eine mitgeschickt hat.
    if (ziel.zielArt === "person") {
      const f = await pool.query(
        `SELECT "firmaId" FROM "RelevanzSignal"
          WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = 'person'
            AND "zielId" = $3 AND "firmaId" IS NOT NULL
          ORDER BY "zeitpunkt" DESC LIMIT 1`,
        [tenantId, actorId, ziel.zielId],
      );
      const firmaId = f.rows[0]?.firmaId as string | undefined;
      if (firmaId) {
        const fw = await pool.query(
          `SELECT "naehe" FROM "RelevanzWert"
            WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = 'firma' AND "zielId" = $3`,
          [tenantId, actorId, firmaId],
        );
        if (fw.rows[0]) naehe = naeheMitVererbung(naehe, Number(fw.rows[0].naehe));
      }
    }

    // BC5: Fokuskunden und ihre Buying-Center-Mitglieder sind nie kalt.
    naehe = naeheMitFokus(naehe, await istFokus(pool, tenantId, actorId, ziel));

    const schluessel = `${ziel.zielArt}:${ziel.zielId}`;
    const gewicht = gewichte.get(schluessel) ?? 1;
    const letztes = signale[0]?.zeitpunkt ?? null;

    await pool.query(
      `INSERT INTO "RelevanzWert"
         ("tenantId","actorId","zielArt","zielId","naehe","gewicht","rang","begruendung","letztesSignal","berechnet")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW())
       ON CONFLICT ("tenantId","actorId","zielArt","zielId") DO UPDATE SET
         "naehe" = EXCLUDED."naehe",
         -- Ein Buendel ohne Gewicht darf ein frueher gemeldetes nicht
         -- ueberschreiben: sonst faellt die Passung auf 1 zurueck, sobald
         -- ein Signal ohne ICP-Wert eintrifft.
         "gewicht" = CASE WHEN $6 > 1 THEN EXCLUDED."gewicht" ELSE "RelevanzWert"."gewicht" END,
         "rang" = EXCLUDED."rang",
         "begruendung" = EXCLUDED."begruendung",
         "letztesSignal" = EXCLUDED."letztesSignal",
         "berechnet" = NOW()`,
      [
        tenantId, actorId, ziel.zielArt, ziel.zielId,
        naehe, gewicht, berechneRang(naehe, gewicht, null),
        JSON.stringify(berechneBegruendung(signale, jetzt)),
        letztes,
      ],
    );
  }
}

// ---- POST /relevanz/signale ------------------------------------------------

const SignalEingang = z.object({
  /** Vom Geraet vergebene Kennung: macht den Versand wiederholbar. */
  geraetRef: z.string().min(8).max(80),
  zielArt: ZielArt,
  zielId: z.string().min(1).max(200),
  firmaId: z.string().max(200).nullable().optional(),
  art: z.string().min(1).max(60),
  punkte: z.number().min(-50).max(50),
  halbwertT: z.number().min(0).max(1000),
  zeitpunkt: z.string().datetime(),
  /** Sachliche Passung, lokal gebildet (1..10). Optional. */
  gewicht: z.number().min(1).max(10).optional(),
});

const schreibRoute = createRoute({
  method: "post",
  path: "/relevanz/signale",
  tags: [tag],
  summary: "Signale buendelweise schreiben",
  request: {
    body: { content: { "application/json": { schema: z.object({ signale: z.array(SignalEingang).min(1).max(200) }) } } },
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ angenommen: z.number(), doppelt: z.number() }) } }, description: "ok" },
    ...errorResponses,
  },
});

relevanzRouter.openapi(schreibRoute, async (c) => {
  const { tenantId, actorId } = auth(c);
  const { signale } = c.req.valid("json");
  const pool = getGatewayPool();
  const jetzt = new Date();

  // Gesperrte Ziele: Nach dem Entfernen einer Firma aus der Uebersicht soll
  // sie nicht durch Nebenwirkungen wieder warm werden.
  const gesperrt = new Set<string>();
  const sperren = await pool.query(
    `SELECT "zielArt","zielId" FROM "RelevanzSperre"
      WHERE "tenantId" = $1 AND "actorId" = $2 AND "bis" > NOW()`,
    [tenantId, actorId],
  );
  for (const row of sperren.rows) gesperrt.add(`${row.zielArt}:${row.zielId}`);

  let angenommen = 0;
  let doppelt = 0;
  const betroffen = new Map<string, { zielArt: string; zielId: string }>();
  const gewichte = new Map<string, number>();

  for (const s of signale) {
    const schluessel = `${s.zielArt}:${s.zielId}`;
    if (gesperrt.has(schluessel)) continue;
    const r = await pool.query(
      `INSERT INTO "RelevanzSignal"
         ("tenantId","actorId","geraetRef","zielArt","zielId","firmaId","art","punkte","halbwertT","zeitpunkt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT ("actorId","geraetRef") DO NOTHING
       RETURNING "id"`,
      [
        tenantId, actorId, s.geraetRef, s.zielArt, s.zielId,
        s.firmaId ?? null, s.art, s.punkte, s.halbwertT, new Date(s.zeitpunkt),
      ],
    );
    if (r.rowCount === 0) { doppelt++; continue; }
    angenommen++;
    betroffen.set(schluessel, { zielArt: s.zielArt, zielId: s.zielId });
    if (s.gewicht !== undefined) gewichte.set(schluessel, s.gewicht);
  }

  if (betroffen.size > 0) {
    // Firmen zuerst: Personen erben deren Wert, und eine veraltete
    // Firmen-Naehe wuerde sich sonst in die Person fortpflanzen.
    const ziele = Array.from(betroffen.values()).sort((a, b) =>
      a.zielArt === b.zielArt ? 0 : a.zielArt === "firma" ? -1 : 1,
    );
    try {
      await werteNeu(tenantId, actorId, ziele, gewichte, jetzt);
    } catch (err) {
      // Die Signale liegen bereits; ein misslungener Neuaufbau holt sich
      // der naechste Lauf. Der Versand darf deshalb nicht scheitern.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), ziele: ziele.length },
        "[relevanz] Neuberechnung fehlgeschlagen",
      );
    }
  }

  return c.json({ angenommen, doppelt }, 200);
});

// ---- GET /relevanz ---------------------------------------------------------

const WertShape = z.object({
  zielArt: ZielArt,
  zielId: z.string(),
  naehe: z.number(),
  gewicht: z.number(),
  rang: z.number(),
  begruendung: z.array(z.object({ art: z.string(), anteil: z.number(), anzahl: z.number() })),
  letztesSignal: z.string().nullable(),
});

const leseRoute = createRoute({
  method: "get",
  path: "/relevanz",
  tags: [tag],
  summary: "Werte bestimmter Ziele",
  request: {
    query: z.object({
      zielArt: ZielArt.optional(),
      /** Bis zu 200 IDs, mit Komma getrennt. */
      ids: z.string().max(20000).optional(),
      limit: z.coerce.number().min(1).max(500).optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ werte: z.array(WertShape) }) } }, description: "ok" },
    ...errorResponses,
  },
});

relevanzRouter.openapi(leseRoute, async (c) => {
  const { tenantId, actorId } = auth(c);
  const { zielArt, ids, limit } = c.req.valid("query");
  const liste = (ids ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);

  const bedingungen = [`"tenantId" = $1`, `"actorId" = $2`];
  const werte: unknown[] = [tenantId, actorId];
  if (zielArt) { werte.push(zielArt); bedingungen.push(`"zielArt" = $${werte.length}`); }
  if (liste.length > 0) { werte.push(liste); bedingungen.push(`"zielId" = ANY($${werte.length}::text[])`); }
  werte.push(limit ?? 200);

  const r = await getGatewayPool().query(
    `SELECT "zielArt","zielId","naehe","gewicht","rang","begruendung","letztesSignal"
       FROM "RelevanzWert" WHERE ${bedingungen.join(" AND ")}
      ORDER BY "rang" DESC LIMIT $${werte.length}`,
    werte,
  );
  return c.json({ werte: r.rows.map(zeileZuWert) }, 200);
});

function zeileZuWert(row: Record<string, unknown>): z.infer<typeof WertShape> {
  return {
    zielArt: String(row.zielArt) as "firma" | "person",
    zielId: String(row.zielId),
    naehe: Number(row.naehe),
    gewicht: Number(row.gewicht),
    rang: Number(row.rang),
    begruendung: (row.begruendung as Array<{ art: string; anteil: number; anzahl: number }>) ?? [],
    letztesSignal: row.letztesSignal ? new Date(row.letztesSignal as string).toISOString() : null,
  };
}

// ---- GET /relevanz/vorschau ------------------------------------------------

const vorschauRoute = createRoute({
  method: "get",
  path: "/relevanz/vorschau",
  tags: [tag],
  summary: "Arbeitsvorschau des Heartbeats, nach Rang",
  request: { query: z.object({ zielArt: ZielArt.optional(), limit: z.coerce.number().min(1).max(200).optional() }) },
  responses: {
    200: { content: { "application/json": { schema: z.object({ werte: z.array(WertShape) }) } }, description: "ok" },
    ...errorResponses,
  },
});

relevanzRouter.openapi(vorschauRoute, async (c) => {
  const { tenantId, actorId } = auth(c);
  const { zielArt, limit } = c.req.valid("query");
  const r = await getGatewayPool().query(
    `SELECT "zielArt","zielId","naehe","gewicht","rang","begruendung","letztesSignal"
       FROM "RelevanzWert"
      WHERE "tenantId" = $1 AND "actorId" = $2 AND ($3::text IS NULL OR "zielArt" = $3)
      ORDER BY "rang" DESC, "letztesSignal" DESC NULLS LAST
      LIMIT $4`,
    [tenantId, actorId, zielArt ?? null, limit ?? 50],
  );
  return c.json({ werte: r.rows.map(zeileZuWert) }, 200);
});

// ---- GET /relevanz/signale (Einsicht) --------------------------------------

const einsichtRoute = createRoute({
  method: "get",
  path: "/relevanz/signale",
  tags: [tag],
  summary: "Rohsignale eines Ziels — Einsicht fuer den Nutzer",
  request: {
    query: z.object({
      zielArt: ZielArt.optional(),
      zielId: z.string().max(200).optional(),
      limit: z.coerce.number().min(1).max(1000).optional(),
    }),
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            signale: z.array(z.object({
              zielArt: ZielArt, zielId: z.string(), firmaId: z.string().nullable(),
              art: z.string(), punkte: z.number(), zeitpunkt: z.string(),
            })),
          }),
        },
      },
      description: "ok",
    },
    ...errorResponses,
  },
});

relevanzRouter.openapi(einsichtRoute, async (c) => {
  const { tenantId, actorId } = auth(c);
  const { zielArt, zielId, limit } = c.req.valid("query");
  const r = await getGatewayPool().query(
    `SELECT "zielArt","zielId","firmaId","art","punkte","zeitpunkt"
       FROM "RelevanzSignal"
      WHERE "tenantId" = $1 AND "actorId" = $2
        AND ($3::text IS NULL OR "zielArt" = $3)
        AND ($4::text IS NULL OR "zielId" = $4)
      ORDER BY "zeitpunkt" DESC LIMIT $5`,
    [tenantId, actorId, zielArt ?? null, zielId ?? null, limit ?? 200],
  );
  return c.json({
    signale: r.rows.map((row: Record<string, unknown>) => ({
      zielArt: String(row.zielArt) as "firma" | "person",
      zielId: String(row.zielId),
      firmaId: (row.firmaId as string | null) ?? null,
      art: String(row.art),
      punkte: Number(row.punkte),
      zeitpunkt: new Date(row.zeitpunkt as string).toISOString(),
    })),
  }, 200);
});

// ---- DELETE /relevanz/signale ----------------------------------------------

const vergessenRoute = createRoute({
  method: "delete",
  path: "/relevanz/signale",
  tags: [tag],
  summary: "Alles oder ein einzelnes Ziel vergessen",
  request: {
    query: z.object({
      zielArt: ZielArt.optional(),
      zielId: z.string().max(200).optional(),
      /** Nach dem Entfernen einer Firma: so viele Tage nicht wieder aufwaermen. */
      sperreTage: z.coerce.number().min(0).max(365).optional(),
    }),
  },
  responses: {
    200: { content: { "application/json": { schema: z.object({ geloescht: z.number() }) } }, description: "ok" },
    ...errorResponses,
  },
});

relevanzRouter.openapi(vergessenRoute, async (c) => {
  const { tenantId, actorId } = auth(c);
  const { zielArt, zielId, sperreTage } = c.req.valid("query");
  const pool = getGatewayPool();

  const s = await pool.query(
    `DELETE FROM "RelevanzSignal"
      WHERE "tenantId" = $1 AND "actorId" = $2
        AND ($3::text IS NULL OR "zielArt" = $3)
        AND ($4::text IS NULL OR "zielId" = $4)`,
    [tenantId, actorId, zielArt ?? null, zielId ?? null],
  );
  await pool.query(
    `DELETE FROM "RelevanzWert"
      WHERE "tenantId" = $1 AND "actorId" = $2
        AND ($3::text IS NULL OR "zielArt" = $3)
        AND ($4::text IS NULL OR "zielId" = $4)`,
    [tenantId, actorId, zielArt ?? null, zielId ?? null],
  );
  if (sperreTage && sperreTage > 0 && zielArt && zielId) {
    await pool.query(
      `INSERT INTO "RelevanzSperre" ("tenantId","actorId","zielArt","zielId","bis")
       VALUES ($1,$2,$3,$4, NOW() + ($5 || ' days')::interval)
       ON CONFLICT ("tenantId","actorId","zielArt","zielId")
       DO UPDATE SET "bis" = EXCLUDED."bis"`,
      [tenantId, actorId, zielArt, zielId, String(sperreTage)],
    );
  }
  return c.json({ geloescht: s.rowCount ?? 0 }, 200);
});

// ---- GET /relevanz/thema (Organisationsaggregat) ---------------------------
//
// Die EINZIGE Abfrage ueber Nutzer hinweg — und sie liefert nur eine Anzahl.
// Drei Schranken gegen Rueckschluss auf Einzelne (Plan 10.2):
//   1. erst ab 2 Mitgliedern mit warmem Wert,
//   2. nur in Organisationen ab 3 Mitgliedern,
//   3. kein Verlauf, keine Zeitreihe.
// Namen gibt es hier nicht und sollen hier nicht hin: Das waere eine
// Auswertung einzelner Mitarbeiter durch ihre Kollegen.

const MIN_WARME_MITGLIEDER = 2;
const MIN_ORG_GROESSE = 3;

const themaRoute = createRoute({
  method: "get",
  path: "/relevanz/thema",
  tags: [tag],
  summary: "Welche Firmen die Organisation gerade beschaeftigen (Anzahl, ohne Namen)",
  request: { query: z.object({ limit: z.coerce.number().min(1).max(200).optional() }) },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            verfuegbar: z.boolean(),
            grund: z.string().nullable(),
            firmen: z.array(z.object({ companyId: z.string(), anzahl: z.number(), zuletzt: z.string().nullable() })),
          }),
        },
      },
      description: "ok",
    },
    ...errorResponses,
  },
});

relevanzRouter.openapi(themaRoute, async (c) => {
  const { tenantId } = auth(c);
  const pool = getGatewayPool();
  const leer = (grund: string) => c.json({ verfuegbar: false, grund, firmen: [] }, 200);

  const policy = await pool.query(
    `SELECT "features", "relevanzThemaSichtbar" FROM "TenantPolicy" WHERE "tenantId" = $1`,
    [tenantId],
  );
  const p = policy.rows[0] as { features?: Record<string, boolean>; relevanzThemaSichtbar?: boolean } | undefined;
  // Fehlender Schluessel heisst wie ueberall: erlaubt.
  if (p?.features?.relevanz === false) return leer("funktion_abgeschaltet");
  if (p?.relevanzThemaSichtbar === false) return leer("aggregat_abgeschaltet");

  const groesse = await pool.query(
    `SELECT COUNT(*)::int AS n FROM "TenantMember" WHERE "tenantId" = $1`,
    [tenantId],
  );
  if ((groesse.rows[0]?.n ?? 0) < MIN_ORG_GROESSE) return leer("organisation_zu_klein");

  const r = await pool.query(
    `SELECT "zielId" AS "companyId",
            COUNT(DISTINCT "actorId")::int AS "anzahl",
            MAX("letztesSignal") AS "zuletzt"
       FROM "RelevanzWert"
      WHERE "tenantId" = $1 AND "zielArt" = 'firma' AND "naehe" >= $2
      GROUP BY "zielId"
     HAVING COUNT(DISTINCT "actorId") >= $3
      ORDER BY "anzahl" DESC, MAX("letztesSignal") DESC NULLS LAST
      LIMIT $4`,
    [tenantId, WARM_AB, MIN_WARME_MITGLIEDER, c.req.valid("query").limit ?? 50],
  );

  return c.json({
    verfuegbar: true,
    grund: null,
    firmen: r.rows.map((row: Record<string, unknown>) => ({
      companyId: String(row.companyId),
      anzahl: Number(row.anzahl),
      zuletzt: row.zuletzt ? new Date(row.zuletzt as string).toISOString() : null,
    })),
  }, 200);
});
