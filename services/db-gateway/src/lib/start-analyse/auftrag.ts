// Onboarding O1/O2 (docs/PLAN_ONBOARDING.md): Auftrag je Nutzer, Laeufer mit
// Wiederholungen und die EINMALIGE Abholung des ICP-Vorschlags durch die App.
//
// Wiederholungen (Joyce 2026-11-08): sofort, nach 10 s, nach 2 min, nach 10 min,
// danach "fehlgeschlagen". Die Wartezeit steht in der Datenbank
// (naechsterVersuchAt), damit Neustarts nichts verlieren; geholt wird per
// FOR UPDATE SKIP LOCKED, damit auch zwei Maschinen nichts doppelt tun.
//
// Einmaligkeit: abholen() setzt abgeholtAt nur, wenn es noch NULL ist, und gibt
// den Vorschlag nur dann zurueck. Jeder spaetere Aufruf (Neuanmeldung, zweites
// Geraet, Neuinstallation) bekommt "schon_abgeholt". Ein vorhandener ICP in der
// App wird so nie ueberschrieben (die App holt ausserdem nur bei leerem ICP ab).

import type { Pool } from "pg";
import { logger } from "../logger";
import { startAnalyse, type StartErgebnis } from "./analyse";
import { domainAusEmail, istFreemail } from "./freemail";
import { loadEnv } from "../env";
import { linkAdressen, mailKonto, mailSenden, versandBereit } from "../mail/versand";
import { willkommenMail } from "../mail/vorlagen";

/** Wartezeit vor Versuch 2, 3, 4 (Versuch 1 laeuft sofort). */
export const WARTEZEITEN_MS = [10_000, 2 * 60_000, 10 * 60_000];
const LEASE_MS = 15 * 60_000;
const ZWISCHENSPEICHER_TAGE = 90;
const TICK_MS = 5_000;

export type AuftragStatus = "offen" | "laeuft" | "fertig" | "freemail" | "keine_website" | "fehlgeschlagen";

export interface AuftragSicht {
  status: AuftragStatus;
  domain: string | null;
  website: string | null;
  abgeholt: boolean;
  abholArt: string | null;
  /** Nur Ueberblick fuer die App (Name, Website); der Vorschlag selbst kommt nur ueber abholen(). */
  firma: string | null;
}

function tagesDeckel(): number {
  const n = Number(process.env.START_ANALYSE_TAGESDECKEL ?? 300);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

/** Auftrag anlegen, falls es fuer diesen Nutzer noch keinen gibt (idempotent). Freemail ohne Website = sofort fertig, ohne Verarbeitung. */
export async function auftragAnlegen(pool: Pool, e: { actorId: string; email?: string | null; vorname?: string | null; website?: string | null }): Promise<void> {
  const domain = e.email ? domainAusEmail(e.email) : null;
  const website = e.website?.trim() || null;
  const status: AuftragStatus = !website && (!domain || istFreemail(domain)) ? "freemail" : "offen";
  const r = await pool.query(
    `INSERT INTO "StartAuftrag" ("actorId", "domain", "website", "status", "fertigAt", "email", "vorname")
     VALUES ($1, $2, $3, $4, CASE WHEN $4 = 'offen' THEN NULL ELSE NOW() END, $5, $6)
     ON CONFLICT ("actorId") DO NOTHING`,
    [e.actorId, domain, website, status, e.email?.trim().toLowerCase() || null, e.vorname?.trim().split(/\s+/)[0]?.slice(0, 60) || null],
  );
  if ((r.rowCount ?? 0) > 0) {
    logger.info({ actorId: e.actorId, domain, mitWebsite: !!website, status }, "[start-analyse] Auftrag angelegt");
    if (status === "offen") void tick(pool);
  }
}

/** Nachgereichte Website (Freemail-Nutzer, fehlgeschlagene Analyse). Nur solange nichts abgeholt ist. */
export async function websiteNachreichen(pool: Pool, actorId: string, website: string): Promise<boolean> {
  const r = await pool.query(
    `INSERT INTO "StartAuftrag" ("actorId", "website", "status") VALUES ($1, $2, 'offen')
     ON CONFLICT ("actorId") DO UPDATE SET "website" = EXCLUDED."website", "status" = 'offen', "versuch" = 0,
       "naechsterVersuchAt" = NOW(), "letzterFehler" = NULL, "updatedAt" = NOW()
     WHERE "StartAuftrag"."abgeholtAt" IS NULL AND "StartAuftrag"."status" IN ('freemail', 'keine_website', 'fehlgeschlagen')`,
    [actorId, website.trim()],
  );
  if ((r.rowCount ?? 0) > 0) void tick(pool);
  return (r.rowCount ?? 0) > 0;
}

export async function auftragLesen(pool: Pool, actorId: string): Promise<AuftragSicht | null> {
  const r = await pool.query<{ status: AuftragStatus; domain: string | null; website: string | null; abgeholtAt: Date | null; abholArt: string | null; firma: string | null }>(
    `SELECT "status", "domain", "website", "abgeholtAt", "abholArt", "vorschlag"->'eigeneFirma'->>'name' AS "firma" FROM "StartAuftrag" WHERE "actorId" = $1`,
    [actorId],
  );
  const z = r.rows[0];
  if (!z) return null;
  return { status: z.status, domain: z.domain, website: z.website, abgeholt: !!z.abgeholtAt, abholArt: z.abholArt, firma: z.firma };
}

export type AbholErgebnis = { art: "vorschlag"; vorschlag: StartErgebnis } | { art: "schon_abgeholt" } | { art: "nicht_fertig"; status: AuftragStatus | null } | { art: "verworfen" };

/**
 * EINMALIG: liefert den Vorschlag genau beim ersten Aufruf und sperrt ihn atomar.
 * `lokalLeer: false` (App hat schon einen ICP) verbraucht ihn ebenfalls, ohne ihn zu liefern.
 */
export async function abholen(pool: Pool, actorId: string, e: { instanz: string; lokalLeer: boolean }): Promise<AbholErgebnis> {
  const art = e.lokalLeer ? "uebernommen" : "verworfen";
  const r = await pool.query<{ vorschlag: StartErgebnis | null }>(
    `UPDATE "StartAuftrag" SET "abgeholtAt" = NOW(), "abgeholtVon" = $2, "abholArt" = $3,
       "vorschlag" = CASE WHEN $3 = 'uebernommen' THEN "vorschlag" ELSE NULL END, "updatedAt" = NOW()
     WHERE "actorId" = $1 AND "abgeholtAt" IS NULL AND ("status" = 'fertig' OR $3 = 'verworfen')
     RETURNING "vorschlag"`,
    [actorId, e.instanz.slice(0, 120), art],
  );
  if ((r.rowCount ?? 0) > 0) {
    logger.info({ actorId, art, instanz: e.instanz.slice(0, 40) }, "[start-analyse] Vorschlag abgeholt");
    if (art === "verworfen") return { art: "verworfen" };
    const v = r.rows[0]?.vorschlag;
    // Vorschlag am Auftrag nach der Uebergabe loeschen (der Domain-Zwischenspeicher bleibt).
    await pool.query(`UPDATE "StartAuftrag" SET "vorschlag" = NULL WHERE "actorId" = $1`, [actorId]);
    return v ? { art: "vorschlag", vorschlag: v } : { art: "schon_abgeholt" };
  }
  const s = await auftragLesen(pool, actorId);
  if (s?.abgeholt) return { art: "schon_abgeholt" };
  return { art: "nicht_fertig", status: s?.status ?? null };
}

// ---- Laeufer ---------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let laeuft = false;
let poolRef: Pool | null = null;

export function startLaeuferStarten(pool: Pool): void {
  if (timer || process.env.START_ANALYSE_DISABLED === "1") return;
  poolRef = pool;
  timer = setInterval(() => void tick(pool), TICK_MS);
  timer.unref();
  void tick(pool);
}

async function tick(pool: Pool = poolRef as Pool): Promise<void> {
  if (laeuft || !pool) return;
  laeuft = true;
  try {
    for (;;) {
      const auftrag = await naechsterAuftrag(pool);
      if (!auftrag) return;
      await bearbeiten(pool, auftrag);
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[start-analyse] Tick");
  } finally {
    laeuft = false;
  }
}

async function naechsterAuftrag(pool: Pool): Promise<{ actorId: string; domain: string | null; website: string | null; versuch: number } | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ actorId: string; domain: string | null; website: string | null; versuch: number }>(
      `SELECT "actorId", "domain", "website", "versuch" FROM "StartAuftrag"
       WHERE "status" IN ('offen', 'laeuft') AND "naechsterVersuchAt" <= NOW()
       ORDER BY "naechsterVersuchAt" LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const a = r.rows[0];
    if (!a) { await client.query("COMMIT"); return null; }
    // Lease: stirbt der Prozess mittendrin, greift der Auftrag nach LEASE_MS erneut.
    await client.query(
      `UPDATE "StartAuftrag" SET "status" = 'laeuft', "versuch" = "versuch" + 1, "naechsterVersuchAt" = NOW() + ($2 || ' milliseconds')::interval, "updatedAt" = NOW() WHERE "actorId" = $1`,
      [a.actorId, String(LEASE_MS)],
    );
    await client.query("COMMIT");
    return { ...a, versuch: a.versuch + 1 };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function ausZwischenspeicher(pool: Pool, domain: string): Promise<StartErgebnis | null> {
  const r = await pool.query<{ ergebnis: StartErgebnis }>(
    `SELECT "ergebnis" FROM "StartAnalyse" WHERE "domain" = $1 AND "createdAt" > NOW() - ($2 || ' days')::interval`,
    [domain, String(ZWISCHENSPEICHER_TAGE)],
  );
  return r.rows[0]?.ergebnis ?? null;
}

async function deckelErreicht(pool: Pool): Promise<boolean> {
  const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "StartAnalyse" WHERE "createdAt" > NOW() - interval '1 day'`);
  return Number(r.rows[0]?.n ?? 0) >= tagesDeckel();
}

async function bearbeiten(pool: Pool, a: { actorId: string; domain: string | null; website: string | null; versuch: number }): Promise<void> {
  const zielDomain = (a.website ? a.website.replace(/^https?:\/\//i, "").split("/")[0]!.replace(/^www\./, "").toLowerCase() : a.domain) ?? null;
  const fertig = async (status: AuftragStatus, vorschlag: StartErgebnis | null, fehler: string | null) => {
    await pool.query(
      `UPDATE "StartAuftrag" SET "status" = $2, "vorschlag" = $3, "letzterFehler" = $4, "fertigAt" = NOW(), "updatedAt" = NOW() WHERE "actorId" = $1`,
      [a.actorId, status, vorschlag ? JSON.stringify(vorschlag) : null, fehler],
    );
    logger.info({ actorId: a.actorId, domain: zielDomain, status, versuch: a.versuch, fehler }, "[start-analyse] Auftrag beendet");
  };
  try {
    if (!zielDomain) { await fertig("freemail", null, null); return; }
    const gespeichert = await ausZwischenspeicher(pool, zielDomain);
    if (gespeichert) {
      await fertig("fertig", gespeichert, null);
      void willkommenSenden(pool, a.actorId).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[start-analyse] Willkommensmail"));
      return;
    }
    if (await deckelErreicht(pool)) {
      // Kein Versuch verbraucht: in 30 Minuten erneut.
      await pool.query(`UPDATE "StartAuftrag" SET "status" = 'offen', "versuch" = "versuch" - 1, "naechsterVersuchAt" = NOW() + interval '30 minutes', "letzterFehler" = 'Tagesdeckel erreicht' WHERE "actorId" = $1`, [a.actorId]);
      logger.warn({ actorId: a.actorId }, "[start-analyse] Tagesdeckel erreicht, verschoben");
      return;
    }
    const aus = await startAnalyse({ domain: zielDomain, website: a.website }, `start:${a.actorId}`);
    if (aus.ok) {
      await pool.query(
        `INSERT INTO "StartAnalyse" ("domain", "ergebnis") VALUES ($1, $2) ON CONFLICT ("domain") DO UPDATE SET "ergebnis" = EXCLUDED."ergebnis", "createdAt" = NOW()`,
        [zielDomain, JSON.stringify(aus.ergebnis)],
      );
      await fertig("fertig", aus.ergebnis, null);
      void willkommenSenden(pool, a.actorId).catch((err) => logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[start-analyse] Willkommensmail"));
      return;
    }
    if (aus.endgueltig) { await fertig(aus.status === "freemail" ? "freemail" : "keine_website", null, aus.grund); return; }
    await wiederholen(pool, a, aus.grund);
  } catch (err) {
    await wiederholen(pool, a, err instanceof Error ? err.message.slice(0, 300) : String(err));
  }
}

async function wiederholen(pool: Pool, a: { actorId: string; versuch: number }, grund: string): Promise<void> {
  const warte = WARTEZEITEN_MS[a.versuch - 1];
  if (warte === undefined) {
    await pool.query(`UPDATE "StartAuftrag" SET "status" = 'fehlgeschlagen', "letzterFehler" = $2, "fertigAt" = NOW(), "updatedAt" = NOW() WHERE "actorId" = $1`, [a.actorId, grund.slice(0, 500)]);
    logger.warn({ actorId: a.actorId, versuch: a.versuch, grund }, "[start-analyse] endgueltig fehlgeschlagen");
    return;
  }
  await pool.query(
    `UPDATE "StartAuftrag" SET "status" = 'offen', "letzterFehler" = $2, "naechsterVersuchAt" = NOW() + ($3 || ' milliseconds')::interval, "updatedAt" = NOW() WHERE "actorId" = $1`,
    [a.actorId, grund.slice(0, 500), String(warte)],
  );
  logger.info({ actorId: a.actorId, versuch: a.versuch, inSek: warte / 1000, grund }, "[start-analyse] Wiederholung geplant");
}

// ---- Willkommensmail (O5) ---------------------------------------------------

function domainVon(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** Willkommensmail genau einmal je Auftrag (willkommenGesendetAt wird atomar gesetzt). */
export async function willkommenSenden(pool: Pool, actorId: string): Promise<void> {
  if (!versandBereit()) return;
  const r = await pool.query<{ email: string | null; vorname: string | null; vorschlag: StartErgebnis | null }>(
    `UPDATE "StartAuftrag" SET "willkommenGesendetAt" = NOW()
     WHERE "actorId" = $1 AND "willkommenGesendetAt" IS NULL AND "status" = 'fertig' AND "email" IS NOT NULL AND "vorschlag" IS NOT NULL
     RETURNING "email", "vorname", "vorschlag"`,
    [actorId],
  );
  const z = r.rows[0];
  if (!z?.email || !z.vorschlag) return;
  const v = z.vorschlag;
  const konto = await mailKonto(pool, { actorId, email: z.email, vorname: z.vorname });
  const links = linkAdressen(konto.token);
  const mail = willkommenMail({
    vorname: konto.vorname,
    domain: domainVon(v.website),
    firma: v.eigeneFirma.name || null,
    angebot: v.icp.angebot,
    beschreibung: v.icp.beschreibung,
    branchen: v.icp.branchen,
    region: v.icp.orte.length ? `${v.icp.orte.join(", ")}, ${v.icp.radiusKm} km Umkreis` : null,
    referenzen: v.referenzen.filter((x) => x.profil).map((x) => ({ name: x.name, ...(x.profil?.branche ? { branche: x.profil.branche } : {}) })),
    downloadUrl: loadEnv().AVA_DOWNLOAD_URL,
    bestaetigenUrl: links.bestaetigen,
    abmeldenUrl: links.abmelden,
  });
  const erg = await mailSenden(pool, konto, "willkommen", mail);
  // Fehlgeschlagen (z. B. Mailgun kurz weg): Sperre loesen, der naechste Abruf versucht es erneut.
  if (!erg.ok && erg.grund !== "abgemeldet") await pool.query(`UPDATE "StartAuftrag" SET "willkommenGesendetAt" = NULL WHERE "actorId" = $1`, [actorId]);
}
