// docs/PLAN_PRICING_TIERS.md P10 (2026-11-02) — Zustand je Nutzer und Firma:
// aktiv (AVA bereitet auf, beobachtet, alarmiert, zaehlt im Bestand) oder
// ruhend (steht in der Liste, nur Steckbrief, zaehlt nicht). Ohne Zeile in
// "FirmenZustand" gilt aktiv (Bestandsschutz).
//
//   - Ruhend setzen wirkt sofort auf Aufbereitung/Alarme, der Bestand des
//     laufenden Monats bleibt (die Firma hat diesen Monat schon gekostet);
//     bestandJeKonto() schliesst ruhende Firmen ab dem Folgemonat aus.
//   - Aktivieren = normaler Verarbeitungsweg (master-data legt einen Vorgang
//     fuer den Nutzer an, try-reserve je Firma), nach Vorabpruefung gegen das
//     Kontingent. Reicht es nicht: Ablehnung wie beim Import (402-Nutzlast).
//   - Vormerkungen (ab Monatswechsel aktiv/ruhend, mit Tausch) fuehrt der
//     Billing-Cron am Monatsersten aus.
import type pg from "pg";
import { logger } from "./logger";
import { masterData } from "./register-jobs";
import { getGatewayPool } from "./producer-pools";
import { kontingentPruefen, pricingAktiv, type KontingentAblehnung } from "./kontingent";
import { readBillingAccount, effectiveTier, periodKeyFor, resolveBillingAccountId } from "./billing";

type Q = { query: pg.Pool["query"] };

export type Zustand = "aktiv" | "ruhend";
export interface ZustandZeile {
  companyId: string;
  zustand: Zustand;
  seit: string | null;
  quelle: string | null;
  geplant: Zustand | null;
  geplantAb: string | null;
  geplantTausch: string[];
}

function periodKeyHeute(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function naechsterPeriodKey(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return periodKeyHeute(d);
}

/** Zustand je Firma; Firmen ohne Zeile fehlen in der Map (= aktiv). */
export async function zustaende(q: Q, actorId: string, companyIds: string[]): Promise<Map<string, ZustandZeile>> {
  const out = new Map<string, ZustandZeile>();
  if (!actorId || companyIds.length === 0) return out;
  const r = await q.query<{ companyId: string; zustand: string; seit: Date; quelle: string | null; geplant: string | null; geplantAb: string | null; geplantTausch: string[] }>(
    `SELECT "companyId", zustand, seit, quelle, geplant, "geplantAb", "geplantTausch" FROM "FirmenZustand" WHERE "actorId" = $1 AND "companyId" = ANY($2::text[])`,
    [actorId, companyIds],
  );
  for (const row of r.rows) {
    out.set(row.companyId, {
      companyId: row.companyId,
      zustand: row.zustand === "ruhend" ? "ruhend" : "aktiv",
      seit: row.seit?.toISOString() ?? null,
      quelle: row.quelle,
      geplant: row.geplant === "aktiv" || row.geplant === "ruhend" ? row.geplant : null,
      geplantAb: row.geplantAb,
      geplantTausch: row.geplantTausch ?? [],
    });
  }
  return out;
}

/** Alle ruhenden Firmen eines Nutzers (ohne Einschraenkung) bzw. die ruhende Teilmenge. */
export async function ruhendeIds(q: Q, actorId: string, companyIds?: string[]): Promise<Set<string>> {
  if (!actorId) return new Set();
  const r = companyIds
    ? await q.query<{ companyId: string }>(`SELECT "companyId" FROM "FirmenZustand" WHERE "actorId" = $1 AND zustand = 'ruhend' AND "companyId" = ANY($2::text[])`, [actorId, companyIds])
    : await q.query<{ companyId: string }>(`SELECT "companyId" FROM "FirmenZustand" WHERE "actorId" = $1 AND zustand = 'ruhend' LIMIT 20000`, [actorId]);
  return new Set(r.rows.map((x) => x.companyId));
}

/** Ruhende Firmen mehrerer Nutzer als "userId|companyId" (Bestand je Konto). */
export async function ruhendePaare(q: Q, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const r = await q.query<{ actorId: string; companyId: string }>(`SELECT "actorId", "companyId" FROM "FirmenZustand" WHERE "actorId" = ANY($1::text[]) AND zustand = 'ruhend'`, [userIds]);
  return new Set(r.rows.map((x) => `${x.actorId}|${x.companyId}`));
}

async function upsert(q: Q, actorId: string, companyId: string, felder: { zustand?: Zustand; quelle?: string | null; geplant?: Zustand | null; geplantAb?: string | null; geplantTausch?: string[] }): Promise<void> {
  // Zustand bleibt, wenn nur eine Vormerkung gesetzt wird (COALESCE auf den alten Wert).
  await q.query(
    `INSERT INTO "FirmenZustand" ("actorId", "companyId", zustand, seit, quelle, geplant, "geplantAb", "geplantTausch", "updatedAt")
     VALUES ($1, $2, COALESCE($3, 'aktiv'), NOW(), $4, $5, $6, COALESCE($7, '{}'::text[]), NOW())
     ON CONFLICT ("actorId", "companyId") DO UPDATE SET
       zustand = COALESCE($3, "FirmenZustand".zustand),
       seit = CASE WHEN $3 IS NOT NULL AND $3 <> "FirmenZustand".zustand THEN NOW() ELSE "FirmenZustand".seit END,
       quelle = COALESCE($4, "FirmenZustand".quelle),
       geplant = $5, "geplantAb" = $6, "geplantTausch" = COALESCE($7, '{}'::text[]), "updatedAt" = NOW()`,
    [actorId, companyId, felder.zustand ?? null, felder.quelle ?? null, felder.geplant ?? null, felder.geplantAb ?? null, felder.geplantTausch ?? null],
  );
}

/** Ruhend setzen: sofort (Aufbereitung/Alarme aus, Bestand bis Monatsende) oder zum Monatswechsel vorgemerkt. */
export async function ruhendSetzen(q: Q, args: { actorId: string; companyIds: string[]; quelle: string; ab: "sofort" | "monatswechsel" }): Promise<void> {
  for (const id of args.companyIds) {
    if (args.ab === "sofort") await upsert(q, args.actorId, id, { zustand: "ruhend", quelle: args.quelle, geplant: null, geplantAb: null });
    else await upsert(q, args.actorId, id, { quelle: args.quelle, geplant: "ruhend", geplantAb: naechsterPeriodKey() });
  }
}

/** Vormerkung (aktiv oder ruhend zum Monatswechsel) zuruecknehmen. */
export async function vormerkungWiderrufen(q: Q, actorId: string, companyId: string): Promise<void> {
  const r = await q.query<{ geplantTausch: string[] }>(`SELECT "geplantTausch" FROM "FirmenZustand" WHERE "actorId" = $1 AND "companyId" = $2`, [actorId, companyId]);
  const tausch = r.rows[0]?.geplantTausch ?? [];
  await q.query(`UPDATE "FirmenZustand" SET geplant = NULL, "geplantAb" = NULL, "geplantTausch" = '{}', "updatedAt" = NOW() WHERE "actorId" = $1 AND "companyId" = $2`, [actorId, companyId]);
  // Mit der Aktivierung vorgemerkte Ruhestellungen fallen mit.
  if (tausch.length > 0) {
    await q.query(`UPDATE "FirmenZustand" SET geplant = NULL, "geplantAb" = NULL, "updatedAt" = NOW() WHERE "actorId" = $1 AND "companyId" = ANY($2::text[]) AND geplant = 'ruhend'`, [actorId, tausch]);
  }
}

export type AktivierungErgebnis =
  | { ok: true; transactionId: string | null; aktiv: string[]; ruhend: string[] }
  | { ok: false; ablehnung: KontingentAblehnung };

/** Free: 25 Aktivierungen auf Lebenszeit (UsageEntry periodKey lifetime). Liefert eine Ablehnung, wenn es nicht reicht. */
async function freeDeckelPruefen(q: Q, tenantId: string, actorId: string | null, companyIds: string[]): Promise<KontingentAblehnung | null> {
  const billingAccountId = await resolveBillingAccountId(q, { tenantId, actorId });
  const acc = await readBillingAccount(q, billingAccountId);
  if (!acc || effectiveTier(acc) !== "free") return null;
  const periodKey = periodKeyFor("free");
  const r = await q.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2`, [billingAccountId, periodKey]);
  const genutzt = Number(r.rows[0]?.n ?? 0);
  const schonDrin = new Set((await q.query<{ companyId: string }>(`SELECT "companyId" FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2 AND "companyId" = ANY($3::text[])`, [billingAccountId, periodKey, companyIds])).rows.map((x) => x.companyId));
  const neu = companyIds.filter((id) => !schonDrin.has(id));
  const limit = acc.quotaLimit;
  if (limit < 0 || genutzt + neu.length <= limit) return null;
  const platz = Math.max(0, limit - genutzt);
  const passen = [...companyIds.filter((id) => schonDrin.has(id)), ...neu.slice(0, platz)];
  return {
    ok: false, code: "kontingent_erschoepft", fehltCents: 0, passenNoch: passen, passenNochAnzahl: passen.length,
    naechsterPlan: "pro", paygMoeglich: false, kannSelbstWechseln: true, plan: "free", kontingentCents: null,
    verbrauchtCents: 0, benoetigtCents: 0,
    meldung: `Im Free-Plan kannst du insgesamt ${limit} Firmen aktivieren, ${genutzt} sind es schon. Mit Pro bekommst du ein monatliches Kontingent.`,
  };
}

/** Vorabpruefung einer Aktivierung (Free-Deckel oder Kontingent), ohne etwas zu aendern. */
export async function aktivierungPruefen(q: Q, args: { tenantId: string; actorId: string | null; companyIds: string[] }): Promise<KontingentAblehnung | null> {
  if (!pricingAktiv()) return null;
  const free = await freeDeckelPruefen(q, args.tenantId, args.actorId, args.companyIds);
  if (free) return free;
  const p = await kontingentPruefen(q, { tenantId: args.tenantId, actorId: args.actorId, companyIds: args.companyIds });
  return p.ok ? null : p;
}

/**
 * Aktivieren: sofort (Vorabpruefung, dann Vorgang ueber master-data fuer den Nutzer,
 * Tombstone weg, Zustand aktiv) oder zum Monatswechsel vorgemerkt (mit Tausch).
 */
export async function aktivieren(
  pool: pg.Pool,
  args: { tenantId: string; actorId: string; companyIds: string[]; quelle: string; ab: "sofort" | "monatswechsel"; tausch?: string[] },
): Promise<AktivierungErgebnis> {
  const ids = [...new Set(args.companyIds)];
  if (args.ab === "monatswechsel") {
    const ab = naechsterPeriodKey();
    for (const id of ids) await upsert(pool, args.actorId, id, { quelle: args.quelle, geplant: "aktiv", geplantAb: ab, geplantTausch: args.tausch ?? [] });
    for (const t of args.tausch ?? []) await upsert(pool, args.actorId, t, { quelle: "tausch", geplant: "ruhend", geplantAb: ab });
    return { ok: true, transactionId: null, aktiv: [], ruhend: ids };
  }
  const ablehnung = await aktivierungPruefen(pool, { tenantId: args.tenantId, actorId: args.actorId, companyIds: ids });
  if (ablehnung) return { ok: false, ablehnung };
  // Zustand zuerst aktiv setzen, damit try-reserve/park die Firma nicht erneut ruhend legt,
  // falls sie knapp nicht passt (dann meldet master-data parkedCount und wir setzen zurueck).
  for (const id of ids) await upsert(pool, args.actorId, id, { zustand: "aktiv", quelle: args.quelle, geplant: null, geplantAb: null });
  await pool.query(`DELETE FROM "CompanyTombstone" WHERE "userId" = $1 AND "companyId" = ANY($2::text[])`, [args.actorId, ids]).catch(() => undefined);
  const name = ids.length === 1 ? "Aktiviert" : `Aktiviert: ${ids.length} Firmen`;
  const r = await masterData<{ transactionId?: string; publishedCount?: number; parkedCount?: number; nichtGefunden?: string[]; geparkt?: string[] }>(
    "POST", "/internal/transactions/by-ids", { userId: args.actorId, companyIds: ids, name, source: `zustand:${args.quelle}` },
  );
  if (r.transactionId) {
    const { seedEntityProgressRows } = await import("./entity-progress-seed");
    await seedEntityProgressRows(r.transactionId, ids.filter((id) => !(r.nichtGefunden ?? []).includes(id))).catch(() => undefined);
  }
  const ruhend = r.geparkt ?? [];
  const aktiv = ids.filter((id) => !ruhend.includes(id) && !(r.nichtGefunden ?? []).includes(id));
  return { ok: true, transactionId: r.transactionId ?? null, aktiv, ruhend };
}

async function tenantFuerActor(q: Q, actorId: string): Promise<string> {
  const r = await q.query<{ tenantId: string }>(`SELECT "tenantId" FROM "TenantMember" WHERE "actorId" = $1 ORDER BY "joinedAt" ASC LIMIT 1`, [actorId]);
  return r.rows[0]?.tenantId ?? actorId;
}

/** Monatsersten: faellige Vormerkungen ausfuehren. Erst Ruhestellungen (machen Platz), dann Aktivierungen. */
export async function vormerkungenAusfuehren(pool: pg.Pool, now: Date = new Date()): Promise<{ ruhend: number; aktiv: number; offen: number }> {
  const heute = periodKeyHeute(now);
  const faellig = await pool.query<{ actorId: string; companyId: string; geplant: string; geplantTausch: string[] }>(
    `SELECT "actorId", "companyId", geplant, "geplantTausch" FROM "FirmenZustand" WHERE geplant IS NOT NULL AND "geplantAb" <= $1 ORDER BY "actorId", geplant DESC`,
    [heute],
  );
  let ruhend = 0;
  let aktiv = 0;
  let offen = 0;
  for (const row of faellig.rows.filter((r) => r.geplant === "ruhend")) {
    await upsert(pool, row.actorId, row.companyId, { zustand: "ruhend", quelle: "tausch", geplant: null, geplantAb: null });
    ruhend++;
  }
  for (const row of faellig.rows.filter((r) => r.geplant === "aktiv")) {
    try {
      const tenantId = await tenantFuerActor(pool, row.actorId);
      const e = await aktivieren(pool, { tenantId, actorId: row.actorId, companyIds: [row.companyId], quelle: "vormerkung", ab: "sofort" });
      if (e.ok && e.aktiv.includes(row.companyId)) aktiv++;
      else {
        // Passt noch nicht: Vormerkung bleibt (geplantAb in der Vergangenheit = wartet), Zustand ruhend.
        await upsert(pool, row.actorId, row.companyId, { zustand: "ruhend", geplant: "aktiv", geplantAb: heute, geplantTausch: row.geplantTausch });
        offen++;
      }
    } catch (err) {
      offen++;
      logger.warn({ actorId: row.actorId, companyId: row.companyId, err: err instanceof Error ? err.message : String(err) }, "[firmen-zustand] Vormerkung nicht ausgefuehrt");
    }
  }
  if (faellig.rows.length > 0) logger.info({ ruhend, aktiv, offen }, "[firmen-zustand] Vormerkungen ausgefuehrt");
  return { ruhend, aktiv, offen };
}

export interface ZustandUebersicht {
  gesamt: number;
  aktiv: number;
  ruhend: number;
  geplantAktiv: Array<{ companyId: string; name: string | null; ab: string; tausch: string[]; wartet: boolean }>;
  geplantRuhend: Array<{ companyId: string; name: string | null; ab: string }>;
  /** Aktive Firmen, die fuer einen Tausch infrage kommen (aelteste Aufnahme zuerst, ohne Buying Center). */
  tauschvorschlaege: Array<{ companyId: string; name: string | null; aktivSeit: string | null }>;
  /** Free: Aktivierungen auf Lebenszeit. */
  free: { genutzt: number; limit: number } | null;
}

export async function uebersicht(pool: pg.Pool, args: { tenantId: string; actorId: string }): Promise<ZustandUebersicht> {
  const r = await masterData<{ rows: Array<{ userId: string; companyId: string }> }>("POST", "/internal/transactions/companies-by-users", { userIds: [args.actorId] }).catch(() => ({ rows: [] as Array<{ userId: string; companyId: string }> }));
  const tomb = new Set((await pool.query<{ companyId: string }>(`SELECT "companyId" FROM "CompanyTombstone" WHERE "userId" = $1`, [args.actorId])).rows.map((x) => x.companyId));
  const alle = [...new Set((r.rows ?? []).map((x) => x.companyId))].filter((id) => !tomb.has(id));
  const ruhend = await ruhendeIds(pool, args.actorId);
  const aktive = alle.filter((id) => !ruhend.has(id));
  const heute = periodKeyHeute();
  const gep = await pool.query<{ companyId: string; geplant: string; geplantAb: string; geplantTausch: string[] }>(
    `SELECT "companyId", geplant, "geplantAb", "geplantTausch" FROM "FirmenZustand" WHERE "actorId" = $1 AND geplant IS NOT NULL`,
    [args.actorId],
  );
  const bc = new Set((await pool.query<{ companyId: string }>(`SELECT DISTINCT "companyId" FROM "BuyingCenter" WHERE "eigentuemerActorId" = $1`, [args.actorId]).catch(() => ({ rows: [] as Array<{ companyId: string }> }))).rows.map((x) => x.companyId));
  const billingAccountId = await resolveBillingAccountId(pool, { tenantId: args.tenantId, actorId: args.actorId });
  const seit = await pool.query<{ companyId: string; erst: Date }>(
    `SELECT "companyId", MIN("createdAt") AS erst FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "companyId" = ANY($2::text[]) GROUP BY "companyId"`,
    [billingAccountId, aktive],
  ).catch(() => ({ rows: [] as Array<{ companyId: string; erst: Date }> }));
  const seitMap = new Map(seit.rows.map((x) => [x.companyId, x.erst]));
  const vorschlaege = aktive
    .filter((id) => !bc.has(id))
    .sort((a, b) => (seitMap.get(a)?.getTime() ?? 0) - (seitMap.get(b)?.getTime() ?? 0))
    .slice(0, 10)
    .map((id) => ({ companyId: id, aktivSeit: seitMap.get(id)?.toISOString() ?? null }));
  const { resolveCompanyNames } = await import("./company-names");
  const namen = await resolveCompanyNames(pool, [...vorschlaege.map((v) => v.companyId), ...gep.rows.map((g) => g.companyId)]);
  const acc = await readBillingAccount(pool, billingAccountId);
  let free: ZustandUebersicht["free"] = null;
  if (acc && effectiveTier(acc) === "free") {
    const n = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2`, [billingAccountId, periodKeyFor("free")]);
    free = { genutzt: Number(n.rows[0]?.n ?? 0), limit: acc.quotaLimit };
  }
  return {
    gesamt: alle.length,
    aktiv: aktive.length,
    ruhend: alle.filter((id) => ruhend.has(id)).length,
    geplantAktiv: gep.rows.filter((g) => g.geplant === "aktiv").map((g) => ({ companyId: g.companyId, name: namen.get(g.companyId) ?? null, ab: g.geplantAb, tausch: g.geplantTausch ?? [], wartet: g.geplantAb <= heute })),
    geplantRuhend: gep.rows.filter((g) => g.geplant === "ruhend").map((g) => ({ companyId: g.companyId, name: namen.get(g.companyId) ?? null, ab: g.geplantAb })),
    tauschvorschlaege: vorschlaege.map((v) => ({ ...v, name: namen.get(v.companyId) ?? null })),
    free,
  };
}

/** Park-Weg (try-reserve verweigert): im Sitz-Modell wird die Firma ruhend statt geparkt. */
export async function ruhendDurchKontingent(actorId: string, companyId: string): Promise<void> {
  const pool = getGatewayPool();
  const vorhanden = await pool.query<{ geplant: string | null; geplantAb: string | null; geplantTausch: string[] }>(`SELECT geplant, "geplantAb", "geplantTausch" FROM "FirmenZustand" WHERE "actorId" = $1 AND "companyId" = $2`, [actorId, companyId]);
  const v = vorhanden.rows[0];
  await upsert(pool, actorId, companyId, { zustand: "ruhend", quelle: "kontingent", geplant: (v?.geplant as Zustand | null) ?? null, geplantAb: v?.geplantAb ?? null, geplantTausch: v?.geplantTausch ?? [] });
}
