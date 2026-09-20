// Relevanz-Tilgung (docs/PLAN_RELEVANZ.md, Abschnitt 4.5).
//
// Einmal taeglich:
//   1. Rohsignale aelter als 400 Tage loeschen. Ein Jahr plus Puffer, damit
//      Jahresvergleiche moeglich bleiben, aber nichts unbegrenzt liegt.
//   2. Abgelaufene Sperren wegraeumen.
//   3. Werte nachrechnen, deren juengstes Signal lange her ist. Der Verfall
//      allein aendert die Naehe auch ohne neue Signale — ohne diesen Lauf
//      bliebe eine vor Monaten heisse Firma in der Vorschau oben stehen.
//
// RELEVANZ_CRON_DISABLED=1 schaltet ab (Tests, Wartung).

import { logger } from "./logger";
import { getGatewayPool } from "./producer-pools";
import {
  naehe as berechneNaehe,
  begruendung as berechneBegruendung,
  rang as berechneRang,
  type Signal,
} from "./relevanz-score";

const INTERVAL_MS = 60 * 60_000;
/** Aufbewahrung der Rohsignale. */
export const TILGUNG_TAGE = 400;
/** So viele Werte je Lauf nachrechnen — begrenzt die Last je Durchgang. */
const NACHRECHNEN_PRO_LAUF = 500;

let letzterLaufTag: string | null = null;
let timer: NodeJS.Timeout | null = null;

export async function runRelevanzCronOnce(now: Date = new Date()): Promise<void> {
  const pool = getGatewayPool();

  try {
    const r = await pool.query(
      `DELETE FROM "RelevanzSignal" WHERE "zeitpunkt" < $1::timestamptz - ($2 || ' days')::interval`,
      [now, String(TILGUNG_TAGE)],
    );
    if ((r.rowCount ?? 0) > 0) {
      logger.info({ geloescht: r.rowCount }, "[relevanz-cron] alte Signale getilgt");
    }
  } catch (err) {
    logger.warn({ err: fehlertext(err) }, "[relevanz-cron] Tilgung fehlgeschlagen");
  }

  try {
    await pool.query(`DELETE FROM "RelevanzSperre" WHERE "bis" < $1`, [now]);
  } catch (err) {
    logger.warn({ err: fehlertext(err) }, "[relevanz-cron] Sperren aufraeumen fehlgeschlagen");
  }

  try {
    await rechneVeralteteNach(now);
  } catch (err) {
    logger.warn({ err: fehlertext(err) }, "[relevanz-cron] Nachrechnen fehlgeschlagen");
  }
}

/**
 * Werte, die seit ueber einem Tag nicht angefasst wurden, neu bilden.
 *
 * Die aeltesten zuerst: So kommt jeder Wert an die Reihe, auch wenn mehr
 * anliegt, als ein Lauf schafft.
 */
async function rechneVeralteteNach(now: Date): Promise<void> {
  const pool = getGatewayPool();
  const kandidaten = await pool.query<{
    tenantId: string; actorId: string; zielArt: string; zielId: string; gewicht: number;
  }>(
    `SELECT "tenantId","actorId","zielArt","zielId","gewicht"
       FROM "RelevanzWert"
      WHERE "berechnet" < $1::timestamptz - interval '1 day'
      ORDER BY "berechnet" ASC
      LIMIT $2`,
    [now, NACHRECHNEN_PRO_LAUF],
  );

  for (const k of kandidaten.rows) {
    const s = await pool.query(
      `SELECT "art","punkte","halbwertT","zeitpunkt" FROM "RelevanzSignal"
        WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = $3 AND "zielId" = $4
        ORDER BY "zeitpunkt" DESC LIMIT 500`,
      [k.tenantId, k.actorId, k.zielArt, k.zielId],
    );
    const signale: Signal[] = s.rows.map((row: Record<string, unknown>) => ({
      art: String(row.art),
      punkte: Number(row.punkte),
      halbwertT: Number(row.halbwertT),
      zeitpunkt: new Date(row.zeitpunkt as string),
    }));

    // Ohne Signale gibt es nichts mehr zu bewerten — der Wert verschwindet
    // mit ihnen, statt als Karteileiche mit Naehe 1 stehen zu bleiben.
    if (signale.length === 0) {
      await pool.query(
        `DELETE FROM "RelevanzWert"
          WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = $3 AND "zielId" = $4`,
        [k.tenantId, k.actorId, k.zielArt, k.zielId],
      );
      continue;
    }

    const naehe = berechneNaehe(signale, now);
    const gewicht = Number(k.gewicht) || 1;
    await pool.query(
      `UPDATE "RelevanzWert"
          SET "naehe" = $5, "rang" = $6, "begruendung" = $7::jsonb, "berechnet" = NOW()
        WHERE "tenantId" = $1 AND "actorId" = $2 AND "zielArt" = $3 AND "zielId" = $4`,
      [
        k.tenantId, k.actorId, k.zielArt, k.zielId,
        naehe, berechneRang(naehe, gewicht, null),
        JSON.stringify(berechneBegruendung(signale, now)),
      ],
    );
  }

  if (kandidaten.rowCount && kandidaten.rowCount > 0) {
    logger.info({ nachgerechnet: kandidaten.rowCount }, "[relevanz-cron] Werte nachgerechnet");
  }
}

function fehlertext(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function startRelevanzCron(): void {
  if (process.env.RELEVANZ_CRON_DISABLED === "1") {
    logger.info("[relevanz-cron] abgeschaltet (RELEVANZ_CRON_DISABLED=1)");
    return;
  }
  if (timer) return;
  const tick = () => {
    const now = new Date();
    const tag = now.toISOString().slice(0, 10);
    // Einmal am Tag reicht: Der Verfall bewegt sich in Tagen, nicht in
    // Stunden. Stuendlich zu tilgen waere nur Last ohne Wirkung.
    if (letzterLaufTag === tag) return;
    letzterLaufTag = tag;
    void runRelevanzCronOnce(now);
  };
  timer = setInterval(tick, INTERVAL_MS);
  timer.unref?.();
  setTimeout(tick, 30_000).unref?.();
}
