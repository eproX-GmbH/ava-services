// Neuheiten fuer den Desktop-Heartbeat (2026-10-05).
//
//   POST /alerts/neuheiten   { companyIds[], since } → alles, was sich an
//                            diesen Firmen seit `since` getan hat
//
// Vorher holte der Heartbeat je Firma drei Einzelabfragen und sah dabei
// nur die Firmen der 20 juengsten Transaktionen (bei Patrick 7 von 43).
// Jetzt schickt der Desktop seine ganze Firmenliste (aus /companies/matrix)
// in Buendeln und bekommt je Buendel EINE Antwort mit vier Quellen:
//
//   profile-change   ProfileChangeEvent (Gateway-DB): Geschaeftsfuehrer,
//                    Name, Rechtsform, Adresse, Kapital, Gegenstand
//   publication      CompanyPublication (Publikations-DB), nach Eingang
//   contact-change   SignalEvent (Kontakt-DB): Stellenwechsel, Arbeitgeber-
//                    wechsel, geaenderte Firmen-Telefon/-E-Mail
//   new-contacts     neue Beschaeftigungen je Firma, gebuendelt zu EINEM
//                    Eintrag (sonst flutet ein Re-Crawl den Judge)
//   new-customers    neue Kunden/Referenzen laut Website je Firma gebuendelt
//                    (docs/PLAN_KUNDEN.md K4), nur mit Kunden-Bestand
//
// Grundregel (Vorgabe 2026-10-05): Ein Erst-Crawl fuehrt NIE zu einer
// Neuheit, egal welche Daten er bringt. Jede Quelle prueft deshalb, ob die
// Firma vor `since` in dieser Quelle schon Bestand hatte (Publikationen,
// Ansprechpartner). ProfileChangeEvent entsteht im Persist ohnehin nur mit
// Bestand (Erstbefuellung = kein Wechsel).
//
// Das Zeitfenster ist auf 30 Tage gedeckelt: Der erste Takt nach einem
// Neustart kommt ohne `since`, und die Dedup-Liste im Desktop faengt
// Wiederholungen ab. Bewertet wird NICHT hier, sondern lokal beim Nutzer
// (Compute-Lokalitaet) durch den Alarm-Judge mit dessen Profil.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { getProducerPool } from "../../lib/producer-pools";
import { listeProfilAenderungen } from "../../lib/profile-changes";
import { getGatewayPool } from "../../lib/producer-pools";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const alertsNeuheitenRouter = new OpenAPIHono();
alertsNeuheitenRouter.use("*", requireScope("company:read"));

const tag = "alerts";
const FENSTER_TAGE = 30;
const MAX_FIRMEN = 500;
/**
 * Zeitbezug (Vorgabe 2026-10-05): Eine Meldung muss in zeitlichem
 * Zusammenhang stehen. Ist belegt, dass eine Position schon laenger als
 * so viele Tage besteht (seit/startDate), oder ist das Fenster, in dem
 * der Wechsel passiert sein kann (letzte Bestaetigung des alten Stands bis
 * Beobachtung des neuen), breiter als das, hat AVA den Wechsel nur spaet
 * bemerkt. Das ist keine Neuigkeit und erscheint gar nicht erst.
 */
const ZEITBEZUG_TAGE = 180;
const ZEITBEZUG_MS = ZEITBEZUG_TAGE * 86_400_000;

const Body = z.object({
  companyIds: z.array(z.string().min(1)).min(1).max(MAX_FIRMEN),
  since: z.string().datetime({ offset: true }).nullable().optional(),
});

const Volumen = z.object({ value: z.number().nullable(), currency: z.string().nullable() }).nullable();

const Item = z.discriminatedUnion("art", [
  z.object({
    art: z.literal("profile-change"),
    id: z.string(),
    companyId: z.string(),
    kind: z.string(),
    added: z.array(z.record(z.string(), z.unknown())),
    removed: z.array(z.record(z.string(), z.unknown())),
    occurredAt: z.string(),
    /** Letzte Bestaetigung des alten Stands; der Wechsel liegt dazwischen. */
    bestandVon: z.string().nullable(),
  }),
  z.object({
    art: z.literal("publication"),
    id: z.string(),
    companyId: z.string(),
    name: z.string().nullable(),
    year: z.number().nullable(),
    begin: z.string().nullable(),
    end: z.string().nullable(),
    employeeCount: z.number().nullable(),
    revenueVolume: Volumen,
    salesVolume: Volumen,
    totalAssetsVolume: Volumen,
    stateOfAffairs: z.object({ value: z.string() }).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  z.object({
    art: z.literal("contact-change"),
    id: z.string(),
    companyId: z.string(),
    typ: z.enum(["job-changed", "employer-changed", "company-phone-changed", "company-email-changed"]),
    personName: z.string().nullable(),
    title: z.string().nullable(),
    before: z.string().nullable(),
    after: z.string().nullable(),
    occurredAt: z.string(),
    /** Belegter Beginn der aktuellen Position (JJJJ-MM-01), wenn bekannt. */
    seit: z.string().nullable(),
    /** Seit wann die Person bei dieser Firma bekannt ist. */
    bekanntSeit: z.string().nullable(),
    /** Letzte Beobachtung des ALTEN Werts; der Wechsel liegt dazwischen. */
    vorherGesehenAm: z.string().nullable(),
  }),
  z.object({
    art: z.literal("new-customers"),
    id: z.string(),
    companyId: z.string(),
    anzahl: z.number(),
    kunden: z.array(
      z.object({
        name: z.string(),
        art: z.string(),
        match: z.object({ companyId: z.string(), name: z.string(), location: z.string().nullable() }).nullable(),
      }),
    ),
    occurredAt: z.string(),
  }),
  z.object({
    art: z.literal("new-contacts"),
    id: z.string(),
    companyId: z.string(),
    anzahl: z.number(),
    personen: z.array(z.object({ name: z.string(), title: z.string().nullable(), seit: z.string().nullable() })),
    occurredAt: z.string(),
  }),
]);
export type NeuheitItem = z.infer<typeof Item>;

const route = createRoute({
  method: "post",
  path: "/alerts/neuheiten",
  tags: [tag],
  summary: "Alle Neuheiten einer Firmenliste seit einem Zeitpunkt (Heartbeat-Buendel)",
  request: { body: { content: { "application/json": { schema: Body } }, required: true } },
  responses: {
    200: { content: { "application/json": { schema: z.object({ seit: z.string(), items: z.array(Item) }) } }, description: "ok" },
    400: { content: { "application/json": { schema: ErrorShape } }, description: "bad request" },
    401: { content: { "application/json": { schema: ErrorShape } }, description: "unauthenticated" },
    403: { content: { "application/json": { schema: ErrorShape } }, description: "forbidden" },
  },
});

function fensterStart(since: string | null | undefined): Date {
  const aeltestens = new Date(Date.now() - FENSTER_TAGE * 86_400_000);
  if (!since) return aeltestens;
  const d = new Date(since);
  if (Number.isNaN(d.getTime()) || d < aeltestens) return aeltestens;
  return d;
}

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function volumen(value: string | null, currency: string | null): { value: number | null; currency: string | null } | null {
  if (value == null) return null;
  const n = Number(value);
  return { value: Number.isFinite(n) ? n : null, currency };
}

const SIGNAL_TYPEN: Record<string, "job-changed" | "employer-changed" | "company-phone-changed" | "company-email-changed"> = {
  PERSON_JOB_CHANGED: "job-changed",
  PERSON_EMPLOYER_CHANGED: "employer-changed",
  COMPANY_PHONE_CHANGED: "company-phone-changed",
  COMPANY_EMAIL_CHANGED: "company-email-changed",
};

async function publikationen(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  const pool = getProducerPool("company-publication");
  const r = await pool.query<{
    id: number; companyId: string; name: string | null; year: number | null;
    begin: Date | null; end: Date | null; employeeCount: number | null;
    createdAt: Date; updatedAt: Date;
    salesValue: string | null; salesCurrency: string | null;
    revenueValue: string | null; revenueCurrency: string | null;
    totalAssetsValue: string | null; totalAssetsCurrency: string | null;
    soaTopic: string | null;
  }>(
    `SELECT cp.id, cp."companyId", cp.name, cp.year, cp."begin", cp."end",
            cp."employeeCount", cp."createdAt", cp."updatedAt",
            sv.value::text AS "salesValue", sv.currency AS "salesCurrency",
            rv.value::text AS "revenueValue", rv.currency AS "revenueCurrency",
            tv.value::text AS "totalAssetsValue", tv.currency AS "totalAssetsCurrency",
            soa.topic::text AS "soaTopic"
       FROM "CompanyPublication" cp
       LEFT JOIN "SalesVolume" sv ON sv."companyPublicationId" = cp.id
       LEFT JOIN "RevenueVolume" rv ON rv."companyPublicationId" = cp.id
       LEFT JOIN "TotalAssetsVolume" tv ON tv."companyPublicationId" = cp.id
       LEFT JOIN "StateOfAffairsAggregate" soa ON soa."companyPublicationId" = cp.id
      WHERE cp."companyId" = ANY($1::text[]) AND cp."createdAt" > $2
        -- Erst-Crawl ist keine Neuheit: nur Firmen, die vor dem Zeitpunkt
        -- schon Publikationen hatten. Sonst meldet ein Import saemtliche
        -- Altjahrgaenge auf einmal.
        AND EXISTS (
          SELECT 1 FROM "CompanyPublication" cp0
           WHERE cp0."companyId" = cp."companyId" AND cp0."createdAt" <= $2
        )
      ORDER BY cp."createdAt" DESC
      LIMIT 1000`,
    [ids, seit],
  );
  return r.rows.map((p) => ({
    art: "publication" as const,
    id: String(p.id),
    companyId: p.companyId,
    name: p.name ?? null,
    year: p.year ?? null,
    begin: iso(p.begin),
    end: iso(p.end),
    employeeCount: p.employeeCount ?? null,
    revenueVolume: volumen(p.revenueValue, p.revenueCurrency),
    salesVolume: volumen(p.salesValue, p.salesCurrency),
    totalAssetsVolume: volumen(p.totalAssetsValue, p.totalAssetsCurrency),
    stateOfAffairs: p.soaTopic ? { value: p.soaTopic } : null,
    createdAt: iso(p.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(p.updatedAt) ?? new Date().toISOString(),
  }));
}

/** Nur Buchstaben, klein: „Geschäftsleitung“ ≙ „Geschaeftsleitung“ etc. */
function schreibweise(v: string | null): string {
  return (v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z]/g, "");
}

async function kontaktAenderungen(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  const pool = getProducerPool("company-contact");
  const out: NeuheitItem[] = [];
  const jetzt = Date.now();
  const signale = await pool.query<{
    id: string; companyId: string; personId: string | null; type: string; before: string | null; after: string | null;
    observedAt: Date; fullName: string | null; title: string | null; startDate: Date | null;
    bekanntSeit: Date | null; vorherGesehenAm: Date | null; hinUndHer: boolean;
  }>(
    `SELECT s.id, s."companyId", s."personId", s.type, s.before, s.after, s."observedAt",
            p."fullName",
            e.title, e."startDate",
            (SELECT min(e0."firstSeen") FROM "Employment" e0
              WHERE e0."personId" = s."personId" AND e0."companyId" = s."companyId") AS "bekanntSeit",
            -- Wann wurde der ALTE Wert zuletzt gesehen? Dazwischen liegt der Wechsel.
            (SELECT max(o."observedAt") FROM "Observation" o
              WHERE o."personId" = s."personId" AND o.field = s.field
                AND o.value = s.before AND o."observedAt" < s."observedAt") AS "vorherGesehenAm",
            -- Hin und her (A→B und B→A derselben Person) ist Schreibweise, kein Wechsel.
            EXISTS (SELECT 1 FROM "SignalEvent" t
                     WHERE t."personId" = s."personId" AND t.type = s.type
                       AND t.before = s.after AND t.after = s.before) AS "hinUndHer"
       FROM "SignalEvent" s
       LEFT JOIN "Person" p ON p.id = s."personId"
       LEFT JOIN LATERAL (
         SELECT e.title, e."startDate" FROM "Employment" e
          WHERE e."personId" = s."personId" AND e."companyId" = s."companyId"
          ORDER BY e."isCurrent" DESC, e."lastSeen" DESC LIMIT 1
       ) e ON TRUE
      WHERE s."companyId" = ANY($1::text[])
        AND s."observedAt" > $2
        AND s.type::text = ANY($3::text[])
        -- Erst-Crawl ist keine Neuheit: Signale nur fuer Firmen, die vor
        -- dem Zeitpunkt schon Ansprechpartner hatten.
        AND EXISTS (
          SELECT 1 FROM "Employment" e0
           WHERE e0."companyId" = s."companyId" AND e0."firstSeen" <= $2
        )
      ORDER BY s."observedAt" DESC
      LIMIT 1000`,
    [ids, seit, Object.keys(SIGNAL_TYPEN)],
  );
  for (const s of signale.rows) {
    const typ = SIGNAL_TYPEN[s.type];
    if (!typ) continue;
    if (typ === "job-changed") {
      // Umformulierung derselben Rolle oder Hin-und-her zwischen zwei
      // Schreibweisen: kein Wechsel.
      if (schreibweise(s.before) === schreibweise(s.after)) continue;
      if (s.hinUndHer) continue;
    }
    // Zeitbezug: belegter Beginn aelter als das Fenster → nur spaet bemerkt.
    if (s.startDate && jetzt - new Date(s.startDate).getTime() > ZEITBEZUG_MS) continue;
    // Zeitbezug: der alte Wert wurde zuletzt vor sehr langer Zeit gesehen →
    // der Wechsel kann irgendwann in diesem Fenster passiert sein.
    if (
      s.vorherGesehenAm &&
      new Date(s.observedAt).getTime() - new Date(s.vorherGesehenAm).getTime() > ZEITBEZUG_MS
    ) continue;
    out.push({
      art: "contact-change",
      id: s.id,
      companyId: s.companyId,
      typ,
      personName: s.fullName ?? null,
      title: s.title ?? null,
      before: s.before ?? null,
      after: s.after ?? null,
      occurredAt: iso(s.observedAt) ?? new Date().toISOString(),
      seit: iso(s.startDate),
      bekanntSeit: iso(s.bekanntSeit),
      vorherGesehenAm: iso(s.vorherGesehenAm),
    });
  }
  const neue = await pool.query<{ companyId: string; title: string | null; firstSeen: Date; startDate: Date | null; fullName: string }>(
    `SELECT e."companyId", e.title, e."firstSeen", e."startDate", p."fullName"
       FROM "Employment" e
       JOIN "Person" p ON p.id = e."personId"
      WHERE e."companyId" = ANY($1::text[]) AND e."firstSeen" > $2 AND e."isCurrent"
        -- Erstbefuellung ist kein Wechsel: nur Firmen, die vor dem Fenster
        -- schon Ansprechpartner hatten (Befund: 69 "neue" bei einem
        -- Erst-Crawl).
        AND EXISTS (
          SELECT 1 FROM "Employment" e0
           WHERE e0."companyId" = e."companyId" AND e0."firstSeen" <= $2
        )
      ORDER BY e."firstSeen" DESC
      LIMIT 3000`,
    [ids, seit],
  );
  const jeFirma = new Map<string, { anzahl: number; personen: Array<{ name: string; title: string | null; seit: string | null }>; juengst: Date }>();
  for (const e of neue.rows) {
    // Zeitbezug: wer belegt schon lange in der Position ist, ist nicht neu,
    // AVA hat ihn nur jetzt erst gefunden.
    if (e.startDate && jetzt - new Date(e.startDate).getTime() > ZEITBEZUG_MS) continue;
    let g = jeFirma.get(e.companyId);
    if (!g) {
      g = { anzahl: 0, personen: [], juengst: e.firstSeen };
      jeFirma.set(e.companyId, g);
    }
    g.anzahl += 1;
    if (g.personen.length < 8) g.personen.push({ name: e.fullName, title: e.title ?? null, seit: iso(e.startDate) });
    if (e.firstSeen > g.juengst) g.juengst = e.firstSeen;
  }
  for (const [companyId, g] of jeFirma) {
    out.push({
      art: "new-contacts",
      // Tagesgenau stabil: derselbe Crawl-Tag ergibt denselben Schluessel.
      id: `${companyId}:${g.juengst.toISOString().slice(0, 10)}`,
      companyId,
      anzahl: g.anzahl,
      personen: g.personen,
      occurredAt: g.juengst.toISOString(),
    });
  }
  return out;
}

/**
 * Neue Kunden/Referenzen (docs/PLAN_KUNDEN.md, K4): Eintraege der Tabelle
 * CompanyKunde, die seit `seit` erstmals gesehen wurden, je Firma gebuendelt.
 * Erst-Crawl ist keine Neuheit: nur Firmen, die vor `seit` schon Kunden
 * hatten. Der Abgleich gegen die Stammdaten steht mit drin, sofern die
 * Kunden-Route ihn schon gemacht hat.
 */
async function neueKunden(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  const pool = getGatewayPool();
  const r = await pool.query<{
    companyId: string; name: string; art: string; erstGesehen: Date;
    matchCompanyId: string | null; matchName: string | null; matchLocation: string | null;
  }>(
    `SELECT k."companyId", k.name, k.art, k."erstGesehen", k."matchCompanyId", k."matchName", k."matchLocation"
       FROM "CompanyKunde" k
      WHERE k."companyId" = ANY($1::text[]) AND k."erstGesehen" > $2
        AND EXISTS (SELECT 1 FROM "CompanyKunde" k0
                     WHERE k0."companyId" = k."companyId" AND k0."erstGesehen" <= $2)
      ORDER BY k."erstGesehen" DESC
      LIMIT 2000`,
    [ids, seit],
  ).catch((err) => {
    // Tabelle entsteht erst mit dem ersten Kunden-Persist.
    logger.info({ err: err instanceof Error ? err.message : err }, "neuheiten: CompanyKunde noch nicht vorhanden");
    return { rows: [] as never[] };
  });
  const jeFirma = new Map<string, { anzahl: number; kunden: Array<{ name: string; art: string; match: { companyId: string; name: string; location: string | null } | null }>; juengst: Date }>();
  for (const k of r.rows) {
    let g = jeFirma.get(k.companyId);
    if (!g) {
      g = { anzahl: 0, kunden: [], juengst: k.erstGesehen };
      jeFirma.set(k.companyId, g);
    }
    g.anzahl += 1;
    if (g.kunden.length < 8) {
      g.kunden.push({
        name: k.name,
        art: k.art,
        match: k.matchCompanyId ? { companyId: k.matchCompanyId, name: k.matchName ?? k.matchCompanyId, location: k.matchLocation } : null,
      });
    }
    if (k.erstGesehen > g.juengst) g.juengst = k.erstGesehen;
  }
  const out: NeuheitItem[] = [];
  for (const [companyId, g] of jeFirma) {
    out.push({
      art: "new-customers",
      id: `${companyId}:${g.juengst.toISOString().slice(0, 10)}`,
      companyId,
      anzahl: g.anzahl,
      kunden: g.kunden,
      occurredAt: g.juengst.toISOString(),
    });
  }
  return out;
}

alertsNeuheitenRouter.openapi(route, async (c) => {
  const { companyIds, since } = c.req.valid("json");
  const ids = Array.from(new Set(companyIds));
  const seit = fensterStart(since);
  const quellen = await Promise.allSettled([
    listeProfilAenderungen(ids, seit).then((rows) =>
      rows
        // Zeitbezug: Lag die letzte Bestaetigung des alten Stands sehr lange
        // zurueck, kann der Wechsel irgendwann in diesem Fenster passiert
        // sein — zu alt, um ihn als Neuigkeit zu melden.
        .filter(
          (r) =>
            !r.bestandVon ||
            new Date(r.createdAt).getTime() - new Date(r.bestandVon).getTime() <= ZEITBEZUG_MS,
        )
        .map<NeuheitItem>((r) => ({
          art: "profile-change",
          id: r.id,
          companyId: r.companyId,
          kind: r.kind,
          added: r.added as unknown as Array<Record<string, unknown>>,
          removed: r.removed as unknown as Array<Record<string, unknown>>,
          occurredAt: r.createdAt,
          bestandVon: r.bestandVon,
        })),
    ),
    publikationen(ids, seit),
    kontaktAenderungen(ids, seit),
    neueKunden(ids, seit),
  ]);
  const items: NeuheitItem[] = [];
  const namen = ["profile-change", "publication", "contact", "customers"];
  quellen.forEach((q, i) => {
    if (q.status === "fulfilled") items.push(...q.value);
    else logger.warn({ err: q.reason, quelle: namen[i] }, "neuheiten: quelle ausgefallen");
  });
  const zeit = (x: NeuheitItem): string => (x.art === "publication" ? x.createdAt : x.occurredAt);
  items.sort((a, b) => (zeit(a) < zeit(b) ? 1 : zeit(a) > zeit(b) ? -1 : 0));
  return c.json({ seit: seit.toISOString(), items }, 200);
});
