// docs/PLAN_PRICING_TIERS.md P2 (2026-11-02) — Kontingent je Nutzer: Stand,
// Kostenschaetzung neuer Firmen und die Vorabpruefung an jedem Aufnahmeweg.
//
// Gilt fuer Konten im Modus "sitz" (Nutzer mit zugewiesenem Sitz) und fuer
// Enterprise-Organisationen mit Firmen-Limit. Free bleibt beim alten Weg
// (25 Firmen lebenslang), Altabos (mode subscription) ebenfalls, bis sie
// migriert sind. Alles hinter dem Schalter PRICING_TIERS=1.

import type pg from "pg";
import { readBillingAccount, effectiveTier, periodKeyFor, resolveBillingAccountId, type BillingTier } from "./billing";
import { planEintrag, planKatalog, istSitzPlan } from "./billing-plans";
import { stufenPreise, type Stufe } from "./stufen";
import { getProducerPool } from "./producer-pools";
import { kontingentCents as kontingentJeNutzer } from "./sitze";

type Q = { query: pg.Pool["query"] };

export function pricingAktiv(): boolean {
  return process.env.PRICING_TIERS === "1";
}

/** Vorsichtiger Preis fuer eine Firma ohne bekannte Stufe (Cent). */
const PREIS_UNBEKANNT = 100;

export interface KontingentStand {
  periodKey: string;
  plan: BillingTier;
  /** Tagesanteiliges Monatskontingent in Cent; null = Enterprise (Vertrag). */
  kontingentCents: number | null;
  anteilig: boolean;
  stufen: { klein: number; mittel: number; gross: number; offen: number };
  bestandswertCents: number;
  neuverarbeitungCents: number;
  verbrauchtCents: number;
  /** null = Enterprise ohne Limit. */
  uebrigCents: number | null;
  payg: { moeglich: boolean; freigegeben: boolean; limitCents: number | null; ueberCents: number };
  enterprise: { firmenLimit: number | null; firmenImBestand: number } | null;
}

export async function kontingentStand(q: Q, billingAccountId: string): Promise<KontingentStand | null> {
  const acc = await readBillingAccount(q, billingAccountId);
  if (!acc) return null;
  const tier = effectiveTier(acc);
  const periodKey = periodKeyFor(tier === "free" ? "pro" : tier);
  const r = await q.query<{ stufe: string | null; n: string; preis: string | null }>(
    `SELECT "stufe", COUNT(*)::text AS n, SUM("preisCents")::text AS preis FROM "UsageEntry"
      WHERE "billingAccountId" = $1 AND "periodKey" = $2 GROUP BY "stufe"`,
    [billingAccountId, periodKey],
  );
  const stufen = { klein: 0, mittel: 0, gross: 0, offen: 0 };
  let bestandswert = 0;
  for (const row of r.rows) {
    const n = Number(row.n);
    if (row.stufe === "klein" || row.stufe === "mittel" || row.stufe === "gross") stufen[row.stufe] += n;
    else {
      stufen.offen += n;
      bestandswert += n * PREIS_UNBEKANNT;
    }
    bestandswert += Number(row.preis ?? 0);
  }
  const nv = await q.query<{ summe: string | null }>(
    `SELECT SUM(COALESCE("preisCents", $3))::text AS summe FROM "NeuverarbeitungEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2`,
    [billingAccountId, periodKey, PREIS_UNBEKANNT],
  );
  const neuverarbeitung = Number(nv.rows[0]?.summe ?? 0);
  const verbraucht = bestandswert + neuverarbeitung;

  if (acc.mode === "enterprise") {
    const firmen = stufen.klein + stufen.mittel + stufen.gross + stufen.offen;
    return {
      periodKey, plan: "enterprise", kontingentCents: null, anteilig: false, stufen, bestandswertCents: bestandswert,
      neuverarbeitungCents: neuverarbeitung, verbrauchtCents: verbraucht, uebrigCents: null,
      payg: { moeglich: false, freigegeben: false, limitCents: null, ueberCents: 0 },
      enterprise: { firmenLimit: acc.firmenLimit ?? null, firmenImBestand: firmen },
    };
  }
  const k = await kontingentJeNutzer(q, billingAccountId, periodKey);
  const kont = k.kontingentCents ?? 0;
  const plan = k.planHeute === "free" && tier !== "free" ? tier : k.planHeute;
  const eintrag = planEintrag(plan);
  const freigegeben = acc.paygFreigabePeriode === periodKey;
  return {
    periodKey, plan, kontingentCents: kont, anteilig: k.anteilig, stufen, bestandswertCents: bestandswert,
    neuverarbeitungCents: neuverarbeitung, verbrauchtCents: verbraucht, uebrigCents: Math.max(0, kont - verbraucht),
    payg: { moeglich: eintrag.payg, freigegeben: eintrag.payg && freigegeben, limitCents: acc.paygLimitCents ?? null, ueberCents: Math.max(0, verbraucht - kont) },
    enterprise: null,
  };
}

/** Stufe einer Pool-Firma aus den Kontaktdaten (wie stufeErmitteln, aber fuer viele). */
async function poolStufen(companyIds: string[]): Promise<Map<string, Stufe>> {
  const out = new Map<string, Stufe>();
  if (companyIds.length === 0) return out;
  const { grossAb } = await import("./stufen");
  const schwelle = grossAb();
  const pool = getProducerPool("company-contact");
  const r = await pool.query<{ companyId: string; apify: string; personen: string }>(
    `SELECT c.id AS "companyId",
            (SELECT count(DISTINCT o."personId") FROM "Observation" o WHERE o."companyId" = c.id AND o.source LIKE 'apify%')::text AS apify,
            (SELECT count(*) FROM "Employment" e WHERE e."companyId" = c.id AND e."isCurrent")::text AS personen
       FROM "Company" c WHERE c.id = ANY($1::text[])`,
    [companyIds],
  ).catch(() => ({ rows: [] as Array<{ companyId: string; apify: string; personen: string }> }));
  for (const row of r.rows) {
    const apify = Number(row.apify);
    const personen = Number(row.personen);
    out.set(row.companyId, apify === 0 ? "klein" : apify >= schwelle || personen >= schwelle ? "gross" : "mittel");
  }
  return out;
}

/** Kosten je neuer Firma in Cent: schon im Monatsbestand → 0 (ausser Neuverarbeitung),
 *  bekannte Pool-Stufe → Stufenpreis, sonst vorsichtig 1,00 €. */
export async function kostenSchaetzung(
  q: Q,
  billingAccountId: string,
  periodKey: string,
  companyIds: string[],
  opts: { neuverarbeitung?: boolean } = {},
): Promise<Array<{ companyId: string; cents: number; imBestand: boolean; stufe: Stufe | null }>> {
  const preise = stufenPreise();
  const imBestand = new Set(
    (await q.query<{ companyId: string }>(`SELECT "companyId" FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2 AND "companyId" = ANY($3::text[])`, [billingAccountId, periodKey, companyIds])).rows.map((r) => r.companyId),
  );
  const stufen = await poolStufen(companyIds);
  return companyIds.map((id) => {
    const stufe = stufen.get(id) ?? null;
    const preis = stufe ? preise[stufe].preisCents : PREIS_UNBEKANNT;
    const drin = imBestand.has(id);
    return { companyId: id, stufe, imBestand: drin, cents: drin && !opts.neuverarbeitung ? 0 : preis };
  });
}

export interface KontingentAblehnung {
  ok: false;
  code: "kontingent_erschoepft" | "firmen_limit";
  fehltCents: number;
  /** Firmen (in Reihenfolge der Anfrage), die noch ins Kontingent passen. */
  passenNoch: string[];
  passenNochAnzahl: number;
  naechsterPlan: BillingTier | null;
  paygMoeglich: boolean;
  kannSelbstWechseln: boolean;
  plan: BillingTier;
  kontingentCents: number | null;
  verbrauchtCents: number;
  benoetigtCents: number;
  meldung: string;
}

async function kannSelbstWechseln(q: Q, tenantId: string, actorId: string | null): Promise<boolean> {
  if (!actorId || actorId === tenantId) return true;
  const r = await q.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  const role = r.rows[0]?.role;
  return role === "owner" || role === "admin";
}

function naechsterPlanFuer(plan: BillingTier, benoetigtGesamtCents: number): BillingTier | null {
  const rang = planEintrag(plan).rang;
  for (const p of planKatalog()) {
    if (!istSitzPlan(p.plan) || p.rang <= rang) continue;
    if ((p.kontingentCents ?? 0) >= benoetigtGesamtCents) return p.plan;
  }
  // Keiner reicht ganz: der groesste Sitzplan (dort ggf. Pay-as-you-go).
  return rang < 3 ? "ultra" : null;
}

/**
 * Vorabpruefung: reicht das Kontingent des Kontos fuer diese Firmen?
 * `anzahl` statt `companyIds`, wenn die Firmen noch nicht bekannt sind (Listenimport).
 * Konten ausserhalb des Sitz-Modells (free, subscription, seats) geben immer ok.
 */
export async function kontingentPruefen(
  q: Q,
  args: { tenantId: string; actorId: string | null; companyIds?: string[]; anzahl?: number; neuverarbeitung?: boolean },
): Promise<{ ok: true; billingAccountId: string | null } | KontingentAblehnung> {
  if (!pricingAktiv()) return { ok: true, billingAccountId: null };
  const billingAccountId = await resolveBillingAccountId(q, { tenantId: args.tenantId, actorId: args.actorId });
  const acc = await readBillingAccount(q, billingAccountId);
  if (!acc) return { ok: true, billingAccountId };
  if (acc.mode !== "sitz" && acc.mode !== "enterprise") return { ok: true, billingAccountId };
  const stand = await kontingentStand(q, billingAccountId);
  if (!stand) return { ok: true, billingAccountId };
  const selbst = await kannSelbstWechseln(q, args.tenantId, args.actorId);

  // Enterprise: nur ein optionales Firmen-Limit des Betreibers.
  if (stand.enterprise) {
    const limit = stand.enterprise.firmenLimit;
    if (limit == null) return { ok: true, billingAccountId };
    const neu = args.companyIds
      ? (await kostenSchaetzung(q, billingAccountId, stand.periodKey, args.companyIds)).filter((k) => !k.imBestand).length
      : (args.anzahl ?? 0);
    if (stand.enterprise.firmenImBestand + neu <= limit) return { ok: true, billingAccountId };
    const platz = Math.max(0, limit - stand.enterprise.firmenImBestand);
    return {
      ok: false, code: "firmen_limit", fehltCents: 0, passenNoch: (args.companyIds ?? []).slice(0, platz), passenNochAnzahl: platz,
      naechsterPlan: null, paygMoeglich: false, kannSelbstWechseln: false, plan: "enterprise", kontingentCents: null,
      verbrauchtCents: stand.verbrauchtCents, benoetigtCents: 0,
      meldung: `Das Firmen-Limit eurer Organisation (${limit}) ist erreicht. Bitte wendet euch an AVA.`,
    };
  }

  const kont = stand.kontingentCents ?? 0;
  if (stand.payg.freigegeben) {
    // Ueber das Kontingent hinaus erlaubt; nur der eigene Deckel zaehlt.
    const deckel = stand.payg.limitCents;
    if (deckel == null) return { ok: true, billingAccountId };
    const kosten = args.companyIds
      ? (await kostenSchaetzung(q, billingAccountId, stand.periodKey, args.companyIds, { neuverarbeitung: args.neuverarbeitung })).reduce((s, k) => s + k.cents, 0)
      : (args.anzahl ?? 0) * PREIS_UNBEKANNT;
    if (stand.verbrauchtCents + kosten <= kont + deckel) return { ok: true, billingAccountId };
  }
  const uebrig = Math.max(0, kont - stand.verbrauchtCents);
  let schaetzung: Array<{ companyId: string; cents: number }>;
  if (args.companyIds) schaetzung = await kostenSchaetzung(q, billingAccountId, stand.periodKey, args.companyIds, { neuverarbeitung: args.neuverarbeitung });
  else schaetzung = Array.from({ length: args.anzahl ?? 0 }, (_, i) => ({ companyId: `#${i}`, cents: PREIS_UNBEKANNT }));
  const benoetigt = schaetzung.reduce((s, k) => s + k.cents, 0);
  if (benoetigt <= uebrig) return { ok: true, billingAccountId };
  const passen: string[] = [];
  let rest = uebrig;
  for (const k of schaetzung) {
    if (k.cents <= rest) { passen.push(k.companyId); rest -= k.cents; }
    else if (k.cents === 0) passen.push(k.companyId);
  }
  const fehlt = benoetigt - uebrig;
  const naechster = naechsterPlanFuer(stand.plan, stand.verbrauchtCents + benoetigt);
  const euro = (c: number) => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  return {
    ok: false, code: "kontingent_erschoepft", fehltCents: fehlt, passenNoch: args.companyIds ? passen : [], passenNochAnzahl: passen.length,
    naechsterPlan: naechster, paygMoeglich: stand.payg.moeglich && !stand.payg.freigegeben, kannSelbstWechseln: selbst,
    plan: stand.plan, kontingentCents: kont, verbrauchtCents: stand.verbrauchtCents, benoetigtCents: benoetigt,
    meldung: `Dein Kontingent reicht für ${passen.length} von ${schaetzung.length} Firmen (${euro(uebrig)} übrig, benötigt ${euro(benoetigt)}).`,
  };
}
