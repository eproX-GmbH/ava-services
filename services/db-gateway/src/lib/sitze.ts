// docs/PLAN_PRICING_TIERS.md P1/P2 (2026-11-02) — Sitze je Organisation und
// tagesanteiliges Monatskontingent je Nutzer.
//
// Modell: Die Organisation kauft Sitze der Plaene pro | max | ultra (Tabelle
// "Sitz", Mengen = Stripe-Abo-Positionen) und weist sie Mitgliedern zu. Jede
// Zuweisung oeffnet einen "PlanZeitraum" fuer den Nutzer; das Kontingent eines
// Kalendermonats ist die Summe ueber die Tage von Kontingent(Plan am Tag) /
// Tage im Monat. Mitglieder ohne Sitz sind Free (hoechstens FREE_PLAETZE je
// Organisation), Enterprise-Mitglieder tragen den Plan "enterprise".

import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { BillingTier } from "./billing";
import { planEintrag, istSitzPlan, type SitzPlan } from "./billing-plans";

type Q = { query: pg.Pool["query"] };

/** Hoechstzahl kostenloser Mitglieder je Organisation (Joyce, 2026-11-01). */
export const FREE_PLAETZE = 3;

export interface SitzZeile {
  id: string;
  tenantId: string;
  plan: SitzPlan;
  stripeItemId: string | null;
  actorId: string | null;
  zugewiesenAm: Date | null;
  endetAm: Date | null;
  reduziertZum: Date | null;
}

export interface SitzeStand {
  tenantId: string;
  jePlan: Record<SitzPlan, { gekauft: number; belegt: number; frei: number; reduktionGeplant: number }>;
  freeBelegt: number;
  freePlaetze: number;
  wartend: number;
}

/** Laufende Sitze einer Organisation. */
export async function sitzeLesen(q: Q, tenantId: string): Promise<SitzZeile[]> {
  const r = await q.query<SitzZeile>(
    `SELECT "id", "tenantId", "plan", "stripeItemId", "actorId", "zugewiesenAm", "endetAm", "reduziertZum"
       FROM "Sitz" WHERE "tenantId" = $1 AND "endetAm" IS NULL ORDER BY "createdAt"`,
    [tenantId],
  );
  return r.rows.filter((z) => istSitzPlan(z.plan));
}

/** Anzahl der Mitglieder ohne Sitz (aktiv) und der wartenden Mitglieder. */
export async function freeUndWartend(q: Q, tenantId: string): Promise<{ freeBelegt: number; wartend: number }> {
  const r = await q.query<{ status: string; actorId: string }>(
    `SELECT m."actorId", m."status" FROM "TenantMember" m WHERE m."tenantId" = $1`,
    [tenantId],
  );
  const mitSitz = new Set((await sitzeLesen(q, tenantId)).map((s) => s.actorId).filter((a): a is string => Boolean(a)));
  let freeBelegt = 0;
  let wartend = 0;
  for (const m of r.rows) {
    if (m.status === "wartend") wartend += 1;
    else if (!mitSitz.has(m.actorId)) freeBelegt += 1;
  }
  return { freeBelegt, wartend };
}

export async function sitzeStand(q: Q, tenantId: string): Promise<SitzeStand> {
  const sitze = await sitzeLesen(q, tenantId);
  const jePlan = {
    pro: { gekauft: 0, belegt: 0, frei: 0, reduktionGeplant: 0 },
    max: { gekauft: 0, belegt: 0, frei: 0, reduktionGeplant: 0 },
    ultra: { gekauft: 0, belegt: 0, frei: 0, reduktionGeplant: 0 },
  } satisfies SitzeStand["jePlan"];
  for (const s of sitze) {
    const z = jePlan[s.plan];
    z.gekauft += 1;
    if (s.actorId) z.belegt += 1;
    else z.frei += 1;
    if (s.reduziertZum) z.reduktionGeplant += 1;
  }
  const { freeBelegt, wartend } = await freeUndWartend(q, tenantId);
  return { tenantId, jePlan, freeBelegt, freePlaetze: Math.max(0, FREE_PLAETZE - freeBelegt), wartend };
}

/** Aktiver Sitz eines Nutzers (hoechstens einer). */
export async function sitzVon(q: Q, actorId: string): Promise<SitzZeile | null> {
  const r = await q.query<SitzZeile>(
    `SELECT "id", "tenantId", "plan", "stripeItemId", "actorId", "zugewiesenAm", "endetAm", "reduziertZum"
       FROM "Sitz" WHERE "actorId" = $1 AND "endetAm" IS NULL ORDER BY "zugewiesenAm" DESC LIMIT 1`,
    [actorId],
  );
  const z = r.rows[0];
  return z && istSitzPlan(z.plan) ? z : null;
}

/** Oeffnet einen neuen PlanZeitraum fuer den Nutzer und schliesst den vorigen. */
export async function planZeitraumSetzen(
  client: pg.PoolClient,
  args: { actorId: string; tenantId: string; plan: BillingTier; sitzId: string | null; ab?: Date },
): Promise<void> {
  const ab = args.ab ?? new Date();
  await client.query(`UPDATE "PlanZeitraum" SET "bis" = $2 WHERE "actorId" = $1 AND "bis" IS NULL AND "ab" < $2`, [args.actorId, ab]);
  // Ein Zeitraum, der erst in der Zukunft beginnt (z. B. vorgemerkt), wird ersetzt.
  await client.query(`DELETE FROM "PlanZeitraum" WHERE "actorId" = $1 AND "bis" IS NULL AND "ab" >= $2`, [args.actorId, ab]);
  await client.query(
    `INSERT INTO "PlanZeitraum" ("id", "actorId", "tenantId", "plan", "sitzId", "ab") VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), args.actorId, args.tenantId, args.plan, args.sitzId, ab],
  );
}

/** Grenzen eines Kalendermonats (UTC) aus einem periodKey YYYY-MM. */
export function monatsGrenzen(periodKey: string): { von: Date; bis: Date; tage: number } {
  const [y, m] = periodKey.split("-").map(Number);
  const von = new Date(Date.UTC(y, m - 1, 1));
  const bis = new Date(Date.UTC(y, m, 1));
  return { von, bis, tage: Math.round((bis.getTime() - von.getTime()) / 86_400_000) };
}

/**
 * Tagesanteiliges Monatskontingent eines Nutzers in Cent: Summe ueber die Tage
 * des Monats von Kontingent(Plan am Tag) / Tage im Monat. Tage ohne Zeitraum
 * zaehlen als Free (0). Enterprise liefert null (Vertrag/Betreiber-Limit).
 * `stand` begrenzt die Rechnung auf den Teil des Monats bis heute, wenn der
 * Monat noch laeuft (damit das Kontingent am 10. nicht schon den 30. enthaelt);
 * standardmaessig wird der ganze Monat gerechnet, weil die Vorabpruefung gegen
 * den Monatsbestand laeuft.
 */
/** Reine Rechnung fuer kontingentCents (testbar ohne Datenbank). */
export function kontingentAusZeitraeumen(
  zeitraeume: Array<{ plan: string; ab: Date; bis: Date | null }>,
  periodKey: string,
  jetzt: Date = new Date(),
): { kontingentCents: number | null; planHeute: BillingTier; anteilig: boolean } {
  const { von, bis, tage } = monatsGrenzen(periodKey);
  let summe = 0;
  let anteilig = false;
  let enterprise = false;
  let planHeute: BillingTier = "free";
  let abgedeckt = 0;
  for (const z of zeitraeume) {
    const plan = z.plan as BillingTier;
    if (plan === "enterprise") enterprise = true;
    const k = planEintrag(plan).kontingentCents ?? 0;
    const a = Math.max(z.ab.getTime(), von.getTime());
    const b = Math.min((z.bis ?? bis).getTime(), bis.getTime());
    const tageImMonat = Math.max(0, (b - a) / 86_400_000);
    abgedeckt += tageImMonat;
    summe += (k * tageImMonat) / tage;
    if (z.ab <= jetzt && (!z.bis || z.bis > jetzt)) planHeute = plan;
  }
  // Anteilig, sobald der Monat nicht durchgehend mit demselben Kontingent belegt ist.
  if (zeitraeume.length > 0 && (abgedeckt < tage - 0.01 || new Set(zeitraeume.map((z) => z.plan)).size > 1)) anteilig = true;
  if (enterprise) return { kontingentCents: null, planHeute: "enterprise", anteilig: false };
  return { kontingentCents: Math.round(summe), planHeute, anteilig };
}

export async function kontingentCents(
  q: Q,
  actorId: string,
  periodKey: string,
): Promise<{ kontingentCents: number | null; planHeute: BillingTier; anteilig: boolean }> {
  const { von, bis } = monatsGrenzen(periodKey);
  const r = await q.query<{ plan: string; ab: Date; bis: Date | null }>(
    `SELECT "plan", "ab", "bis" FROM "PlanZeitraum" WHERE "actorId" = $1 AND "ab" < $3 AND ("bis" IS NULL OR "bis" > $2) ORDER BY "ab"`,
    [actorId, von, bis],
  );
  return kontingentAusZeitraeumen(r.rows, periodKey);
}
