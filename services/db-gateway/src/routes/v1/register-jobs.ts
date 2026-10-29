// Register-Delta S3 — Worker-Schnittstelle (Desktop "Mithelfen", S6) und
// Status fuer die Systemseite. Betreiber-Fallback (S5) nutzt dieselben
// Routen mit einem Dienstkonto.
//
//   POST /register-jobs/lease           Job holen (oder 204)
//   POST /register-jobs/{id}/ergebnis   Ergebnis melden
//   POST /register-jobs/{id}/fehler     Fehler melden (Job faellt zurueck)
//   GET  /register-jobs/status          Queue-Statistik
//   POST /register-jobs/refresh         Auffrischung fuer konkrete Blaetter anfordern

import { logger } from "../../lib/logger";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { requireScope } from "../../middleware/auth";
import { getGatewayPool } from "../../lib/producer-pools";
import {
  abfragenJeStundeFuer,
  atAnfordern,
  ukAnfordern,
  verarbeiteTeilergebnis,
  JOB_ARTEN_REGISTER,
  JobFehler,
  leaseJob,
  meldeFehler,
  refreshAnfordern,
  insolvenzAnfordern,
  insolvenzFaellige,
  registriereWorker,
  statistik,
  verarbeiteErgebnis,
  type JobArt,
  schreibeTreffer, chAnfordern, noAnfordern, fiAnfordern } from "../../lib/register-jobs";
import { companyIdAus } from "../../lib/register-ids";
import { ErrorShape } from "./schemas";

export const registerJobsRouter = new OpenAPIHono();
registerJobsRouter.use("*", requireScope("company:read"));

const tag = "register-jobs";
const err = {
  401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
  404: { content: { "application/json": { schema: ErrorShape } }, description: "not found" },
  409: { content: { "application/json": { schema: ErrorShape } }, description: "lease invalid" },
};

export const WorkerId = z.string().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/);
export const JobArtSchema = z.enum(["front", "bekanntmachungen", "refresh", "insolvenz", "at_front", "at_refresh", "at_insolvenz", "uk_bulk", "uk_refresh", "uk_insolvenz", "ch_bulk", "ch_sogc", "ch_refresh", "no_bulk", "no_oppdatering", "no_refresh", "fi_bulk", "fi_neu", "fi_refresh"]);

const JobShape = z
  .object({
    id: z.string(),
    art: JobArtSchema,
    schluessel: z.string(),
    payload: z.record(z.string(), z.unknown()),
    prioritaet: z.number().int(),
    leaseUntil: z.string().nullable(),
    versuche: z.number().int(),
    /** Budget-Hinweis fuer den Worker (Nutzungsordnung). */
    abfragenJeStunde: z.number().int(),
  })
  .openapi("RegisterJob");

/** refresh (S8): strukturierter Registerinhalt aus dem SI-Abruf (Paket register-delta, si-parser.ts). */
const SiShape = z.object({
  name: z.string().min(1).max(500),
  legalForm: z.string().max(200).default(""),
  street: z.string().max(200).default(""),
  houseNumber: z.string().max(40).default(""),
  zipCode: z.string().max(20).default(""),
  city: z.string().max(120).default(""),
  foundingYear: z.number().int().min(1000).max(2100).nullable().default(null),
  corporatePurpose: z.string().max(20_000).nullable().default(null),
  shareCapital: z.number().nonnegative().nullable().default(null),
  lastRegisterEntry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  lastRegisterModification: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  managingDirectors: z
    .array(z.object({ firstName: z.string().max(200).default(""), lastName: z.string().min(1).max(200), birthDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null), city: z.string().max(120).nullable().default(null) }))
    .max(200)
    .default([]),
});

const TrefferShape = z.object({
  gericht: z.string().min(1),
  art: z.string().min(2).max(4),
  nummer: z.number().int().nonnegative(),
  zusatz: z.string().max(3).default(""),
  frueher: z.string().max(80).default(""),
  bundesland: z.string().min(1),
  name: z.string().min(1),
  sitz: z.string().default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  historie: z.array(z.object({ name: z.string(), sitz: z.string().default(""), order: z.number().int() })).default([]),
  // `catch` ist hier wesentlich: Ein Registerauszug, der nicht ins Schema passt
  // (unsinnige Jahreszahl, uebermaessig langer Text), darf niemals die ganze
  // Ergebnismeldung ungueltig machen. Sonst verliert der Job auch seine
  // Registertreffer und wird endlos wiederholt (Befund 2026-09-17: Job 1725
  // scheiterte in Schleife mit 400 und verbrannte je Lauf 14 Abfragen).
  si: SiShape.optional().catch(undefined),
});

const BekanntmachungShape = z.object({
  datum: z.string(),
  kategorie: z.string(),
  bundesland: z.string().nullable().default(null),
  gericht: z.string().nullable().default(null),
  art: z.string().nullable().default(null),
  nummer: z.number().int().nullable().default(null),
  zusatz: z.string().default(""),
  frueher: z.string().default(""),
  firma: z.string().default(""),
  sitz: z.string().default(""),
});

const InsolvenzMeldungShape = z.object({
  companyId: z.string().min(3),
  aktenzeichen: z.string().min(1).max(60),
  insolvenzgericht: z.string().min(1).max(80),
  datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gegenstand: z.enum(["EROEFFNUNG", "ABWEISUNG_MANGELS_MASSE", "SICHERUNGSMASSNAHME", "AUFHEBUNG", "EINSTELLUNG", "ENTSCHEIDUNG", "VERTEILUNG", "INSOLVENZPLAN", "SONSTIGES"]),
  text: z.string().max(50_000).default(""),
  quelle: z.enum(["insolvenzportal", "ediktsdatei", "companieshouse", "gazette"]).optional(),
});

/** UK: Zeile des Bulk-Abzugs oder der Firmenseite (Paket register-delta, uk-companies-house.ts). */
const TrefferUkShape = z.object({
  nummer: z.string().regex(/^[A-Z0-9]{1,8}$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200),
  behoerde: z.string().min(1).max(200),
  landesteil: z.string().max(100),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  insolvenz: z.enum(["NONE", "VERDACHT", "EROEFFNET"]),
  legalForm: z.string().max(200).nullable().optional(),
  street: z.string().max(200).nullable().optional(),
  zipCode: z.string().max(20).nullable().optional(),
  incorporatedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  sicCodes: z.array(z.string().regex(/^\d{4,5}$/)).max(4).optional(),
  fruehereNamen: z.array(z.string().max(500)).max(10).optional(),
});

/** Schweiz: Zeile aus LINDAS (ch_bulk), SHAB-Tagesabzug (ch_sogc) oder Zefix-Detail (ch_refresh); Paket register-delta, ch-zefix.ts. */
const TrefferChShape = z.object({
  uid: z.string().regex(/^CHE\d{9}$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200).default(""),
  kanton: z.string().max(10).default(""),
  amt: z.string().max(200).default(""),
  legalForm: z.string().max(200).default(""),
  legalFormCode: z.string().max(10).default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  insolvenz: z.enum(["NONE", "VERDACHT", "EROEFFNET"]),
  street: z.string().max(200).nullable().optional(),
  zipCode: z.string().max(20).nullable().optional(),
  sogcDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  fruehereNamen: z.array(z.string().max(500)).max(10).optional(),
  si: z
    .object({
      legalForm: z.string().max(200),
      street: z.string().max(200),
      houseNumber: z.string().max(40),
      zipCode: z.string().max(20),
      city: z.string().max(200),
      foundingYear: z.number().int().nullable(),
      corporatePurpose: z.string().max(20_000).nullable(),
      shareCapital: z.number().nullable(),
      capitalCurrency: z.string().max(10).nullable(),
      lastRegisterEntry: z.string().max(40).nullable(),
      cantonalExcerptWeb: z.string().max(1000).nullable(),
    })
    .optional(),
});

/** Norwegen: Einheit aus Gesamtdownload (no_bulk), Aenderungsfeed (no_oppdatering) oder Detail mit Rollen (no_refresh); Paket register-delta, no-brreg.ts. */
const TrefferNoShape = z.object({
  orgnr: z.string().regex(/^\d{9}$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200).default(""),
  kommune: z.string().max(120).default(""),
  fylke: z.string().max(60).default(""),
  legalForm: z.string().max(20).default(""),
  legalFormLang: z.string().max(200).default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  insolvenz: z.enum(["NONE", "VERDACHT", "EROEFFNET"]),
  street: z.string().max(200).nullable().optional(),
  zipCode: z.string().max(20).nullable().optional(),
  mva: z.boolean().default(false),
  nace: z.string().max(20).nullable().optional(),
  gegruendet: z.string().max(40).nullable().optional(),
  fruehereNamen: z.array(z.string().max(500)).max(10).optional(),
  si: z
    .object({
      legalForm: z.string().max(200),
      street: z.string().max(200),
      houseNumber: z.string().max(40),
      zipCode: z.string().max(20),
      city: z.string().max(200),
      foundingYear: z.number().int().nullable(),
      corporatePurpose: z.string().max(20_000).nullable(),
      shareCapital: z.number().nullable(),
      capitalCurrency: z.string().max(10).nullable(),
      lastRegisterEntry: z.string().max(40).nullable(),
      managingDirectors: z.array(z.object({ firstName: z.string().max(120), lastName: z.string().min(1).max(120), birthDay: z.string().max(20).nullable(), rolle: z.string().max(120) })).max(50),
    })
    .optional(),
});

/** Finnland: Firma aus PRH Open Data (fi_bulk, fi_neu, fi_refresh); Paket register-delta, fi-prh.ts. */
const TrefferFiShape = z.object({
  businessId: z.string().regex(/^\d{7}-\d$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200).default(""),
  legalForm: z.string().max(20).default(""),
  legalFormLang: z.string().max(200).default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]),
  insolvenz: z.enum(["NONE", "VERDACHT", "EROEFFNET"]),
  street: z.string().max(200).nullable().optional(),
  zipCode: z.string().max(20).nullable().optional(),
  website: z.string().max(300).nullable().optional(),
  nace: z.string().max(20).nullable().optional(),
  gegruendet: z.string().max(40).nullable().optional(),
  fruehereNamen: z.array(z.string().max(500)).max(10).optional(),
  si: z.object({ legalForm: z.string().max(200), street: z.string().max(200), houseNumber: z.string().max(40), zipCode: z.string().max(20), city: z.string().max(200), foundingYear: z.number().int().nullable(), corporatePurpose: z.string().max(20_000).nullable(), lastRegisterEntry: z.string().max(40).nullable() }).optional(),
});

export const TeilergebnisShape = z
  .object({ workerId: WorkerId, teil: z.number().int().positive(), trefferUk: z.array(TrefferUkShape).min(1).max(1000).optional(), trefferCh: z.array(TrefferChShape).min(1).max(5000).optional(), trefferNo: z.array(TrefferNoShape).min(1).max(5000).optional(), trefferFi: z.array(TrefferFiShape).min(1).max(5000).optional() })
  .refine((t) => !!t.trefferUk || !!t.trefferCh || !!t.trefferNo || !!t.trefferFi, { message: "trefferUk, trefferCh, trefferNo oder trefferFi" });

/** Oesterreich: Suchtreffer oder Detail aus JustizOnline (Paket register-delta, at-firmenbuch.ts). */
const TrefferAtShape = z.object({
  fnr: z.string().regex(/^\d{1,6}[a-z]$/),
  name: z.string().min(1).max(500),
  sitz: z.string().max(200).default(""),
  status: z.enum(["ACTIVE", "CLOSED"]),
  gericht: z.string().min(1).max(200),
  bundesland: z.string().max(100).default(""),
  legalForm: z.string().max(200).nullable().optional(),
  uid: z.string().max(40).nullable().optional(),
});

export const ErgebnisShape = z.object({
  workerId: WorkerId,
  abfragen: z.number().int().nonnegative(),
  gesperrt: z.boolean().optional(),
  treffer: z.array(TrefferShape).max(5000).default([]),
  insolvenz: z.object({ meldungen: z.array(InsolvenzMeldungShape).max(2000), geprueft: z.array(z.string()).max(2000) }).optional(),
  front: z.object({ maxNummer: z.number().int().nonnegative(), offeneLuecken: z.array(z.number().int()).max(500), zusaetze: z.array(z.string()).optional() }).optional(),
  bekanntmachungen: z.array(BekanntmachungShape).max(5000).optional(),
  trefferAt: z.array(TrefferAtShape).max(5000).optional(),
  atFront: z.object({ begriff: z.string().min(2).max(4), naechsteSeite: z.number().int().nonnegative(), fertig: z.boolean(), gesamt: z.number().int().nonnegative() }).optional(),
  trefferUk: z.array(TrefferUkShape).max(5000).optional(),
  ukBulk: z.object({ datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), teil: z.number().int().positive(), teile: z.number().int().positive(), zeilen: z.number().int().nonnegative(), teilergebnisse: z.number().int().nonnegative() }).optional(),
  trefferCh: z.array(TrefferChShape).max(5000).optional(),
  trefferNo: z.array(TrefferNoShape).max(5000).optional(),
  noBulk: z.object({ datum: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), zeilen: z.number().int().nonnegative(), teilergebnisse: z.number().int().nonnegative() }).optional(),
  trefferFi: z.array(TrefferFiShape).max(5000).optional(),
  fiBulk: z.object({ von: z.string().max(10), bis: z.string().max(10), gesamt: z.number().int().nonnegative(), zeilen: z.number().int().nonnegative(), teilergebnisse: z.number().int().nonnegative() }).optional(),
  chBulk: z.object({ offset: z.number().int().nonnegative(), limit: z.number().int().positive(), zeilen: z.number().int().nonnegative(), teilergebnisse: z.number().int().nonnegative(), letzteSeite: z.boolean() }).optional(),
  si: z.object({ geladen: z.number().int().nonnegative(), ohneLink: z.number().int().nonnegative(), fehler: z.number().int().nonnegative() }).optional().catch(undefined),
  // Wie bei `si`: Diese Angabe ist Komfort (Folgejob fuer den Rest). Sie darf
  // die Ergebnismeldung nie ungueltig machen.
  unbearbeitet: z
    .array(z.object({ gericht: z.string().min(1), art: z.string().min(2).max(4), nummer: z.number().int().nonnegative(), zusatz: z.string().max(3).optional(), hinweis: z.string().max(60).optional() }))
    .max(500)
    .optional()
    .catch(undefined),
});

function auth(c: { get: (k: "auth") => { tenantId: string; actorId: string } | undefined }) {
  const a = c.get("auth");
  if (!a?.tenantId) throw new HTTPException(401, { message: "auth_context_missing" });
  return a;
}

function jobFehler(e: unknown): never {
  if (e instanceof JobFehler) throw new HTTPException(e.status, { message: e.message });
  logger.error({ err: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split("\n").slice(0, 6).join(" | ") : undefined }, "[register-jobs] unerwarteter Fehler");
  throw e;
}

const leaseRoute = createRoute({
  method: "post",
  path: "/register-jobs/lease",
  tags: [tag],
  summary: "Naechsten Register-Job leasen (20 Minuten)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ workerId: WorkerId, arten: z.array(JobArtSchema).optional(), workerArt: z.enum(["desktop", "betreiber"]).default("desktop") }),
        },
      },
    },
  },
  responses: {
    200: { content: { "application/json": { schema: JobShape } }, description: "job" },
    204: { description: "kein Job offen" },
    ...err,
  },
});
registerJobsRouter.openapi(leaseRoute, async (c) => {
  const a = auth(c);
  const body = c.req.valid("json");
  const pool = getGatewayPool();
  await registriereWorker(pool, body.workerId, a.tenantId, a.actorId, body.workerArt);
  const job = await leaseJob(pool, body.workerId, (body.arten as JobArt[] | undefined) ?? JOB_ARTEN_REGISTER);
  if (!job) return c.body(null, 204);
  return c.json(
    { id: job.id, art: job.art, schluessel: job.schluessel, payload: job.payload, prioritaet: job.prioritaet, leaseUntil: job.leaseUntil, versuche: job.versuche, abfragenJeStunde: abfragenJeStundeFuer(job.art) },
    200,
  );
});

const ergebnisRoute = createRoute({
  method: "post",
  path: "/register-jobs/{id}/ergebnis",
  tags: [tag],
  summary: "Ergebnis eines Register-Jobs melden",
  request: { params: z.object({ id: z.string().regex(/^\d+$/) }), body: { content: { "application/json": { schema: ErgebnisShape } } } },
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "verarbeitet" }, ...err },
});
registerJobsRouter.openapi(ergebnisRoute, async (c) => {
  auth(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    return c.json(await verarbeiteErgebnis(getGatewayPool(), id, body), 200);
  } catch (e) {
    jobFehler(e);
  }
});

const fehlerRoute = createRoute({
  method: "post",
  path: "/register-jobs/{id}/fehler",
  tags: [tag],
  summary: "Fehler eines Register-Jobs melden; Job faellt in die Queue zurueck",
  request: {
    params: z.object({ id: z.string().regex(/^\d+$/) }),
    body: { content: { "application/json": { schema: z.object({ workerId: WorkerId, grund: z.string().min(1).max(500), abfragen: z.number().int().nonnegative().default(0) }) } } },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ status: z.string() }) } }, description: "ok" }, ...err },
});
registerJobsRouter.openapi(fehlerRoute, async (c) => {
  auth(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    return c.json(await meldeFehler(getGatewayPool(), id, body.workerId, body.grund, body.abfragen), 200);
  } catch (e) {
    jobFehler(e);
  }
});

const statusRoute = createRoute({
  method: "get",
  path: "/register-jobs/status",
  tags: [tag],
  summary: "Statistik der Register-Queue",
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(statusRoute, async (c) => {
  auth(c);
  return c.json(await statistik(getGatewayPool()), 200);
});

const refreshRoute = createRoute({
  method: "post",
  path: "/register-jobs/refresh",
  tags: [tag],
  summary: "Auffrischung konkreter Registerblaetter anfordern (Buendel zu 25)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            firmen: z.array(z.object({ gericht: z.string().min(1), art: z.string().min(2).max(4), nummer: z.number().int().nonnegative(), zusatz: z.string().max(3).optional() })).min(1).max(500),
            grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung"),
          }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(refreshRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json({ jobs: await refreshAnfordern(getGatewayPool(), body.firmen, body.grund) }, 200);
});

// Live-Namenssuche (docs/PLAN_FIRMEN_OHNE_REGISTER.md, F2): Der Desktop hat im
// Registerportal nach einem Firmennamen gesucht; die Treffer kommen wie bei
// einem Worker-Job in die Stammdaten (source registerportal) und liefern die
// companyIds fuer den Import. Kein Job, kein Lease.
const TrefferEingabe = z.object({
  gericht: z.string().min(1),
  art: z.string().min(2).max(4),
  nummer: z.number().int().nonnegative(),
  zusatz: z.string().max(12).default(""),
  frueher: z.string().max(80).default(""),
  frueherSuffix: z.boolean().optional(),
  bundesland: z.string().max(40).default(""),
  name: z.string().min(1).max(400),
  sitz: z.string().max(200).default(""),
  status: z.enum(["ACTIVE", "CLOSED", "LOESCHUNG_ANGEKUENDIGT"]).default("ACTIVE"),
  historie: z.array(z.object({ name: z.string(), sitz: z.string(), order: z.number().int() })).default([]),
});
const trefferRoute = createRoute({
  method: "post",
  path: "/register-jobs/treffer",
  tags: [tag],
  summary: "Treffer einer Live-Namenssuche in die Stammdaten uebernehmen (liefert companyIds)",
  request: { body: { content: { "application/json": { schema: z.object({ treffer: z.array(TrefferEingabe).min(1).max(100) }) } } } },
  responses: {
    200: {
      content: { "application/json": { schema: z.object({ neu: z.number().int(), geaendert: z.number().int(), unveraendert: z.number().int(), firmen: z.array(z.object({ companyId: z.string(), name: z.string(), sitz: z.string(), status: z.string() })) }) } },
      description: "ok",
    },
    401: err[401],
  },
});
registerJobsRouter.openapi(trefferRoute, async (c) => {
  auth(c);
  const { treffer } = c.req.valid("json");
  const summe = await schreibeTreffer(treffer, "registerportal");
  const firmen = treffer.map((t) => ({ companyId: companyIdAus(t.gericht, t.art, t.nummer, t.zusatz, t.frueher, t.frueherSuffix === true), name: t.name, sitz: t.sitz, status: t.status }));
  return c.json({ neu: summe.neu, geaendert: summe.geaendert, unveraendert: summe.unveraendert, firmen }, 200);
});

// Insolvenz-Delta — Pruefung konkreter Firmen anfordern (Chat, Import, Firmendetail).
const insolvenzRoute = createRoute({
  method: "post",
  path: "/register-jobs/insolvenz",
  tags: [tag],
  summary: "Insolvenzpruefung fuer konkrete Firmen anfordern (Buendel zu 15, ohne Kadenz)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().min(3)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(insolvenzRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  const firmen = await insolvenzFaellige(body.companyIds, 0);
  return c.json({ jobs: await insolvenzAnfordern(getGatewayPool(), firmen, body.grund, 1), firmen: firmen.length }, 200);
});

// Oesterreich — Detail-Refresh und Ediktsdatei fuer konkrete Firmen anfordern (Chat, Import, Firmendetail).
const atRoute = createRoute({
  method: "post",
  path: "/register-jobs/at",
  tags: [tag],
  summary: "Oesterreich: Firmenbuch-Detail und Ediktsdatei fuer konkrete Firmen anfordern (AT_FN...)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().regex(/^AT_FN[1-9][0-9]{0,5}[A-Z]$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(atRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await atAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});

// UK — uk_bulk: Buendel Zeilen waehrend der Ausfuehrung melden (verlaengert die Lease, idempotent je Teilnummer).
const teilergebnisRoute = createRoute({
  method: "post",
  path: "/register-jobs/{id}/teilergebnis",
  tags: [tag],
  summary: "Teilergebnis eines uk_bulk-, ch_bulk- oder no_bulk-Jobs melden (Buendel)",
  request: { params: z.object({ id: z.string().regex(/^\d+$/) }), body: { content: { "application/json": { schema: TeilergebnisShape } } } },
  responses: { 200: { content: { "application/json": { schema: z.record(z.string(), z.unknown()) } }, description: "verarbeitet" }, ...err },
});
registerJobsRouter.openapi(teilergebnisRoute, async (c) => {
  auth(c);
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    return c.json(await verarbeiteTeilergebnis(getGatewayPool(), id, body), 200);
  } catch (e) {
    jobFehler(e);
  }
});

// UK — Firmenseite und Insolvenz fuer konkrete Firmen anfordern (Chat, Import, Firmendetail).
const ukRoute = createRoute({
  method: "post",
  path: "/register-jobs/uk",
  tags: [tag],
  summary: "UK: Companies-House-Firmenseite, Insolvenz und Gazette fuer konkrete Firmen anfordern (UK_...)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().regex(/^UK_[A-Z0-9]{8}$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(ukRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await ukAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});

// Schweiz — Zefix-Detail (Status, Adresse, Zweck, Kapital) fuer konkrete Firmen anfordern.
const chRoute = createRoute({
  method: "post",
  path: "/register-jobs/ch",
  tags: [tag],
  summary: "Schweiz: Zefix-Detail fuer konkrete Firmen anfordern (CH_CHE...)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().regex(/^CH_CHE\d{9}$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(chRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await chAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});

// Norwegen — Einheit plus Rollen fuer konkrete Firmen anfordern.
const noRoute = createRoute({
  method: "post",
  path: "/register-jobs/no",
  tags: [tag],
  summary: "Norwegen: Brreg-Einheit und Rollen fuer konkrete Firmen anfordern (NO_...)",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ companyIds: z.array(z.string().regex(/^NO_\d{9}$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }),
        },
      },
    },
  },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(noRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await noAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});

// Finnland — PRH-Firma fuer konkrete Firmen anfordern.
const fiRoute = createRoute({
  method: "post",
  path: "/register-jobs/fi",
  tags: [tag],
  summary: "Finnland: PRH-Firma fuer konkrete Firmen anfordern (FI_...)",
  request: { body: { content: { "application/json": { schema: z.object({ companyIds: z.array(z.string().regex(/^FI_\d{8}$/)).min(1).max(500), grund: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).default("anforderung") }) } } } },
  responses: { 200: { content: { "application/json": { schema: z.object({ jobs: z.number().int(), firmen: z.number().int() }) } }, description: "ok" }, 401: err[401] },
});
registerJobsRouter.openapi(fiRoute, async (c) => {
  auth(c);
  const body = c.req.valid("json");
  return c.json(await fiAnfordern(getGatewayPool(), body.companyIds, body.grund), 200);
});
