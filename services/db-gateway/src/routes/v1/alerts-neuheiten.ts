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
import { gleicherName } from "../../lib/buying-center-vorschlag";

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
    /** Was andere Quellen ueber die Rolle wissen (Register, LinkedIn-Beginn) — fuer das Urteil. */
    kontext: z.array(z.string()).optional(),
    /** Konkrete Fundstellen (Seite, auf der der neue bzw. alte Wert stand) — Befund Patrick 2026-10-24. */
    quellen: z.array(z.object({ url: z.string(), titel: z.string() })).optional(),
  }),
  z.object({
    art: z.literal("job-postings"),
    id: z.string(),
    companyId: z.string(),
    anzahl: z.number().int(),
    stellen: z.array(z.object({ title: z.string(), location: z.string().nullable(), benefits: z.array(z.string()), sourceUrl: z.string() })),
    leistungen: z.array(z.string()),
    occurredAt: z.string(),
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
        /** Seite, auf der der Kunde genannt wird. */
        quelle: z.string().nullable().optional(),
      }),
    ),
    occurredAt: z.string(),
  }),
  z.object({
    art: z.literal("new-contacts"),
    id: z.string(),
    companyId: z.string(),
    anzahl: z.number(),
    personen: z.array(z.object({ name: z.string(), title: z.string().nullable(), seit: z.string().nullable(), url: z.string().nullable().optional() })),
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

/** Neue Stellenanzeigen je Firma, gebuendelt (docs/PLAN_STELLEN_SIGNALE.md). Erst-Crawl ist keine
 *  Neuheit: nur Firmen, die vor `seit` schon Stellen hatten. createdAt bleibt beim Persist je
 *  Stelle erhalten (Titel + Quelle), deshalb zaehlt es als Erstsichtung. */
async function neueStellen(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  // Stellen liegen in der Website-DB (docs/PLAN_RECHERCHE_PERSIST.md).
  const pool = getProducerPool("website");
  const r = await pool.query<{ companyId: string; title: string; location: string | null; benefits: string[] | null; sourceUrl: string; createdAt: Date }>(
    `SELECT jp."companyId", jp.title, jp.location, jp.benefits, jp."sourceUrl", jp."createdAt"
       FROM "JobPosting" jp
      WHERE jp."companyId" = ANY($1::text[]) AND jp."createdAt" > $2
        AND EXISTS (SELECT 1 FROM "JobPosting" j0 WHERE j0."companyId" = jp."companyId" AND j0."createdAt" <= $2)
      ORDER BY jp."companyId", jp."createdAt" DESC
      LIMIT 2000`,
    [ids, seit],
  ).catch(() => ({ rows: [] as Array<{ companyId: string; title: string; location: string | null; benefits: string[] | null; sourceUrl: string; createdAt: Date }> }));
  const je = new Map<string, typeof r.rows>();
  for (const row of r.rows) je.set(row.companyId, [...(je.get(row.companyId) ?? []), row]);
  const out: NeuheitItem[] = [];
  for (const [companyId, rows] of je) {
    const juengste = rows[0]!.createdAt;
    const leistungen = [...new Set(rows.flatMap((x) => x.benefits ?? []))].slice(0, 12);
    out.push({
      art: "job-postings",
      id: `${companyId}:${juengste.toISOString().slice(0, 10)}`,
      companyId,
      anzahl: rows.length,
      stellen: rows.slice(0, 8).map((x) => ({ title: x.title, location: x.location, benefits: x.benefits ?? [], sourceUrl: x.sourceUrl })),
      leistungen,
      occurredAt: juengste.toISOString(),
    });
  }
  return out;
}

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

/** Lesbarer Name der Beobachtungsquelle fuer die Fundstelle. */
function quellenName(source: string | null | undefined): string {
  const s = source ?? "";
  if (s.startsWith("apify") || s.includes("linkedin")) return "LinkedIn";
  if (s.startsWith("agent:") || s.startsWith("website")) return "Website";
  if (s.startsWith("search")) return "Suchtreffer";
  return "Quelle";
}

/** Nur Buchstaben, klein: „Geschäftsleitung“ ≙ „Geschaeftsleitung“ etc. */
function schreibweise(v: string | null): string {
  return (v ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // Aufzaehlungen: "A; B; C" ≙ "A, B und C" ≙ "A, B and C"
    .replace(/\b(und|and|sowie)\b|&/g, " ")
    .replace(/[^a-z]/g, "");
}

async function kontaktAenderungen(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  const pool = getProducerPool("company-contact");
  const out: NeuheitItem[] = [];
  const jetzt = Date.now();
  const signale = await pool.query<{
    id: string; companyId: string; personId: string | null; type: string; before: string | null; after: string | null;
    observedAt: Date; fullName: string | null; title: string | null; startDate: Date | null;
    bekanntSeit: Date | null; beobachtungen: Array<{ value: string; am: string; lauf: string | null; url: string | null; quelle: string | null }> | null;
    source: string | null; runId: string | null;
  }>(
    `SELECT s.id, s."companyId", s."personId", s.type, s.before, s.after, s."observedAt",
            p."fullName",
            e.title, e."startDate",
            (SELECT min(e0."firstSeen") FROM "Employment" e0
              WHERE e0."personId" = s."personId" AND e0."companyId" = s."companyId") AS "bekanntSeit",
            -- Alle Beobachtungen dieses Felds (Wert, Zeit, Lauf): die Zeitlogik
            -- (alter Wert zuletzt, neuer Wert erstmals, gleicher Lauf, Rueckfall)
            -- laeuft in JS ueber die Schreibweise, nicht ueber exakte Strings —
            -- Befund 2026-10-23 (TradeMax24): "A; B; C" und "A, B und C" sind derselbe Wert.
            (SELECT json_agg(json_build_object('value', o.value, 'am', o."observedAt", 'lauf', o."runId", 'url', o."evidenceUrl", 'quelle', o.source) ORDER BY o."observedAt")
               FROM "Observation" o
              WHERE o."personId" = s."personId" AND o.field = s.field) AS "beobachtungen",
            s.source, s."runId"
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
  // Register-Kontext je Firma: Geschaeftsfuehrer laut structured-content und
  // Register-Ereignisse (neu bestellte GF) im Fenster. Eine Website, die
  // einen seit Jahren eingetragenen GF "neu" nennt, ist keine Neuigkeit
  // (Befund Joyce 2026-10-23: Justin Rafflenbeul, TradeMax24).
  const registerGf = new Map<string, Array<{ name: string; bestelltAm: Date | null; bekanntSeit: Date }>>();
  try {
    const sc = getProducerPool("structured-content");
    await sc.query(`ALTER TABLE "ManagingDirector" ADD COLUMN IF NOT EXISTS "bestelltAm" DATE`).catch(() => {});
    const md = await sc.query<{ companyId: string; firstName: string; lastName: string; bestelltAm: Date | null; createdAt: Date }>(
      `SELECT "companyId", "firstName", "lastName", "bestelltAm", "createdAt" FROM "ManagingDirector" WHERE "companyId" = ANY($1::text[])`,
      [ids],
    );
    for (const r of md.rows) {
      const name = `${r.firstName ?? ""} ${r.lastName ?? ""}`.replace(/\s+/g, " ").trim();
      if (name) registerGf.set(r.companyId, [...(registerGf.get(r.companyId) ?? []), { name, bestelltAm: r.bestelltAm, bekanntSeit: r.createdAt }]);
    }
  } catch (err) {
    logger.warn({ err }, "neuheiten: Register-Geschaeftsfuehrer nicht lesbar (weiter ohne Kontext)");
  }
  const neuBestellt = new Map<string, Array<{ name: string; am: Date }>>();
  try {
    const ev = await getGatewayPool().query<{ companyId: string; added: Array<{ firstName?: string; lastName?: string }>; createdAt: Date }>(
      `SELECT "companyId", added, "createdAt" FROM "ProfileChangeEvent"
        WHERE "companyId" = ANY($1::text[]) AND kind = 'managing-directors' AND "createdAt" > $2`,
      [ids, new Date(jetzt - ZEITBEZUG_MS)],
    );
    for (const r of ev.rows) {
      for (const a of r.added ?? []) {
        const name = `${a.firstName ?? ""} ${a.lastName ?? ""}`.replace(/\s+/g, " ").trim();
        if (name) neuBestellt.set(r.companyId, [...(neuBestellt.get(r.companyId) ?? []), { name, am: r.createdAt }]);
      }
    }
  } catch (err) {
    logger.warn({ err }, "neuheiten: Register-Ereignisse nicht lesbar (weiter ohne Kontext)");
  }
  const GF_ROLLE = /gesch(ae|ä)ftsf(ue|ü)hr|managing director|\bceo\b|\bcfo\b|\bcoo\b|\bcto\b|vorstand|inhaber|\bowner\b|gesch(ae|ä)ftsleit/i;

  for (const s of signale.rows) {
    const typ = SIGNAL_TYPEN[s.type];
    if (!typ) continue;
    const kontext: string[] = [];
    const obs = (s.beobachtungen ?? []).map((o) => ({ norm: schreibweise(o.value), am: new Date(o.am).getTime(), lauf: o.lauf, url: o.url, quelle: o.quelle }));
    const signalAm = new Date(s.observedAt).getTime();
    const altNorm = schreibweise(s.before);
    const neuNorm = schreibweise(s.after);
    // Letzte Sichtung des alten Werts vor dem Signal; erste Sichtung des neuen.
    const vorherGesehenAm = obs.filter((o) => o.norm === altNorm && o.am < signalAm).reduce<number | null>((m, o) => (m === null || o.am > m ? o.am : m), null);
    const neuErstGesehen = obs.filter((o) => o.norm === neuNorm).reduce<number | null>((m, o) => (m === null || o.am < m ? o.am : m), null);
    if (typ === "job-changed") {
      // Umformulierung derselben Rolle: kein Wechsel.
      if (altNorm === neuNorm) continue;
      // Alter Wert im selben Lauf binnen 24 h gesehen (andere Seite/Quelle derselben
      // Firma): Varianten nebeneinander, kein Wechsel (Befund 2026-10-22).
      if (s.runId && obs.some((o) => o.norm === altNorm && o.lauf === s.runId && o.am > signalAm - 86_400_000 && o.am <= signalAm)) continue;
      // Rueckfall auf einen frueheren Stand (Befund Elisa Zimmer 2026-10-22): der
      // "neue" Wert war schon vor der letzten Sichtung des alten da, auch in
      // anderer Schreibweise.
      const schonFrueherDa = obs.some((o) => {
        if (!o.norm || o.norm === altNorm || o.am >= signalAm) return false;
        const gleich = o.norm === neuNorm || (o.norm.length >= 12 && (neuNorm.startsWith(o.norm) || o.norm.startsWith(neuNorm)));
        return gleich && (vorherGesehenAm === null || o.am <= vorherGesehenAm);
      });
      if (schonFrueherDa) continue;
      // Suchtreffer-Schnipsel sind undatiert (Google zeigt oft den alten
      // Stand): ohne belegten Beginn keine Meldung.
      if ((s.source ?? "").startsWith("search") && !s.startDate) continue;
      // Register-Kontext: Die Person ist laut Handelsregister Geschaeftsfuehrer.
      if (s.fullName) {
        const gfs = registerGf.get(s.companyId) ?? [];
        const registerGfEintrag = gfs.find((g) => gleicherName(g.name, s.fullName!));
        const bestellung = (neuBestellt.get(s.companyId) ?? []).find((b) => gleicherName(b.name, s.fullName!));
        if (registerGfEintrag) {
          const datum = (d: Date | null | undefined) => (d ? new Date(d).toLocaleDateString("de-DE") : null);
          const seit = registerGfEintrag.bestelltAm
            ? `bestellt am ${datum(registerGfEintrag.bestelltAm)} laut Registerabdruck`
            : `im Register als Geschäftsführer bekannt seit mindestens ${datum(registerGfEintrag.bekanntSeit)}`;
          kontext.push(bestellung
            ? `Handelsregister: als Geschäftsführer eingetragen, Bestellung im Register bemerkt am ${iso(bestellung.am)?.slice(0, 10)}.`
            : `Handelsregister: ${seit}, keine neue Bestellung im Register.`);
          // Website nennt eine Fuehrungsrolle, die das Register laengst kennt: keine Neuigkeit.
          if (!bestellung && GF_ROLLE.test(s.after ?? "")) continue;
        } else if (GF_ROLLE.test(s.after ?? "") && gfs.length > 0) {
          kontext.push(`Handelsregister: nicht als Geschäftsführer eingetragen (eingetragen: ${gfs.map((g) => g.name).join(", ")}).`);
        }
      }
    }
    // Zeitbezug (nachgeschaerft 2026-10-06, Befund: fuenf Meldungen zu
    // Personen, die seit Jahrzehnten im Amt sind): Eine Meldung braucht
    // einen POSITIVEN Beleg fuer Aktualitaet. Entweder ein belegter Beginn
    // innerhalb des Fensters — oder ein echter Uebergang auf der Website:
    // der alte Wert wurde zuletzt gesehen, BEVOR der neue erstmals auftauchte,
    // und beides liegt innerhalb des Fensters. Fehlt der Beleg, erscheint
    // nichts; "AVA hat es jetzt erst gelesen" ist keine Neuigkeit.
    const beginnAktuell = s.startDate ? jetzt - new Date(s.startDate).getTime() <= ZEITBEZUG_MS : null;
    if (beginnAktuell === false) continue;
    if (beginnAktuell === null) {
      if (vorherGesehenAm === null || neuErstGesehen === null) continue;
      if (neuErstGesehen <= vorherGesehenAm) continue; // Varianten nebeneinander, kein Uebergang
      if (signalAm - vorherGesehenAm > ZEITBEZUG_MS) continue; // Fenster zu breit
    }
    if (s.startDate) kontext.push(`Beginn der Position belegt: ${iso(s.startDate)?.slice(0, 10)}.`);
    else kontext.push("Kein belegter Beginn der Position (weder Website noch LinkedIn).");
    // Fundstellen: juengste Seite mit dem neuen Wert, aelteste bekannte mit dem alten.
    const quellen: Array<{ url: string; titel: string }> = [];
    const neuObs = obs.filter((o) => o.norm === neuNorm && o.url).sort((a, b) => b.am - a.am)[0];
    const altObs = obs.filter((o) => o.norm === altNorm && o.url).sort((a, b) => b.am - a.am)[0];
    if (neuObs?.url) quellen.push({ url: neuObs.url, titel: `${quellenName(neuObs.quelle)}: neuer Stand` });
    if (altObs?.url && altObs.url !== neuObs?.url) quellen.push({ url: altObs.url, titel: `${quellenName(altObs.quelle)}: früherer Stand` });
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
      vorherGesehenAm: vorherGesehenAm === null ? null : new Date(vorherGesehenAm).toISOString(),
      kontext,
      ...(quellen.length > 0 ? { quellen } : {}),
    });
  }
  const neue = await pool.query<{ companyId: string; title: string | null; firstSeen: Date; startDate: Date | null; fullName: string; url: string | null }>(
    `SELECT e."companyId", e.title, e."firstSeen", e."startDate", p."fullName",
            (SELECT o."evidenceUrl" FROM "Observation" o
              WHERE o."personId" = e."personId" AND o."companyId" = e."companyId" AND o."evidenceUrl" IS NOT NULL
              ORDER BY o."observedAt" DESC LIMIT 1) AS url
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
  const jeFirma = new Map<string, { anzahl: number; personen: Array<{ name: string; title: string | null; seit: string | null; url: string | null }>; juengst: Date }>();
  for (const e of neue.rows) {
    // Zeitbezug (2026-10-06): "Erstmals gesehen" heisst nur, dass AVA die
    // Person jetzt gefunden hat — nicht, dass sie neu ist. Ohne belegten,
    // aktuellen Beginn (seit/startDate aus Website oder LinkedIn) gibt es
    // keine Meldung "neuer Ansprechpartner".
    if (!e.startDate || jetzt - new Date(e.startDate).getTime() > ZEITBEZUG_MS) continue;
    let g = jeFirma.get(e.companyId);
    if (!g) {
      g = { anzahl: 0, personen: [], juengst: e.firstSeen };
      jeFirma.set(e.companyId, g);
    }
    g.anzahl += 1;
    if (g.personen.length < 8) g.personen.push({ name: e.fullName, title: e.title ?? null, seit: iso(e.startDate), url: e.url ?? null });
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
    matchCompanyId: string | null; matchName: string | null; matchLocation: string | null; quelle: string | null;
  }>(
    `SELECT k."companyId", k.name, k.art, k."erstGesehen", k."matchCompanyId", k."matchName", k."matchLocation", k.quelle
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
  const jeFirma = new Map<string, { anzahl: number; kunden: Array<{ name: string; art: string; match: { companyId: string; name: string; location: string | null } | null; quelle: string | null }>; juengst: Date }>();
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
        quelle: k.quelle && /^https?:\/\//.test(k.quelle) ? k.quelle : null,
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
        // Ohne bestandVon (Altbestand vor 2026-10-05) ist das Fenster
        // unbekannt — dann lieber keine Meldung.
        .filter(
          (r) =>
            !!r.bestandVon &&
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
    neueStellen(ids, seit),
  ]);
  const items: NeuheitItem[] = [];
  const namen = ["profile-change", "publication", "contact", "customers", "job-postings"];
  quellen.forEach((q, i) => {
    if (q.status === "fulfilled") items.push(...q.value);
    else logger.warn({ err: q.reason, quelle: namen[i] }, "neuheiten: quelle ausgefallen");
  });
  const zeit = (x: NeuheitItem): string => (x.art === "publication" ? x.createdAt : x.occurredAt);
  items.sort((a, b) => (zeit(a) < zeit(b) ? 1 : zeit(a) > zeit(b) ? -1 : 0));
  return c.json({ seit: seit.toISOString(), items }, 200);
});
