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
import { ensureBillingAccount, invalidateBillingResolution, UNLIMITED, type BillingTier } from "./billing";
import { planEintrag, istSitzPlan, type SitzPlan } from "./billing-plans";
import { TenantError } from "./tenant-error";
import { recordBillingEvent } from "./billing-events";

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

export { monatsGrenzen, kontingentAusZeitraeumen } from "./kontingent-rechnung";
import { monatsGrenzen, kontingentAusZeitraeumen } from "./kontingent-rechnung";

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

// ---- P2 — Sitze kaufen, zuweisen, entziehen, reduzieren ---------------------
//
// Stripe (P3) haengt an sitzeStripeSync(): solange die Organisation kein Sitz-Abo
// bei Stripe hat (oder der Betreiber Sitze fuer Enterprise/Tests anlegt), bleiben
// die Zeilen ohne stripeItemId. Alle Funktionen laufen in der Transaktion des
// Aufrufers (PoolClient), damit Beitritt und Zuweisung atomar sind.


async function nutzerKontoSetzen(client: pg.PoolClient, actorId: string, plan: BillingTier | "free"): Promise<void> {
  await ensureBillingAccount(client, actorId, "personal");
  if (plan === "free") {
    await client.query(
      `UPDATE "TenantBilling" SET "mode" = 'none', "tier" = 'free', "quotaLimit" = 25, "paygFreigabePeriode" = NULL, "updatedAt" = NOW()
        WHERE "tenantId" = $1 AND "mode" IN ('sitz', 'none')`,
      [actorId],
    );
  } else {
    await client.query(
      `UPDATE "TenantBilling" SET "mode" = 'sitz', "tier" = $2, "quotaLimit" = $3, "status" = CASE WHEN "status" = 'canceled' THEN 'active' ELSE "status" END, "updatedAt" = NOW()
        WHERE "tenantId" = $1`,
      [actorId, plan, UNLIMITED],
    );
  }
  invalidateBillingResolution(actorId);
}

/** Legt `anzahl` freie Sitze eines Plans an (Stripe-Menge folgt in sitzeStripeSync). */
export async function sitzeKaufen(
  client: pg.PoolClient,
  args: { tenantId: string; plan: SitzPlan; anzahl: number; von: string | null },
): Promise<string[]> {
  if (args.anzahl < 1 || args.anzahl > 500) throw new TenantError(400, "Anzahl zwischen 1 und 500.");
  const ids: string[] = [];
  for (let i = 0; i < args.anzahl; i++) {
    const id = randomUUID();
    await client.query(`INSERT INTO "Sitz" ("id", "tenantId", "plan") VALUES ($1, $2, $3)`, [id, args.tenantId, args.plan]);
    ids.push(id);
  }
  await client.query(`UPDATE "TenantBilling" SET "mode" = CASE WHEN "mode" IN ('none', 'subscription', 'seats') THEN 'sitze' ELSE "mode" END, "kind" = 'organisation', "updatedAt" = NOW() WHERE "tenantId" = $1`, [args.tenantId]);
  await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitze_gekauft", source: "admin", actorId: args.von, payload: { plan: args.plan, anzahl: args.anzahl } });
  return ids;
}

/**
 * Weist einem Mitglied einen Sitz zu. Freier Sitz des Plans zuerst (aeltester);
 * keiner frei und `kaufen` → ein neuer Sitz. Ein bisheriger Sitz des Mitglieds
 * wird frei. Schreibt PlanZeitraum und das Nutzerkonto (mode sitz, tier = plan).
 */
export async function sitzZuweisen(
  client: pg.PoolClient,
  args: { tenantId: string; actorId: string; plan: SitzPlan; von: string | null; kaufen?: boolean },
): Promise<{ sitzId: string; gekauft: boolean }> {
  const mitglied = await client.query(`SELECT 1 FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [args.tenantId, args.actorId]);
  if (!mitglied.rows[0]) throw new TenantError(404, "Kein Mitglied dieser Organisation.");
  const bisher = await sitzVon(client, args.actorId);
  if (bisher && bisher.plan === args.plan && bisher.tenantId === args.tenantId) return { sitzId: bisher.id, gekauft: false };
  let frei = await client.query<{ id: string }>(
    `SELECT "id" FROM "Sitz" WHERE "tenantId" = $1 AND "plan" = $2 AND "actorId" IS NULL AND "endetAm" IS NULL AND "reduziertZum" IS NULL ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [args.tenantId, args.plan],
  );
  let gekauft = false;
  if (!frei.rows[0]) {
    if (!args.kaufen) throw new TenantError(409, `Kein freier ${args.plan === "pro" ? "Pro" : args.plan === "max" ? "Max" : "Ultra"}-Sitz. Erst einen Sitz dazukaufen.`);
    const [id] = await sitzeKaufen(client, { tenantId: args.tenantId, plan: args.plan, anzahl: 1, von: args.von });
    frei = { rows: [{ id: id! }] } as typeof frei;
    gekauft = true;
  }
  const sitzId = frei.rows[0]!.id;
  const jetzt = new Date();
  if (bisher) await client.query(`UPDATE "Sitz" SET "actorId" = NULL, "zugewiesenAm" = NULL, "zugewiesenVon" = NULL WHERE "id" = $1`, [bisher.id]);
  await client.query(`UPDATE "Sitz" SET "actorId" = $2, "zugewiesenAm" = $3, "zugewiesenVon" = $4 WHERE "id" = $1`, [sitzId, args.actorId, jetzt, args.von]);
  await planZeitraumSetzen(client, { actorId: args.actorId, tenantId: args.tenantId, plan: args.plan, sitzId, ab: jetzt });
  await nutzerKontoSetzen(client, args.actorId, args.plan);
  await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitz_zugewiesen", source: "admin", actorId: args.von, payload: { memberId: args.actorId, plan: args.plan, sitzId, gekauft, vorher: bisher?.plan ?? "free" } });
  return { sitzId, gekauft };
}

/** Nimmt einem Mitglied den Sitz (wird frei); das Mitglied ist danach Free — nur,
 *  wenn ein Free-Platz frei ist. `austritt` ueberspringt die Free-Pruefung. */
export async function sitzEntziehen(
  client: pg.PoolClient,
  args: { tenantId: string; actorId: string; von: string | null; austritt?: boolean },
): Promise<{ hatteSitz: boolean }> {
  const bisher = await sitzVon(client, args.actorId);
  if (!bisher) return { hatteSitz: false };
  if (!args.austritt) {
    const { freeBelegt } = await freeUndWartend(client, args.tenantId);
    if (freeBelegt >= FREE_PLAETZE) {
      throw new TenantError(409, `Alle ${FREE_PLAETZE} Free-Plätze sind belegt. Weise einen anderen Sitz zu oder entferne das Mitglied.`);
    }
  }
  await client.query(`UPDATE "Sitz" SET "actorId" = NULL, "zugewiesenAm" = NULL, "zugewiesenVon" = NULL WHERE "id" = $1`, [bisher.id]);
  await planZeitraumSetzen(client, { actorId: args.actorId, tenantId: args.tenantId, plan: "free", sitzId: null });
  await nutzerKontoSetzen(client, args.actorId, "free");
  await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitz_entzogen", source: "admin", actorId: args.von, payload: { memberId: args.actorId, plan: bisher.plan, sitzId: bisher.id, austritt: Boolean(args.austritt) } });
  return { hatteSitz: true };
}

/** Prueft, ob ein weiteres Free-Mitglied Platz hat (3 je Organisation). */
export async function freePlatzPruefen(client: pg.PoolClient, tenantId: string, zusaetzlich = 1): Promise<void> {
  const { freeBelegt } = await freeUndWartend(client, tenantId);
  if (freeBelegt + zusaetzlich > FREE_PLAETZE) {
    throw new TenantError(409, `Eure Organisation hat schon ${FREE_PLAETZE} Mitglieder im Free-Plan. Weise einem davon einen Sitz zu oder nimm das neue Mitglied mit einem Sitz auf.`);
  }
}

/** Merkt die Reduktion freier Sitze eines Plans zum Zyklusende vor (nur freie Sitze). */
export async function sitzeReduzieren(
  client: pg.PoolClient,
  args: { tenantId: string; plan: SitzPlan; anzahl: number; zum: Date; von: string | null },
): Promise<number> {
  const frei = await client.query<{ id: string }>(
    `SELECT "id" FROM "Sitz" WHERE "tenantId" = $1 AND "plan" = $2 AND "actorId" IS NULL AND "endetAm" IS NULL AND "reduziertZum" IS NULL ORDER BY "createdAt" DESC LIMIT $3 FOR UPDATE`,
    [args.tenantId, args.plan, Math.max(0, args.anzahl)],
  );
  for (const z of frei.rows) await client.query(`UPDATE "Sitz" SET "reduziertZum" = $2 WHERE "id" = $1`, [z.id, args.zum]);
  if (frei.rows.length > 0) await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitze_reduktion_geplant", source: "admin", actorId: args.von, payload: { plan: args.plan, anzahl: frei.rows.length, zum: args.zum.toISOString() } });
  return frei.rows.length;
}

export async function reduktionWiderrufen(client: pg.PoolClient, args: { tenantId: string; plan: SitzPlan; von: string | null }): Promise<number> {
  const r = await client.query(`UPDATE "Sitz" SET "reduziertZum" = NULL WHERE "tenantId" = $1 AND "plan" = $2 AND "endetAm" IS NULL AND "reduziertZum" IS NOT NULL`, [args.tenantId, args.plan]);
  if ((r.rowCount ?? 0) > 0) await recordBillingEvent(client, { billingAccountId: args.tenantId, kind: "sitze_reduktion_widerrufen", source: "admin", actorId: args.von, payload: { plan: args.plan, anzahl: r.rowCount } });
  return r.rowCount ?? 0;
}

/** Cron: faellige Reduktionen ausfuehren (freie Sitze beenden). */
export async function faelligeReduktionenAusfuehren(q: Q, now: Date = new Date()): Promise<number> {
  const r = await q.query(`UPDATE "Sitz" SET "endetAm" = $1 WHERE "endetAm" IS NULL AND "actorId" IS NULL AND "reduziertZum" IS NOT NULL AND "reduziertZum" <= $1`, [now]);
  return r.rowCount ?? 0;
}

/** P3 — Stripe-Mengen je Plan mit der Sitz-Tabelle abgleichen (lib/sitze-stripe.ts).
 *  Fehler werden geloggt, nie geworfen: die Sitz-Tabelle ist die Wahrheit, Stripe folgt
 *  (der Webhook/Reconcile gleicht spaeter nach). */
export async function sitzeStripeSync(q: Q, tenantId: string, opts: { proration: "create_prorations" | "none" } = { proration: "create_prorations" }): Promise<void> {
  try {
    const { sitzeStripeSyncAusfuehren } = await import("./sitze-stripe");
    await sitzeStripeSyncAusfuehren(q, tenantId, opts);
  } catch (err) {
    const { logger } = await import("./logger");
    logger.warn({ tenantId, err: err instanceof Error ? err.message : String(err) }, "[sitze] Stripe-Abgleich fehlgeschlagen");
  }
}
