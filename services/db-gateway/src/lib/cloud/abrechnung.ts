// Server-Posten am Stripe-Abo der Organisation (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3.7, Z3).
//
// Ein Posten mit dem Preis STRIPE_PRICE_CLOUD am bestehenden Sitz-Abo; Menge = Mitglieder mit
// gebuchtem Server (nicht gelöscht, nicht abbestellt). Regeln wie bei Sitzen:
//   - einschalten  → Menge hoch mit SOFORTRECHNUNG (always_invoice); angelegt wird erst, wenn
//                    die Rechnung bezahlt ist (Webhook invoice.paid → zahlungEingegangen).
//   - abbestellen  → läuft bis Zyklusende (abbestelltZum), Menge sofort runter ohne Erstattung.
//   - widerrufen   → Abbestellung aufheben, Menge wieder hoch ohne neue Rechnung.
// Voraussetzung (E2): das Mitglied hat einen bezahlten Sitz. Einzelkämpfer ohne Abo gehen über
// den Checkout (Pro-Sitz + Server in einem Kauf).

import type pg from "pg";
import type Stripe from "stripe";
import { getStripe } from "../stripe-client";
import { readBillingAccount } from "../billing";
import { recordBillingEvent } from "../billing-events";
import { priceIdForTier } from "../billing-plans";
import { sitzeLesen, sitzZuweisen } from "../sitze";
import type { CloudBetrieb, CloudInstanz } from "./instanzen";
import { postenAktion, type PostenAktion } from "./posten";

export { postenAktion, type PostenAktion };

type Q = { query: pg.Pool["query"] };

export const cloudPreisId = () => process.env.STRIPE_PRICE_CLOUD?.trim() || "";

export class CloudAbrechnungFehler extends Error {
  constructor(readonly code: "nicht_eingerichtet" | "kein_mitglied" | "braucht_sitz" | "braucht_checkout" | "hat_abo" | "nicht_gebucht", text: string) {
    super(text);
  }
}

/** Gebuchte Server einer Organisation (zahlung_offen zählt mit: die Rechnung läuft schon). */
export async function cloudMenge(q: Q, tenantId: string): Promise<number> {
  const r = await q.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM "CloudInstanz" WHERE "tenantId" = $1 AND "geloeschtAt" IS NULL AND "abbestelltZum" IS NULL`,
    [tenantId],
  );
  return Number(r.rows[0]?.n ?? 0);
}


/** Server-Posten mit der Zahl gebuchter Server abgleichen. `sofortRechnung` nur beim Einschalten. */
export async function cloudStripeSync(q: Q, tenantId: string, opt: { sofortRechnung: boolean }): Promise<"kein_abo" | PostenAktion["art"]> {
  const priceId = cloudPreisId();
  if (!priceId || !process.env.STRIPE_SECRET_KEY) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  const acc = await readBillingAccount(q, tenantId);
  if (!acc?.stripeSubscriptionId) return "kein_abo";
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(acc.stripeSubscriptionId, { expand: ["items.data.price"] });
  const menge = await cloudMenge(q, tenantId);
  const a = postenAktion(sub.items.data.map((i) => ({ id: i.id, priceId: i.price?.id ?? null, quantity: i.quantity ?? null })), priceId, menge);
  const proration: Stripe.SubscriptionItemUpdateParams.ProrationBehavior = opt.sofortRechnung ? "always_invoice" : "none";
  if (a.art === "anlegen") await stripe.subscriptionItems.create({ subscription: sub.id, price: priceId, quantity: a.menge, proration_behavior: proration });
  else if (a.art === "menge") await stripe.subscriptionItems.update(a.itemId, { quantity: a.menge, proration_behavior: a.hoch ? proration : "none" });
  else if (a.art === "entfernen") await stripe.subscriptionItems.del(a.itemId, { proration_behavior: "none" });
  return a.art;
}

/** Hat das Mitglied einen bezahlten Sitz (E2)? */
async function hatSitz(q: Q, tenantId: string, actorId: string) {
  return (await sitzeLesen(q, tenantId)).some((s) => s.actorId === actorId);
}

/** Admin (oder Einzelkämpfer für sich) schaltet den Server für ein Mitglied ein. */
export async function cloudEinschalten(pool: pg.Pool, betrieb: CloudBetrieb, a: { tenantId: string; actorId: string; von: string }): Promise<CloudInstanz> {
  if (!cloudPreisId()) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  const m = await pool.query(`SELECT 1 FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2 AND status = 'aktiv'`, [a.tenantId, a.actorId]);
  if (!m.rowCount) throw new CloudAbrechnungFehler("kein_mitglied", "Diese Person ist kein aktives Mitglied der Organisation.");
  const da = await pool.query<{ id: string; abbestelltZum: Date | null }>(`SELECT id, "abbestelltZum" FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL`, [a.tenantId, a.actorId]);
  if (da.rows[0]) {
    if (da.rows[0].abbestelltZum) {
      // Vor Zyklusende: Abbestellung widerrufen, der Zeitraum ist bezahlt, keine neue Rechnung.
      // Danach (Server schon pausiert): wie eine neue Buchung sofort abrechnen.
      const abgelaufen = da.rows[0].abbestelltZum.getTime() <= Date.now();
      await pool.query(`UPDATE "CloudInstanz" SET "abbestelltZum" = NULL, "gewuenscht" = 'laufen', "updatedAt" = now() WHERE id = $1`, [da.rows[0].id]);
      await pool.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, $2, 'admin', $3)`, [da.rows[0].id, abgelaufen ? "wieder_gebucht" : "abbestellung_widerrufen", JSON.stringify({ von: a.von })]);
      await cloudStripeSync(pool, a.tenantId, { sofortRechnung: abgelaufen });
    }
    return (await betrieb.stand(da.rows[0].id)) as CloudInstanz;
  }
  if (!(await hatSitz(pool, a.tenantId, a.actorId))) throw new CloudAbrechnungFehler("braucht_sitz", "Für den Server braucht die Person einen bezahlten Sitz.");
  const acc = await readBillingAccount(pool, a.tenantId);
  if (!acc?.stripeSubscriptionId) throw new CloudAbrechnungFehler("braucht_checkout", "Die Organisation hat noch kein Abo; bitte über den Kauf buchen.");
  const z = await betrieb.anlegen({ tenantId: a.tenantId, actorId: a.actorId, quelle: "admin", zahlungOffen: true });
  await cloudStripeSync(pool, a.tenantId, { sofortRechnung: true });
  await recordBillingEvent(pool, { billingAccountId: a.tenantId, kind: "cloud_eingeschaltet", source: "admin", actorId: a.von, payload: { instanzId: z.id, fuer: a.actorId } });
  return z;
}

/**
 * Welcher Weg zum Server offen ist (App-Karte): Owner/Admin mit Abo bucht dazu, ohne Abo über
 * den Kauf (Pro-Sitz + Server); Mitglieder fragen ihre Admins.
 */
export async function cloudWeg(pool: pg.Pool, tenantId: string, admin: boolean): Promise<"buchen" | "kaufen" | "anfragen"> {
  if (!admin) return "anfragen";
  const acc = await readBillingAccount(pool, tenantId);
  return acc?.stripeSubscriptionId ? "buchen" : "kaufen";
}

/** Preise für die Anzeige (netto): Server allein und das Paket Pro + Server für den Kauf. */
export function cloudPreise(proCents: number): { serverCents: number; paketCents: number } {
  const v = Number(process.env.CLOUD_PREIS_CENTS);
  const serverCents = Number.isFinite(v) && v > 0 ? Math.round(v) : 5000;
  return { serverCents, paketCents: serverCents + proCents };
}

/** Server abbestellen: läuft bis Zyklusende; nie bezahlte Buchungen verschwinden sofort. */
export async function cloudAbbestellen(pool: pg.Pool, a: { tenantId: string; actorId: string; von: string }): Promise<{ bis: string | null }> {
  const r = await pool.query<{ id: string; zustand: string }>(`SELECT id, zustand FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL`, [a.tenantId, a.actorId]);
  const z = r.rows[0];
  if (!z) throw new CloudAbrechnungFehler("nicht_gebucht", "Für diese Person ist kein Server gebucht.");
  let bis: Date | null;
  if (z.zustand === "zahlung_offen") {
    // Nie bezahlt, nichts bei Fly: Buchung einfach zurücknehmen.
    await pool.query(`UPDATE "CloudInstanz" SET zustand = 'geloescht', soll = 'gestoppt', gewuenscht = 'gestoppt', "geloeschtAt" = now(), "updatedAt" = now() WHERE id = $1`, [z.id]);
    bis = null;
  } else {
    const acc = await readBillingAccount(pool, a.tenantId);
    bis = acc?.periodEnd ?? new Date();
    await pool.query(`UPDATE "CloudInstanz" SET "abbestelltZum" = $2, "updatedAt" = now() WHERE id = $1`, [z.id, bis]);
  }
  await pool.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, 'abbestellt', 'admin', $2)`, [z.id, JSON.stringify({ von: a.von, bis: bis?.toISOString() ?? null })]);
  await cloudStripeSync(pool, a.tenantId, { sofortRechnung: false }).catch(() => "kein_abo");
  await recordBillingEvent(pool, { billingAccountId: a.tenantId, kind: "cloud_abbestellt", source: "admin", actorId: a.von, payload: { instanzId: z.id, bis: bis?.toISOString() ?? null } });
  return { bis: bis?.toISOString() ?? null };
}

/**
 * Webhook invoice.paid: Buchungen mit offener Zahlung freigeben (Anlegen übernimmt der Abgleicher).
 * Hat das Mitglied (Checkout-Weg) noch keinen Sitz, bekommt es einen freien.
 * Gibt die freigegebenen Instanzen zurück (für Mail M1).
 */
export async function cloudZahlungEingegangen(pool: pg.Pool, betrieb: CloudBetrieb, tenantId: string): Promise<CloudInstanz[]> {
  const offen = await pool.query<{ id: string; actorId: string }>(`SELECT id, "actorId" FROM "CloudInstanz" WHERE "tenantId" = $1 AND zustand = 'zahlung_offen' AND "geloeschtAt" IS NULL`, [tenantId]);
  const frei: CloudInstanz[] = [];
  for (const o of offen.rows) {
    const z = await betrieb.freigeben(o.id, "webhook");
    if (!z) continue; // ein gleichzeitiger Webhook hat schon freigegeben (und den Sitz vergeben)
    frei.push(z);
    if (!(await hatSitz(pool, tenantId, o.actorId))) {
      const freierSitz = (await sitzeLesen(pool, tenantId)).find((s) => !s.actorId && !s.reduziertZum);
      if (freierSitz) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await sitzZuweisen(client, { tenantId, actorId: o.actorId, plan: freierSitz.plan, von: o.actorId });
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw e;
        } finally {
          client.release();
        }
      }
    }
  }
  return frei;
}

/** Einzelkämpfer ohne Abo: ein Kauf mit Pro-Sitz (falls nötig) und Server. */
export async function cloudCheckout(
  pool: pg.Pool,
  a: { tenantId: string; actorId: string; email: string | null; appUrl: string },
): Promise<{ url: string; sessionId: string }> {
  const cloud = cloudPreisId();
  const pro = priceIdForTier("pro");
  if (!cloud || !pro) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  const acc = await readBillingAccount(pool, a.tenantId);
  if (acc?.stripeSubscriptionId) throw new CloudAbrechnungFehler("hat_abo", "Es gibt schon ein Abo; der Server wird dort dazugebucht.");
  const mitSitz = await hatSitz(pool, a.tenantId, a.actorId);
  const basis = a.appUrl.replace(/\/+$/, "");
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [...(mitSitz ? [] : [{ price: pro, quantity: 1 }]), { price: cloud, quantity: 1 }],
    client_reference_id: a.tenantId,
    metadata: { tenantId: a.tenantId, sitze: "1", plan: "pro", anzahl: mitSitz ? "0" : "1", von: a.actorId, cloudFuer: a.actorId },
    subscription_data: { metadata: { tenantId: a.tenantId, sitze: "1" } },
    automatic_tax: { enabled: true },
    success_url: `${basis}/mehr?server=gebucht&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${basis}/mehr?server=abgebrochen`,
    ...(acc?.stripeCustomerId ? { customer: acc.stripeCustomerId } : a.email ? { customer_email: a.email } : {}),
  });
  await recordBillingEvent(pool, { billingAccountId: a.tenantId, kind: "cloud_checkout_gestartet", source: "admin", actorId: a.actorId, payload: { sessionId: session.id, mitSitz } });
  return { url: session.url ?? "", sessionId: session.id };
}

/** Webhook checkout.session.completed mit `cloudFuer`: Buchung anlegen (bezahlt → gleich freigeben). */
export async function cloudCheckoutAbgeschlossen(pool: pg.Pool, betrieb: CloudBetrieb, session: { metadata?: Record<string, string> | null; payment_status?: string | null }, tenantId: string): Promise<CloudInstanz[]> {
  const fuer = session.metadata?.cloudFuer;
  if (!fuer) return [];
  await betrieb.anlegen({ tenantId, actorId: fuer, quelle: "webhook", zahlungOffen: true });
  return session.payment_status === "paid" ? cloudZahlungEingegangen(pool, betrieb, tenantId) : [];
}
