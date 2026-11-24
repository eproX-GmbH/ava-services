// Server-Posten am Stripe-Abo der Organisation (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md §3.7, Z3).
//
// Ein Posten mit dem Preis STRIPE_PRICE_CLOUD am bestehenden Sitz-Abo; Menge = Mitglieder mit
// gebuchtem Server (nicht gelöscht, nicht abbestellt). Regeln wie bei Sitzen:
//   - einschalten  → Menge hoch mit SOFORTRECHNUNG (always_invoice); angelegt wird erst, wenn
//                    die Rechnung bezahlt ist (Webhook invoice.paid → zahlungEingegangen).
//   - abbestellen  → läuft bis Zyklusende (abbestelltZum), Menge sofort runter ohne Erstattung.
//   - widerrufen   → Abbestellung aufheben, Menge wieder hoch ohne neue Rechnung.
//   - wieder buchen nach Zyklusende → Sofortrechnung, die bezahlt sein muss (error_if_incomplete);
//                    scheitert sie, bleibt der Server pausiert und nichts ändert sich.
// Härtetest 2026-11-24: Jeder Schritt läuft unter einer Sperre je Organisation in EINER
// Transaktion mit dem Stripe-Aufruf (scheitert Stripe, wird die Datenbank zurückgerollt), eine
// zweite Abbestellung verschiebt das Ende nie nach hinten, und stündlich vergleicht
// `cloudPostenPruefen` die gebuchten Server mit dem Posten bei Stripe.
// Voraussetzung (E2): das Mitglied hat einen bezahlten Sitz. Einzelkämpfer ohne Abo gehen über
// den Checkout (Pro-Sitz + Server in einem Kauf).

import { mitModusVon, periodenEnde, stripePreis, stripeSchluesselDa } from "../stripe-client";
import { logger } from "../logger";
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

export const cloudPreisId = () => stripePreis("CLOUD") ?? "";

export class CloudAbrechnungFehler extends Error {
  constructor(readonly code: "nicht_eingerichtet" | "kein_mitglied" | "braucht_sitz" | "braucht_checkout" | "hat_abo" | "nicht_gebucht" | "vertrag" | "zahlung" | "stripe", text: string) {
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


/**
 * Server-Posten mit der Zahl gebuchter Server abgleichen. `sofortRechnung` nur beim Einschalten;
 * `zahlungPflicht`: Stripe übernimmt die Erhöhung nur, wenn die Sofortrechnung gleich bezahlt
 * ist, sonst Fehler 402 und keine Änderung (Wiederbuchen nach Zyklusende: der Server läuft
 * sofort wieder an, also muss das Geld vorher da sein).
 */
async function cloudStripeSyncImpl(q: Q, tenantId: string, opt: { sofortRechnung: boolean; zahlungPflicht?: boolean }): Promise<"kein_abo" | PostenAktion["art"]> {
  const acc = await readBillingAccount(q, tenantId);
  if (!acc?.stripeSubscriptionId) return "kein_abo";
  const priceId = cloudPreisId();
  if (!priceId || !stripeSchluesselDa()) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(acc.stripeSubscriptionId, { expand: ["items.data.price"] });
  const menge = await cloudMenge(q, tenantId);
  const a = postenAktion(sub.items.data.map((i) => ({ id: i.id, priceId: i.price?.id ?? null, quantity: i.quantity ?? null })), priceId, menge);
  const proration: Stripe.SubscriptionItemUpdateParams.ProrationBehavior = opt.sofortRechnung ? "always_invoice" : "none";
  const zahlung = opt.sofortRechnung && opt.zahlungPflicht ? { payment_behavior: "error_if_incomplete" as const } : {};
  if (a.art === "anlegen") await stripe.subscriptionItems.create({ subscription: sub.id, price: priceId, quantity: a.menge, proration_behavior: proration, ...zahlung });
  else if (a.art === "menge") await stripe.subscriptionItems.update(a.itemId, { quantity: a.menge, proration_behavior: a.hoch ? proration : "none", ...(a.hoch ? zahlung : {}) });
  else if (a.art === "entfernen") await stripe.subscriptionItems.del(a.itemId, { proration_behavior: "none" });
  return a.art;
}

/**
 * Abrechnungsschritte einer Organisation nacheinander (Doppelklick, zwei Tabs, Prüflauf) und
 * Datenbank + Stripe in einem Zug: Wirft der Stripe-Aufruf, wird alles zurückgerollt. Der
 * Stripe-Abgleich liest über dieselbe Verbindung und sieht so den neuen Stand.
 */
export async function mitSperre<T>(pool: pg.Pool, tenantId: string, f: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cloud-abrechnung:${tenantId}`]);
    const r = await f(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Stripe-Fehler in Sätze für die App; die Datenbank ist dann schon zurückgerollt. */
async function stripeSchritt<T>(tenantId: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof CloudAbrechnungFehler) throw e;
    const x = e as { type?: string; statusCode?: number; code?: string; message?: string };
    logger.warn({ tenantId, type: x?.type, code: x?.code, status: x?.statusCode, err: x?.message }, "[cloud] Stripe-Schritt fehlgeschlagen, nichts geändert");
    if (x?.type === "StripeCardError" || x?.statusCode === 402) {
      throw new CloudAbrechnungFehler("zahlung", "Die Zahlung hat nicht geklappt, der Server bleibt pausiert. Prüf die Zahlungsmethode in der Konsole unter Abrechnung und buch dann noch einmal.");
    }
    throw new CloudAbrechnungFehler("stripe", "Die Abrechnung ist gerade nicht erreichbar. Es hat sich nichts geändert, versuch es gleich noch einmal.");
  }
}

/**
 * Ende der bezahlten Periode für eine Abbestellung. Gespeichertes Ende nur, wenn es in der
 * Zukunft liegt; sonst bei Stripe nachsehen. Erst wenn es kein Abo gibt, gilt „sofort“.
 */
async function zyklusEnde(q: Q, tenantId: string): Promise<Date> {
  const jetzt = Date.now();
  const acc = await readBillingAccount(q, tenantId);
  if (acc?.periodEnd && acc.periodEnd.getTime() > jetzt) return acc.periodEnd;
  if (acc?.stripeSubscriptionId) {
    const ende = await mitModusVon(q, tenantId, async () => (stripeSchluesselDa() ? periodenEnde(await getStripe().subscriptions.retrieve(acc.stripeSubscriptionId!)) : null));
    if (ende && ende.getTime() > jetzt) return ende;
  }
  return new Date(jetzt);
}

/** Enthält eine Rechnung den Preis? Alte (line.price) und neue API-Form (line.pricing); null = nicht feststellbar. */
export function rechnungHatPreis(inv: unknown, priceId: string): boolean | null {
  const lines = (inv as { lines?: { data?: unknown[]; has_more?: boolean } } | null)?.lines;
  if (!priceId || !Array.isArray(lines?.data)) return null;
  const id = (p: unknown) => (typeof p === "string" ? p : (p as { id?: string } | null)?.id);
  const treffer = lines.data.some((l) => {
    const x = l as { price?: unknown; pricing?: { price_details?: { price?: unknown } } | null };
    return id(x.price) === priceId || id(x.pricing?.price_details?.price) === priceId;
  });
  return treffer ? true : lines.has_more ? null : false;
}

/**
 * Enterprise-Organisation mit Vertrag und ohne Stripe-Abo: Server laufen dort über den Vertrag
 * und werden vom Betreiber eingerichtet. Ohne diese Prüfung landeten ihre Admins im Kauf für
 * Neukunden (Pro-Sitz + Server über Stripe), Befund 2026-11-24.
 */
export async function cloudUeberVertrag(q: Q, tenantId: string): Promise<boolean> {
  const acc = await readBillingAccount(q, tenantId);
  if (!acc || acc.stripeSubscriptionId) return false;
  return (acc.mode as string) === "enterprise" || (acc.tier as string) === "enterprise";
}
export const VERTRAG_TEXT = "Für eure Organisation läuft der AVA-Server über den Vertrag. Schreib uns an info@eprox-gmbh.de, wir richten ihn ein.";
const vertragFehler = () => new CloudAbrechnungFehler("vertrag", VERTRAG_TEXT);

/** Hat das Mitglied einen bezahlten Sitz (E2)? */
async function hatSitz(q: Q, tenantId: string, actorId: string) {
  return (await sitzeLesen(q, tenantId)).some((s) => s.actorId === actorId);
}

/** Admin (oder Einzelkämpfer für sich) schaltet den Server für ein Mitglied ein. */
export async function cloudEinschalten(pool: pg.Pool, betrieb: CloudBetrieb, a: { tenantId: string; actorId: string; von: string }): Promise<CloudInstanz> {
  if (!cloudPreisId()) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  // Enterprise mit Vertrag: nie über Stripe, auch nicht das Wiederbuchen (sonst liefe er ohne Posten).
  if (await cloudUeberVertrag(pool, a.tenantId)) throw vertragFehler();
  const m = await pool.query(`SELECT 1 FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2 AND status = 'aktiv'`, [a.tenantId, a.actorId]);
  if (!m.rowCount) throw new CloudAbrechnungFehler("kein_mitglied", "Diese Person ist kein aktives Mitglied der Organisation.");
  const vorhanden = await mitSperre(pool, a.tenantId, async (c) => {
    const da = await c.query<{ id: string; abbestelltZum: Date | null }>(
      `SELECT id, "abbestelltZum" FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL FOR UPDATE`,
      [a.tenantId, a.actorId],
    );
    const z = da.rows[0];
    if (!z) return null;
    if (z.abbestelltZum) {
      // Vor Zyklusende: Abbestellung widerrufen, der Zeitraum ist bezahlt, keine neue Rechnung.
      // Danach (Server schon pausiert): wie eine neue Buchung sofort abrechnen, und zwar nur, wenn
      // die Rechnung gleich bezahlt ist; sonst wirft Stripe und alles bleibt, wie es war.
      const abgelaufen = z.abbestelltZum.getTime() <= Date.now();
      // Ohne Abo gäbe es keine Rechnung (Abgleich meldete „kein_abo“) und der Server liefe umsonst.
      if (abgelaufen) {
        const acc = await readBillingAccount(c, a.tenantId);
        if (!acc?.stripeSubscriptionId || acc.status === "canceled") {
          throw new CloudAbrechnungFehler("braucht_checkout", "Das Abo deiner Organisation ist beendet. Schließ in der Konsole unter Abrechnung ein neues ab und buch den Server dann wieder.");
        }
      }
      await c.query(`UPDATE "CloudInstanz" SET "abbestelltZum" = NULL, "gewuenscht" = 'laufen', "updatedAt" = now() WHERE id = $1`, [z.id]);
      await c.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, $2, 'admin', $3)`, [z.id, abgelaufen ? "wieder_gebucht" : "abbestellung_widerrufen", JSON.stringify({ von: a.von })]);
      await stripeSchritt(a.tenantId, () => cloudStripeSync(c, a.tenantId, { sofortRechnung: abgelaufen, zahlungPflicht: abgelaufen }));
    }
    return z.id;
  });
  if (vorhanden) return (await betrieb.stand(vorhanden)) as CloudInstanz;
  if (!(await hatSitz(pool, a.tenantId, a.actorId))) throw new CloudAbrechnungFehler("braucht_sitz", "Für den Server braucht die Person einen bezahlten Sitz.");
  const acc = await readBillingAccount(pool, a.tenantId);
  if (!acc?.stripeSubscriptionId) throw new CloudAbrechnungFehler("braucht_checkout", "Die Organisation hat noch kein Abo; bitte über den Kauf buchen.");
  return mitSperre(pool, a.tenantId, async (c) => {
    // Angelegt wird erst „zahlung_offen“; freigegeben nur durch die bezahlte Rechnung (Webhook).
    const z = await betrieb.anlegen({ tenantId: a.tenantId, actorId: a.actorId, quelle: "admin", zahlungOffen: true });
    if (z.zustand !== "zahlung_offen") return z; // gleichzeitige Buchung war schneller
    try {
      await stripeSchritt(a.tenantId, () => cloudStripeSync(c, a.tenantId, { sofortRechnung: true }));
    } catch (e) {
      // Ohne Rechnung keine Buchung: sonst gäbe eine spätere, fremde Zahlung der Organisation den Server frei.
      await pool.query(`UPDATE "CloudInstanz" SET zustand = 'geloescht', soll = 'gestoppt', gewuenscht = 'gestoppt', "geloeschtAt" = now(), "updatedAt" = now() WHERE id = $1 AND zustand = 'zahlung_offen'`, [z.id]);
      throw e;
    }
    await recordBillingEvent(c, { billingAccountId: a.tenantId, kind: "cloud_eingeschaltet", source: "admin", actorId: a.von, payload: { instanzId: z.id, fuer: a.actorId } });
    return z;
  });
}

/**
 * Welcher Weg zum Server offen ist (App-Karte): Owner/Admin mit Abo bucht dazu, ohne Abo über
 * den Kauf (Pro-Sitz + Server); Mitglieder fragen ihre Admins. Enterprise mit Vertrag: weder
 * buchen noch kaufen, der Server läuft über den Vertrag („vertrag“).
 */
export async function cloudWeg(pool: Q, tenantId: string, admin: boolean): Promise<"buchen" | "kaufen" | "anfragen" | "vertrag"> {
  if (!admin) return "anfragen";
  const acc = await readBillingAccount(pool, tenantId);
  if (acc?.stripeSubscriptionId) return "buchen";
  return (await cloudUeberVertrag(pool, tenantId)) ? "vertrag" : "kaufen";
}

/** Preise für die Anzeige (netto): Server allein und das Paket Pro + Server für den Kauf. */
export function cloudPreise(proCents: number): { serverCents: number; paketCents: number } {
  const v = Number(process.env.CLOUD_PREIS_CENTS);
  const serverCents = Number.isFinite(v) && v > 0 ? Math.round(v) : 5000;
  return { serverCents, paketCents: serverCents + proCents };
}

/**
 * Server abbestellen: läuft bis Zyklusende; nie bezahlte Buchungen verschwinden sofort.
 * Schon abbestellt: nichts verschieben. Ein späteres Ende gäbe einen abgelaufenen, pausierten
 * Server für die neue, unbezahlte Periode wieder frei (Härtetest 2026-11-24: zweiter Tab).
 */
export async function cloudAbbestellen(pool: pg.Pool, a: { tenantId: string; actorId: string; von: string }): Promise<{ bis: string | null }> {
  return mitSperre(pool, a.tenantId, async (c) => {
    const r = await c.query<{ id: string; zustand: string; abbestelltZum: Date | null }>(
      `SELECT id, zustand, "abbestelltZum" FROM "CloudInstanz" WHERE "tenantId" = $1 AND "actorId" = $2 AND "geloeschtAt" IS NULL FOR UPDATE`,
      [a.tenantId, a.actorId],
    );
    const z = r.rows[0];
    if (!z) throw new CloudAbrechnungFehler("nicht_gebucht", "Für diese Person ist kein Server gebucht.");
    if (z.abbestelltZum) return { bis: z.abbestelltZum.toISOString() };
    let bis: Date | null;
    if (z.zustand === "zahlung_offen") {
      // Nie bezahlt, nichts bei Fly: Buchung einfach zurücknehmen.
      await c.query(`UPDATE "CloudInstanz" SET zustand = 'geloescht', soll = 'gestoppt', gewuenscht = 'gestoppt', "geloeschtAt" = now(), "updatedAt" = now() WHERE id = $1`, [z.id]);
      bis = null;
    } else {
      bis = await stripeSchritt(a.tenantId, () => zyklusEnde(c, a.tenantId));
      await c.query(`UPDATE "CloudInstanz" SET "abbestelltZum" = $2, "updatedAt" = now() WHERE id = $1`, [z.id, bis]);
    }
    await c.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, 'abbestellt', 'admin', $2)`, [z.id, JSON.stringify({ von: a.von, bis: bis?.toISOString() ?? null })]);
    await stripeSchritt(a.tenantId, () => cloudStripeSync(c, a.tenantId, { sofortRechnung: false }));
    await recordBillingEvent(c, { billingAccountId: a.tenantId, kind: "cloud_abbestellt", source: "admin", actorId: a.von, payload: { instanzId: z.id, bis: bis?.toISOString() ?? null } });
    return { bis: bis?.toISOString() ?? null };
  });
}

/**
 * Abo der Organisation beendet (Status canceled): gebuchte Server gelten ab jetzt als abbestellt.
 * Sonst liefen sie mit einem späteren neuen Abo (etwa nur Sitze) stillschweigend wieder an,
 * ohne Server-Posten darauf. Zurück kommt der Server nur über „Wieder buchen“ (Sofortrechnung).
 */
export async function cloudAboBeendet(pool: pg.Pool, tenantId: string): Promise<number> {
  const acc = await readBillingAccount(pool, tenantId);
  if (acc?.status !== "canceled") return 0;
  return mitSperre(pool, tenantId, async (c) => {
    const r = await c.query<{ id: string }>(
      `UPDATE "CloudInstanz" SET "abbestelltZum" = now(), "updatedAt" = now()
        WHERE "tenantId" = $1 AND "geloeschtAt" IS NULL AND "abbestelltZum" IS NULL AND zustand <> 'zahlung_offen' RETURNING id`,
      [tenantId],
    );
    for (const z of r.rows) {
      await c.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, 'abbestellt', 'webhook', $2)`, [z.id, JSON.stringify({ grund: "abo_beendet" })]);
    }
    return r.rowCount ?? 0;
  });
}

/**
 * Webhook invoice.paid: Buchungen mit offener Zahlung freigeben (Anlegen übernimmt der Abgleicher).
 * Hat das Mitglied (Checkout-Weg) noch keinen Sitz, bekommt es einen freien.
 * Gibt die freigegebenen Instanzen zurück (für Mail M1).
 */
export async function cloudZahlungEingegangen(pool: pg.Pool, betrieb: CloudBetrieb, tenantId: string, rechnung?: unknown): Promise<CloudInstanz[]> {
  // Nur die Rechnung mit dem Server-Posten gibt frei, nicht irgendeine andere der Organisation
  // (etwa ein neuer Sitz), während die Server-Rechnung noch offen ist.
  if (rechnung !== undefined && rechnungHatPreis(rechnung, cloudPreisId()) === false) return [];
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
async function cloudCheckoutImpl(
  pool: pg.Pool,
  a: { tenantId: string; actorId: string; email: string | null; appUrl: string },
): Promise<{ url: string; sessionId: string }> {
  const cloud = cloudPreisId();
  const pro = priceIdForTier("pro");
  if (!cloud || !pro) throw new CloudAbrechnungFehler("nicht_eingerichtet", "Server-Buchung ist noch nicht eingerichtet.");
  if (await cloudUeberVertrag(pool, a.tenantId)) throw vertragFehler();
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
  const z = await betrieb.anlegen({ tenantId, actorId: fuer, quelle: "webhook", zahlungOffen: true });
  if (z.abbestelltZum && session.payment_status === "paid") {
    // Pausierter Server von früher (Abo beendet, Daten noch da): Der Kauf enthält den Server-Posten.
    await pool.query(`UPDATE "CloudInstanz" SET "abbestelltZum" = NULL, "gewuenscht" = 'laufen', "updatedAt" = now() WHERE id = $1`, [z.id]);
    await pool.query(`INSERT INTO "CloudEreignis" (id, "instanzId", art, quelle, details) VALUES (gen_random_uuid()::text, $1, 'wieder_gebucht', 'webhook', $2)`, [z.id, JSON.stringify({ ueber: "kauf" })]);
  }
  return session.payment_status === "paid" ? cloudZahlungEingegangen(pool, betrieb, tenantId) : [];
}

/**
 * Prüflauf (stündlich, nur Prod-Gateway): Stimmt der Server-Posten bei Stripe mit den gebuchten
 * Servern überein? Mehr gebucht als abgerechnet hieße „läuft, aber niemand zahlt“, weniger hieße
 * „Kunde zahlt zu viel“. Ändert nichts, liefert nur die Abweichungen für den Betreiber-Alarm.
 */
export async function cloudPostenPruefen(pool: pg.Pool): Promise<Array<{ tenantId: string; gebucht: number; abgerechnet: number }>> {
  const r = await pool.query<{ tenantId: string }>(
    `SELECT DISTINCT i."tenantId" FROM "CloudInstanz" i JOIN "TenantBilling" b ON b."tenantId" = i."tenantId"
      WHERE i."geloeschtAt" IS NULL AND b."stripeSubscriptionId" IS NOT NULL`,
  );
  const abweichungen: Array<{ tenantId: string; gebucht: number; abgerechnet: number }> = [];
  for (const { tenantId } of r.rows) {
    try {
      const x = await mitSperre(pool, tenantId, (c) =>
        mitModusVon(c, tenantId, async () => {
          const acc = await readBillingAccount(c, tenantId);
          const preis = cloudPreisId();
          if (!acc?.stripeSubscriptionId || !preis || !stripeSchluesselDa()) return null;
          const sub = await getStripe().subscriptions.retrieve(acc.stripeSubscriptionId, { expand: ["items.data.price"] });
          // Beendete Abos: Die Server stoppt der Abgleicher über den Abrechnungsstatus.
          if (sub.status === "canceled" || sub.status === "incomplete_expired") return null;
          const abgerechnet = sub.items.data.filter((i) => i.price?.id === preis).reduce((n, i) => n + (i.quantity ?? 0), 0);
          const gebucht = await cloudMenge(c, tenantId);
          return gebucht === abgerechnet ? null : { tenantId, gebucht, abgerechnet };
        }),
      );
      if (x) abweichungen.push(x);
    } catch (e) {
      logger.warn({ tenantId, err: e instanceof Error ? e.message : String(e) }, "[cloud] Prüflauf Server-Posten übersprungen");
    }
  }
  return abweichungen;
}

// Staging (docs/PLAN_STAGING.md ST4): Stripe-Aufrufe im Zahlungsmodus der Organisation.
export function cloudStripeSync(...a: Parameters<typeof cloudStripeSyncImpl>): ReturnType<typeof cloudStripeSyncImpl> {
  return mitModusVon(a[0], a[1], () => cloudStripeSyncImpl(...a));
}
export function cloudCheckout(...a: Parameters<typeof cloudCheckoutImpl>): ReturnType<typeof cloudCheckoutImpl> {
  return mitModusVon(a[0], a[1].tenantId, () => cloudCheckoutImpl(...a));
}
