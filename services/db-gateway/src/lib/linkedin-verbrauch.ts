// docs/PLAN_PRICING_TIERS.md P4 — LinkedIn-Beobachtung nach Verbrauch: Stand je
// Nutzer (oder Enterprise-Organisation), Limit, Vorabpruefung im Apify-Proxy und
// Monatsabrechnung als Rechnungsposten auf der Organisationsrechnung.
//
// Zaehlt nur Apify-Aufrufe mit kontext "linkedin" (Beobachtete Posts, Watchlist,
// Leads). Der Mitarbeiter-Abruf der Firmenverarbeitung (kontext
// "firmenverarbeitung") steckt im Stufenpreis und zaehlt hier nicht.

import type pg from "pg";
import { readBillingAccount, periodKeyFor } from "./billing";
import { pricingAktiv } from "./kontingent";
import { recordBillingEvent } from "./billing-events";
import { logger } from "./logger";

type Q = { query: pg.Pool["query"] };

export interface LinkedinStand {
  periodKey: string;
  /** Konto, an dem Limit und Verbrauch haengen: Nutzer, bei Enterprise die Organisation. */
  kontoId: string;
  enterprise: boolean;
  imVertrag: boolean;
  limitCents: number | null;
  verbrauchtCents: number;
  /** davon noch geschaetzt (Ist-Kosten liegen noch nicht vor). */
  geschaetztCents: number;
  jeFunktion: Record<string, number>;
  laeufe: number;
  uebrigCents: number | null;
}

/** Konto fuer die LinkedIn-Beobachtung: Enterprise → Organisation, sonst der Nutzer. */
export async function linkedinKonto(q: Q, tenantId: string, actorId: string): Promise<{ kontoId: string; enterprise: boolean; imVertrag: boolean; limitCents: number | null; tier: string }> {
  const org = tenantId !== actorId ? await readBillingAccount(q, tenantId) : null;
  if (org?.mode === "enterprise") return { kontoId: tenantId, enterprise: true, imVertrag: org.linkedinImVertrag, limitCents: org.linkedinLimitCents, tier: "enterprise" };
  const me = await readBillingAccount(q, actorId);
  return { kontoId: actorId, enterprise: false, imVertrag: false, limitCents: me?.linkedinLimitCents ?? null, tier: me?.tier ?? "free" };
}

export async function linkedinStand(q: Q, tenantId: string, actorId: string, periodKey = periodKeyFor("pro")): Promise<LinkedinStand> {
  const konto = await linkedinKonto(q, tenantId, actorId);
  const r = await q.query<{ quelle: string | null; n: string; preis: string | null; geschaetzt: string | null }>(
    `SELECT "quelle", COUNT(*)::text AS n, SUM("preisCents")::text AS preis,
            SUM(CASE WHEN "costMicroUsd" IS NULL THEN "preisCents" ELSE 0 END)::text AS geschaetzt
       FROM "LlmUsage"
      WHERE kind = 'apify' AND "kontext" = 'linkedin' AND status < 400
        AND ${konto.enterprise ? '"tenantId" = $1' : '"actorId" = $1'}
        AND to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM') = $2
      GROUP BY "quelle"`,
    [konto.kontoId, periodKey],
  );
  const jeFunktion: Record<string, number> = {};
  let verbraucht = 0;
  let geschaetzt = 0;
  let laeufe = 0;
  for (const row of r.rows) {
    const c = Number(row.preis ?? 0);
    jeFunktion[row.quelle ?? "sonstiges"] = (jeFunktion[row.quelle ?? "sonstiges"] ?? 0) + c;
    verbraucht += c;
    geschaetzt += Number(row.geschaetzt ?? 0);
    laeufe += Number(row.n);
  }
  return {
    periodKey, kontoId: konto.kontoId, enterprise: konto.enterprise, imVertrag: konto.imVertrag, limitCents: konto.limitCents,
    verbrauchtCents: verbraucht, geschaetztCents: geschaetzt, jeFunktion, laeufe,
    uebrigCents: konto.limitCents == null ? null : Math.max(0, konto.limitCents - verbraucht),
  };
}

export type LinkedinAblehnung = { ok: false; code: "linkedin_nicht_im_free_plan" | "linkedin_limit_fehlt" | "linkedin_limit_erreicht"; meldung: string; limitCents: number | null; verbrauchtCents: number; schaetzungCents: number };

/** Vorabpruefung vor einem Apify-Lauf der Beobachtung. Mit 20 % Puffer auf die Schaetzung. */
export async function linkedinPruefen(q: Q, tenantId: string, actorId: string, schaetzungCents: number): Promise<{ ok: true } | LinkedinAblehnung> {
  if (!pricingAktiv()) return { ok: true };
  const stand = await linkedinStand(q, tenantId, actorId);
  if (stand.enterprise) {
    if (stand.imVertrag || stand.limitCents == null) return { ok: true };
  } else {
    const konto = await linkedinKonto(q, tenantId, actorId);
    if (konto.tier === "free") return { ok: false, code: "linkedin_nicht_im_free_plan", meldung: "LinkedIn-Beobachtung gibt es ab dem Plan Pro.", limitCents: null, verbrauchtCents: stand.verbrauchtCents, schaetzungCents };
    if (stand.limitCents == null) return { ok: false, code: "linkedin_limit_fehlt", meldung: "Für die LinkedIn-Beobachtung muss zuerst ein Monatslimit gesetzt werden (Owner oder Admin).", limitCents: null, verbrauchtCents: stand.verbrauchtCents, schaetzungCents };
  }
  const mitPuffer = Math.round(schaetzungCents * 1.2);
  if (stand.verbrauchtCents + mitPuffer <= (stand.limitCents ?? 0)) return { ok: true };
  const euro = (c: number) => (c / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
  return {
    ok: false, code: "linkedin_limit_erreicht",
    meldung: `Das Monatslimit für die LinkedIn-Beobachtung (${euro(stand.limitCents ?? 0)}) ist erreicht: ${euro(stand.verbrauchtCents)} verbraucht, dieser Lauf kostet etwa ${euro(schaetzungCents)}. Limit erhöhen oder bis zum Monatsanfang warten.`,
    limitCents: stand.limitCents, verbrauchtCents: stand.verbrauchtCents, schaetzungCents,
  };
}

export async function linkedinLimitSetzen(q: Q, args: { kontoId: string; limitCents: number | null; von: string | null; tenantId: string }): Promise<void> {
  await q.query(`UPDATE "TenantBilling" SET "linkedinLimitCents" = $2, "updatedAt" = NOW() WHERE "tenantId" = $1`, [args.kontoId, args.limitCents]);
  await recordBillingEvent(q, { billingAccountId: args.tenantId, kind: "linkedin_limit_gesetzt", source: "admin", actorId: args.von, payload: { kontoId: args.kontoId, limitCents: args.limitCents } });
}

/**
 * Monatsabschluss: je Nutzer mit Verbrauch im Vormonat ein Rechnungsposten auf dem
 * Stripe-Kunden seiner Organisation (Sitz-Modell) bzw. seinem eigenen (Altabo).
 * Idempotent ueber BillingEvent linkedin_abgerechnet (periodKey, actorId).
 */
export async function linkedinAbrechnen(pool: pg.Pool, now: Date = new Date()): Promise<{ posten: number }> {
  if (!pricingAktiv() || !process.env.STRIPE_SECRET_KEY) return { posten: 0 };
  const vormonat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const periodKey = `${vormonat.getUTCFullYear()}-${String(vormonat.getUTCMonth() + 1).padStart(2, "0")}`;
  const r = await pool.query<{ tenantId: string; actorId: string; summe: string; laeufe: string }>(
    `SELECT "tenantId", "actorId", SUM("preisCents")::text AS summe, COUNT(*)::text AS laeufe FROM "LlmUsage"
      WHERE kind = 'apify' AND "kontext" = 'linkedin' AND status < 400 AND "preisCents" IS NOT NULL
        AND to_char("createdAt" AT TIME ZONE 'UTC', 'YYYY-MM') = $1
      GROUP BY "tenantId", "actorId"`,
    [periodKey],
  );
  const { getStripe } = await import("./stripe-client");
  const stripe = getStripe();
  let posten = 0;
  for (const row of r.rows) {
    const summe = Number(row.summe);
    if (summe <= 0) continue;
    const schon = await pool.query(
      `SELECT 1 FROM "BillingEvent" WHERE kind = 'linkedin_abgerechnet' AND payload->>'periodKey' = $1 AND payload->>'actorId' = $2 LIMIT 1`,
      [periodKey, row.actorId],
    );
    if (schon.rows[0]) continue;
    // Enterprise: manuell (Export), nur Ereignis festhalten.
    const org = await readBillingAccount(pool, row.tenantId);
    let kundeId: string | null = null;
    let kontoId = row.tenantId;
    if (org?.mode === "enterprise") {
      await recordBillingEvent(pool, { billingAccountId: row.tenantId, kind: "linkedin_abgerechnet", source: "cron", payload: { periodKey, actorId: row.actorId, cents: summe, laeufe: Number(row.laeufe), enterprise: true } });
      continue;
    }
    if (org?.mode === "sitze" && org.stripeCustomerId) kundeId = org.stripeCustomerId;
    else {
      const me = await readBillingAccount(pool, row.actorId);
      if (me?.stripeCustomerId) { kundeId = me.stripeCustomerId; kontoId = row.actorId; }
    }
    if (!kundeId) {
      logger.warn({ tenantId: row.tenantId, actorId: row.actorId, periodKey }, "[linkedin] kein Stripe-Kunde fuer Abrechnung");
      continue;
    }
    try {
      const name = (await pool.query<{ name: string | null; email: string | null }>(`SELECT "name", "email" FROM "TenantMember" WHERE "actorId" = $1 LIMIT 1`, [row.actorId])).rows[0];
      await stripe.invoiceItems.create(
        {
          customer: kundeId,
          amount: summe,
          currency: "eur",
          description: `LinkedIn-Beobachtung ${periodKey} (${name?.name ?? name?.email ?? row.actorId}, ${row.laeufe} Läufe)`,
          metadata: { tenantId: row.tenantId, actorId: row.actorId, periodKey, art: "linkedin" },
        },
        { idempotencyKey: `ava-linkedin-${row.tenantId}-${row.actorId}-${periodKey}` },
      );
      await recordBillingEvent(pool, { billingAccountId: kontoId, kind: "linkedin_abgerechnet", source: "cron", payload: { periodKey, actorId: row.actorId, cents: summe, laeufe: Number(row.laeufe), customerId: kundeId } });
      posten++;
    } catch (err) {
      logger.warn({ tenantId: row.tenantId, actorId: row.actorId, err: err instanceof Error ? err.message : String(err) }, "[linkedin] Rechnungsposten fehlgeschlagen");
    }
  }
  return { posten };
}
