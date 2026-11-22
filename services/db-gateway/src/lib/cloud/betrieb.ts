// Ein Cloud-Betrieb je Gateway-Prozess (die Sperre „ein Vorgang je Instanz“ lebt darin) und der
// Takt des Abgleichers (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z2).

import { getGatewayPool } from "../producer-pools";
import { logger } from "../logger";
import { kontoSperre } from "../konto-loeschen";
import { betreiberBenachrichtigen } from "../problem-meldungen";
import { flyKunden, flyKundenEingerichtet } from "./fly-maschinen";
import { CloudBetrieb, pgRepo } from "./instanzen";
import { abgleichen, faktenAusDb, type AbgleichBericht, type CloudNachricht } from "./abgleich";
import type { CloudInstanz } from "./instanzen";
import { loadEnv } from "../env";
import { mailKonto, mailSenden } from "../mail/versand";
import { serverBezahltMail, serverLaeuftWiederMail, serverPausiertMail, serverZahlungOffenMail, type Mail } from "../mail/vorlagen";

let betrieb: CloudBetrieb | null = null;
export function cloudBetrieb(): CloudBetrieb {
  betrieb ??= new CloudBetrieb(pgRepo(getGatewayPool()), flyKunden);
  return betrieb;
}

const TAKT_MS = 5 * 60_000;
let laeuft: Promise<AbgleichBericht> | null = null;
let letzter: { at: string; bericht: AbgleichBericht } | null = null;
export const letzterAbgleich = () => letzter;

function deps() {
  const pool = getGatewayPool();
  return { repo: pgRepo(pool), fly: flyKunden, betrieb: cloudBetrieb(), fakten: faktenAusDb(pool, kontoSperre), melden: betreiberBenachrichtigen, benachrichtigen: cloudMailen, warnen: (d: Record<string, unknown>, t: string) => logger.warn(d, t) };
}

/** Ein Lauf (oder nur eine Instanz); nie zwei Volllläufe gleichzeitig. */
export async function cloudAbgleich(nur?: string): Promise<AbgleichBericht> {
  if (process.env.CLOUD_ABGLEICH === "0") return { geprueft: 0, aktionen: { abgeschaltet: 1 }, fehler: 0, waisen: [] };
  if (!flyKundenEingerichtet()) return { geprueft: 0, aktionen: { nicht_eingerichtet: 1 }, fehler: 0, waisen: [] };
  if (!nur && laeuft) return laeuft;
  const p = abgleichen(deps(), nur);
  if (!nur) laeuft = p;
  try {
    const bericht = await p;
    if (!nur) letzter = { at: new Date().toISOString(), bericht };
    const taten = Object.entries(bericht.aktionen).filter(([a]) => a !== "nichts" && a !== "gesundheit");
    if (taten.length || bericht.fehler) logger.info({ ...bericht, nur }, "[cloud-abgleich] Lauf");
    return bericht;
  } finally {
    if (!nur) laeuft = null;
  }
}

/** Sofort nach einem Ereignis (Webhook, Admin-Aktion) für eine Instanz abgleichen. */
export function cloudAbgleichAnstossen(instanzId?: string): void {
  setImmediate(() => void cloudAbgleich(instanzId).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Anstoß fehlgeschlagen")));
}

export function startCloudAbgleich(): void {
  if (process.env.CLOUD_ABGLEICH === "0") { logger.info("[cloud-abgleich] aus (CLOUD_ABGLEICH=0)"); return; }
  if (!flyKundenEingerichtet()) { logger.info("[cloud-abgleich] nicht eingerichtet (FLY_KUNDEN_TOKEN fehlt)"); return; }
  const tick = () => void cloudAbgleich().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Lauf fehlgeschlagen"));
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, TAKT_MS).unref?.();
  logger.info("[cloud-abgleich] alle 5 Minuten, erster Lauf in 1 Minute");
}

// ---- Mails an Nutzer und Admins (§10.4) ---------------------------------------------

type MailArt = CloudNachricht | "bezahlt";
const ZAHLUNGSMAILS = new Set<MailArt>(["zahlung_offen"]);

async function empfaenger(tenantId: string, actorId: string, auchAdmins: boolean) {
  const r = await getGatewayPool().query<{ actorId: string; email: string | null; name: string | null; role: string }>(
    `SELECT "actorId", email, name, role FROM "TenantMember" WHERE "tenantId" = $1 AND status = 'aktiv' AND ("actorId" = $2 OR ($3 AND role IN ('owner', 'admin')))`,
    [tenantId, actorId, auchAdmins],
  );
  return r.rows.filter((x) => x.email);
}

/** Nutzer der Instanz immer; bei Zahlungsthemen zusätzlich Owner/Admins (höchstens 1 je Art in 20 h). */
export async function cloudMailen(art: MailArt, i: CloudInstanz, extra: Record<string, unknown> = {}): Promise<void> {
  const pool = getGatewayPool();
  const env = loadEnv();
  const konsole = (process.env.ADMIN_KONSOLE_URL ?? "https://admin.ava.bi").replace(/\/+$/, "");
  const zahlungsthema = ZAHLUNGSMAILS.has(art) || (art === "pausiert" && (extra.grund === "zahlung" || extra.grund === "kuendigung"));
  for (const e of await empfaenger(i.tenantId, i.actorId, zahlungsthema)) {
    const istNutzer = e.actorId === i.actorId;
    const mailArt = `server_${art === "zahlung_offen" ? "zahlung_offen" : art === "bezahlt" ? "bezahlt" : art}`;
    if (!istNutzer) {
      const schon = await pool.query(`SELECT 1 FROM "MailVersand" WHERE "actorId" = $1 AND art = $2 AND "createdAt" > now() - interval '20 hours' LIMIT 1`, [e.actorId, mailArt]);
      if (schon.rowCount) continue;
    }
    const vorname = e.name?.split(/\s+/)[0] ?? null;
    const basis = { vorname, appUrl: env.AVA_APP_URL };
    // Wer zahlt: Admins in der Konsole, Einzelkämpfer (Owner) in der App.
    const zahlungUrl = e.role === "owner" || e.role === "admin" ? `${konsole}/abrechnung` : `${env.AVA_APP_URL.replace(/\/+$/, "")}/mehr`;
    let mail: Mail;
    if (art === "bezahlt") mail = serverBezahltMail(basis);
    else if (art === "zahlung_offen") mail = serverZahlungOffenMail({ ...basis, stufe: (extra.stufe as 0 | 3 | 6) ?? 0, pauseAm: String(extra.pauseAm ?? new Date().toISOString()), zahlungUrl });
    else if (art === "pausiert") mail = serverPausiertMail({ ...basis, grund: (extra.grund as "zahlung" | "kuendigung" | "abbestellt" | "admin") ?? "admin", loeschenAb: String(extra.loeschenAb ?? new Date().toISOString()), zahlungUrl });
    else mail = serverLaeuftWiederMail(basis);
    const konto = await mailKonto(pool, { actorId: e.actorId, email: e.email!, vorname });
    await mailSenden(pool, konto, mailArt, mail);
  }
}

// ---- Anstöße aus dem Stripe-Webhook (Z3) ---------------------------------------------

/**
 * Nach einem Stripe-Ereignis: bezahlte Buchungen freigeben (+ Mail M1) und alle Server der
 * Organisation abgleichen (Pause bzw. Wiederanlauf, Erinnerungen). Wirft nie: der Webhook
 * der Abrechnung darf daran nicht scheitern.
 */
export async function cloudNachStripe(tenantId: string, art: "bezahlt" | "fehlgeschlagen" | "abo" | "checkout", session?: { metadata?: Record<string, string> | null; payment_status?: string | null }): Promise<void> {
  try {
    const pool = getGatewayPool();
    const { cloudCheckoutAbgeschlossen, cloudZahlungEingegangen } = await import("./abrechnung");
    const frei = art === "checkout" && session
      ? await cloudCheckoutAbgeschlossen(pool, cloudBetrieb(), session, tenantId)
      : art === "bezahlt" ? await cloudZahlungEingegangen(pool, cloudBetrieb(), tenantId) : [];
    for (const z of frei) await cloudMailen("bezahlt", z).catch((err) => logger.warn({ id: z.id, err: err instanceof Error ? err.message : String(err) }, "[cloud] Mail M1 fehlgeschlagen"));
    const r = await pool.query<{ id: string }>(`SELECT id FROM "CloudInstanz" WHERE "tenantId" = $1 AND "geloeschtAt" IS NULL`, [tenantId]);
    for (const x of r.rows) cloudAbgleichAnstossen(x.id);
  } catch (err) {
    logger.warn({ tenantId, art, err: err instanceof Error ? err.message : String(err) }, "[cloud] Stripe-Anstoß fehlgeschlagen");
  }
}
