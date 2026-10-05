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
//
// Das Zeitfenster ist auf 30 Tage gedeckelt: Der erste Takt nach einem
// Neustart kommt ohne `since`, und die Dedup-Liste im Desktop faengt
// Wiederholungen ab. Bewertet wird NICHT hier, sondern lokal beim Nutzer
// (Compute-Lokalitaet) durch den Alarm-Judge mit dessen Profil.

import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { requireScope } from "../../middleware/auth";
import { getProducerPool } from "../../lib/producer-pools";
import { listeProfilAenderungen } from "../../lib/profile-changes";
import { logger } from "../../lib/logger";
import { ErrorShape } from "./schemas";

export const alertsNeuheitenRouter = new OpenAPIHono();
alertsNeuheitenRouter.use("*", requireScope("company:read"));

const tag = "alerts";
const FENSTER_TAGE = 30;
const MAX_FIRMEN = 500;

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
  }),
  z.object({
    art: z.literal("new-contacts"),
    id: z.string(),
    companyId: z.string(),
    anzahl: z.number(),
    personen: z.array(z.object({ name: z.string(), title: z.string().nullable() })),
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

async function kontaktAenderungen(ids: string[], seit: Date): Promise<NeuheitItem[]> {
  const pool = getProducerPool("company-contact");
  const out: NeuheitItem[] = [];
  const signale = await pool.query<{
    id: string; companyId: string; type: string; before: string | null; after: string | null;
    observedAt: Date; fullName: string | null; title: string | null;
  }>(
    `SELECT s.id, s."companyId", s.type, s.before, s.after, s."observedAt",
            p."fullName",
            (SELECT e.title FROM "Employment" e
              WHERE e."personId" = s."personId" AND e."companyId" = s."companyId"
              ORDER BY e."isCurrent" DESC, e."lastSeen" DESC LIMIT 1) AS title
       FROM "SignalEvent" s
       LEFT JOIN "Person" p ON p.id = s."personId"
      WHERE s."companyId" = ANY($1::text[])
        AND s."observedAt" > $2
        AND s.type = ANY($3::text[])
      ORDER BY s."observedAt" DESC
      LIMIT 1000`,
    [ids, seit, Object.keys(SIGNAL_TYPEN)],
  );
  for (const s of signale.rows) {
    const typ = SIGNAL_TYPEN[s.type];
    if (!typ) continue;
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
    });
  }
  const neue = await pool.query<{ companyId: string; title: string | null; firstSeen: Date; fullName: string }>(
    `SELECT e."companyId", e.title, e."firstSeen", p."fullName"
       FROM "Employment" e
       JOIN "Person" p ON p.id = e."personId"
      WHERE e."companyId" = ANY($1::text[]) AND e."firstSeen" > $2 AND e."isCurrent"
      ORDER BY e."firstSeen" DESC
      LIMIT 3000`,
    [ids, seit],
  );
  const jeFirma = new Map<string, { anzahl: number; personen: Array<{ name: string; title: string | null }>; juengst: Date }>();
  for (const e of neue.rows) {
    let g = jeFirma.get(e.companyId);
    if (!g) {
      g = { anzahl: 0, personen: [], juengst: e.firstSeen };
      jeFirma.set(e.companyId, g);
    }
    g.anzahl += 1;
    if (g.personen.length < 8) g.personen.push({ name: e.fullName, title: e.title ?? null });
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

alertsNeuheitenRouter.openapi(route, async (c) => {
  const { companyIds, since } = c.req.valid("json");
  const ids = Array.from(new Set(companyIds));
  const seit = fensterStart(since);
  const quellen = await Promise.allSettled([
    listeProfilAenderungen(ids, seit).then((rows) =>
      rows.map<NeuheitItem>((r) => ({
        art: "profile-change",
        id: r.id,
        companyId: r.companyId,
        kind: r.kind,
        added: r.added as unknown as Array<Record<string, unknown>>,
        removed: r.removed as unknown as Array<Record<string, unknown>>,
        occurredAt: r.createdAt,
      })),
    ),
    publikationen(ids, seit),
    kontaktAenderungen(ids, seit),
  ]);
  const items: NeuheitItem[] = [];
  const namen = ["profile-change", "publication", "contact"];
  quellen.forEach((q, i) => {
    if (q.status === "fulfilled") items.push(...q.value);
    else logger.warn({ err: q.reason, quelle: namen[i] }, "neuheiten: quelle ausgefallen");
  });
  const zeit = (x: NeuheitItem): string => (x.art === "publication" ? x.createdAt : x.occurredAt);
  items.sort((a, b) => (zeit(a) < zeit(b) ? 1 : zeit(a) > zeit(b) ? -1 : 0));
  return c.json({ seit: seit.toISOString(), items }, 200);
});
