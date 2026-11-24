// Ein Cloud-Betrieb je Gateway-Prozess (die Sperre „ein Vorgang je Instanz“ lebt darin) und der
// Takt des Abgleichers (docs/PLAN_CLOUD_SELBSTBEDIENUNG.md Z2).

import { getGatewayPool } from "../producer-pools";
import { logger } from "../logger";
import { kontoSperre } from "../konto-loeschen";
import { betreiberBenachrichtigen } from "../problem-meldungen";
import { flyKunden, flyKundenEingerichtet, kundenImageVersionen } from "./fly-maschinen";
import { bedientKonto, gatewayRolle, kandidatenVermerken, kanalVon, neueKandidaten, releasesLesen, zielVersion, type Kanal } from "../kanal";
import { CloudBetrieb, pgRepo } from "./instanzen";
import { abgleichen, faktenAusDb, type AbgleichBericht, type CloudNachricht } from "./abgleich";
import { pgRollouts, type RolloutDeps } from "./rollout";
import type { CloudInstanz } from "./instanzen";
import { bestaetigenToken, bestaetigungsLink } from "./anmeldung";
import { kopfRelais } from "../kopf-relais";
import { loadEnv } from "../env";
import { linkAdressen, mailKonto, mailSenden } from "../mail/versand";
import {
  serverBestaetigenMail, serverBezahltMail, serverGeloeschtMail, serverLaeuftMail, serverLaeuftWiederMail, serverLoeschungMail,
  serverAktualisiertMail, serverNichtErreichbarMail, serverPausiertMail, serverUpdateHinweisMail, serverWiederErreichbarMail, serverZahlungOffenMail, type Mail,
} from "../mail/vorlagen";

let betrieb: CloudBetrieb | null = null;
export function cloudBetrieb(): CloudBetrieb {
  betrieb ??= new CloudBetrieb(pgRepo(getGatewayPool()), flyKunden, { version: (z) => zielVersionFuer(kanalVon(z.actorId)) });
  return betrieb;
}

/**
 * Staging (docs/PLAN_STAGING.md): Version für einen Kanal aus Registry-Tags und Freigaben.
 * Ein fest gesetztes CLOUD_IMAGE_VERSION gilt weiter für alle (Notbremse). Neue Tags werden
 * dabei als Kandidaten vermerkt.
 */
export async function zielVersionFuer(kanal: Kanal): Promise<string | null> {
  const fest = process.env.CLOUD_IMAGE_VERSION?.trim().replace(/^v/, "");
  if (fest) return fest;
  const pool = getGatewayPool();
  const tags = await kundenImageVersionen();
  let zeilen = await releasesLesen(pool);
  const neu = neueKandidaten(tags, zeilen, "server");
  if (neu.length) {
    await kandidatenVermerken(pool, neu, "server");
    zeilen = await releasesLesen(pool);
  }
  return zielVersion(tags, zeilen, kanal);
}

const TAKT_MS = 5 * 60_000;
let laeuft: Promise<AbgleichBericht> | null = null;
let letzter: { at: string; bericht: AbgleichBericht } | null = null;
export const letzterAbgleich = () => letzter;

function deps() {
  const pool = getGatewayPool();
  return {
    repo: pgRepo(pool), fly: flyKunden, betrieb: cloudBetrieb(), fakten: faktenAusDb(pool, kontoSperre), melden: betreiberMelden, benachrichtigen: cloudMailen,
    warnen: (d: Record<string, unknown>, t: string) => logger.warn(d, t),
    // Z7: Updates in Wellen; Betreiber-Instanzen = Organisation des Betreibers.
    // Staging: dieses Gateway gleicht nur Instanzen seines Kanals ab (Prod alle übrigen).
    rollout: {
      rollouts: pgRollouts(pool), betreiberTenant: process.env.OPERATOR_TENANT_ID?.trim() || null,
      kanal: gatewayRolle(), zielVersion: () => zielVersionFuer(gatewayRolle()),
    },
    zustaendig: (i: CloudInstanz) => bedientKonto(i.actorId),
    waisen: gatewayRolle() === "prod",
  };
}

/** Für „Jetzt aktualisieren“ und die Betreiber-Routen (Z7). */
export function rolloutDeps(): RolloutDeps {
  const d = deps();
  return { repo: d.repo, fly: d.fly, betrieb: d.betrieb, melden: d.melden, benachrichtigen: d.benachrichtigen, warnen: d.warnen, ...d.rollout };
}

/**
 * Betreiber-Alarm: immer ins Protokoll, dazu Telegram (OPERATOR_TELEGRAM_*) und, falls
 * CLOUD_BETREIBER_MAIL gesetzt ist, eine kurze Mail. Ohne beides blieben Alarme sonst unbemerkt.
 */
async function betreiberMelden(text: string): Promise<void> {
  logger.warn({ alarm: text }, "[cloud-abgleich] Betreiber-Alarm");
  const telegram = await betreiberBenachrichtigen(text).catch(() => false);
  const an = process.env.CLOUD_BETREIBER_MAIL?.trim();
  if (!an || telegram) return;
  const pool = getGatewayPool();
  // Kein Eintrag in MailEinstellung: feste Betreiber-Adresse, kein Abmelde-Token nötig.
  const konto = { actorId: "betreiber-cloud", email: an, vorname: null, token: "betreiber", neuigkeiten: false, abgemeldet: false };
  const zeile = text.replace(/[<>&]/g, "");
  await mailSenden(pool, konto, "server_betreiber_alarm", { betreff: `AVA Cloud: ${zeile.slice(0, 90)}`, html: `<p style="font-family:sans-serif">${zeile}</p>`, text: zeile });
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
  verbindungEinhaken();
  if (process.env.CLOUD_ABGLEICH === "0") { logger.info("[cloud-abgleich] aus (CLOUD_ABGLEICH=0)"); return; }
  if (!flyKundenEingerichtet()) { logger.info("[cloud-abgleich] nicht eingerichtet (FLY_KUNDEN_TOKEN fehlt)"); return; }
  const tick = () => void cloudAbgleich().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud-abgleich] Lauf fehlgeschlagen"));
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, TAKT_MS).unref?.();
  logger.info("[cloud-abgleich] alle 5 Minuten, erster Lauf in 1 Minute");
}

// ---- Mails an Nutzer und Admins (§10.4) ---------------------------------------------

type MailArt = CloudNachricht | "bezahlt";
/** Diese Mails gehen zusätzlich an Owner/Admins (Zahlung, Daten). */
const AUCH_ADMINS = new Set<MailArt>(["zahlung_offen", "loeschung_angekuendigt", "geloescht"]);
/** Mail-Link „Jetzt bestätigen“ gilt so lange. */
const BESTAETIGEN_GUELTIG_MS = 7 * 86_400_000;

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
  const auchAdmins = AUCH_ADMINS.has(art) || (art === "pausiert" && (extra.grund === "zahlung" || extra.grund === "kuendigung"));
  const gateway = env.GATEWAY_PUBLIC_URL.replace(/\/+$/, "");
  for (const e of await empfaenger(i.tenantId, i.actorId, auchAdmins)) {
    const istNutzer = e.actorId === i.actorId;
    const mailArt = `server_${art}`;
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
    else if (art === "laeuft_wieder") mail = serverLaeuftWiederMail(basis);
    else if (art === "laeuft") mail = serverLaeuftMail(basis);
    else if (art === "bestaetigen") {
      const t = bestaetigenToken(i.id, Date.now() + BESTAETIGEN_GUELTIG_MS);
      mail = serverBestaetigenMail({ ...basis, stufe: extra.stufe === "24h" ? "24h" : "bereit", bestaetigenUrl: t ? `${gateway}/cloud/bestaetigen?t=${t}` : `${env.AVA_APP_URL.replace(/\/+$/, "")}/mehr` });
    } else if (art === "nicht_erreichbar") mail = serverNichtErreichbarMail({ ...basis, seit: String(extra.seit ?? new Date().toISOString()) });
    else if (art === "wieder_erreichbar") mail = serverWiederErreichbarMail({ ...basis, dauerMin: Number(extra.dauerMin ?? 0) });
    else if (art === "loeschung_angekuendigt") {
      mail = serverLoeschungMail({ ...basis, grund: (extra.grund as "zahlung" | "kuendigung" | "abbestellt" | "admin") ?? "admin", loeschenAm: String(extra.loeschenAm ?? new Date().toISOString()), zahlungUrl, fuerAdmin: !istNutzer || e.role === "owner" || e.role === "admin" });
    } else if (art === "update_hinweis") {
      mail = serverUpdateHinweisMail({ ...basis, hinweis: String(extra.hinweis ?? ""), abmeldenUrl: "" });
    } else if (art === "aktualisiert") {
      mail = serverAktualisiertMail({ ...basis, hinweis: typeof extra.hinweis === "string" ? extra.hinweis : null, abmeldenUrl: "" });
    } else mail = serverGeloeschtMail(basis);
    const konto = await mailKonto(pool, { actorId: e.actorId, email: e.email!, vorname });
    // Update-Mails sind abbestellbar: Abmeldelink des Kontos einsetzen (Vorlage kennt das Konto nicht).
    if (art === "update_hinweis" || art === "aktualisiert") {
      const ab = linkAdressen(konto.token).abmelden;
      mail = art === "update_hinweis"
        ? serverUpdateHinweisMail({ ...basis, hinweis: String(extra.hinweis ?? ""), abmeldenUrl: ab })
        : serverAktualisiertMail({ ...basis, hinweis: typeof extra.hinweis === "string" ? extra.hinweis : null, abmeldenUrl: ab });
    }
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

// ---- Verbindung der Instanz (Z4) -----------------------------------------------------

/** Verbunden gemeldet: Zustand setzen und beim ersten Mal M2 „Deine AVA läuft“. */
export async function cloudVerbundenMelden(id: string, quelle: "system" | "abgleicher", details: Record<string, unknown> = {}): Promise<void> {
  const r = await cloudBetrieb().verbindungMelden(id, quelle, details);
  if (r !== "neu") return;
  const i = await pgRepo(getGatewayPool()).holen(id);
  if (i) await cloudMailen("laeuft", i).catch((err) => logger.warn({ id, err: err instanceof Error ? err.message : String(err) }, "[cloud] Mail M2 fehlgeschlagen"));
}

/**
 * Stand der Bestätigung für App und Mail-Link: angemeldet (dann gleich als verbunden
 * vermerkt) oder der aktuelle Ein-Klick-Link der Instanz (null, solange keiner bereitsteht).
 */
export async function cloudBestaetigung(i: CloudInstanz): Promise<{ angemeldet: boolean; bestaetigen: { link: string; bis: string | null } | null }> {
  if (i.zustand !== "wartet_auf_verbindung") return { angemeldet: !!i.verbundenAt, bestaetigen: null };
  const token = i.schritte.gatewayToken ? cloudBetrieb().gatewayToken(i.id) : null;
  if (!token) return { angemeldet: false, bestaetigen: null };
  const an = await flyKunden.anmeldung(i.flyApp, token);
  if (an?.angemeldet) {
    await cloudVerbundenMelden(i.id, "system", { ueber: "anmeldung" });
    return { angemeldet: true, bestaetigen: null };
  }
  return { angemeldet: false, bestaetigen: bestaetigungsLink(an) };
}

let eingehakt = false;
/** Meldet sich eine Server-AVA über das Relais, gilt ihre Cloud-Instanz als verbunden. */
function verbindungEinhaken(): void {
  if (eingehakt) return;
  eingehakt = true;
  kopfRelais.onInstanzVerbunden((actorId, _instanzId, info) => {
    if (info.art !== "server" || !info.flyApp?.startsWith("ava-u-")) return;
    void (async () => {
      // flyApp meldet der Kopf selbst (ungeprüft); zusammen mit dem geprüften Konto reicht das:
      // Wer sich so meldet, kann höchstens die eigene Instanz als verbunden markieren.
      const r = await getGatewayPool().query<{ id: string }>(
        `SELECT id FROM "CloudInstanz" WHERE "flyApp" = $1 AND lower("actorId") = lower($2) AND "geloeschtAt" IS NULL`,
        [info.flyApp, actorId],
      );
      if (r.rows[0]) await cloudVerbundenMelden(r.rows[0].id, "system", { ueber: "relais" });
    })().catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[cloud] Verbindung vermerken fehlgeschlagen"));
  });
}
