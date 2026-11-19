// Firmenhistorie H4 (docs/PLAN_FIRMEN_HISTORIE.md): Kennzahl Fluktuation je Firma.
//
//   * Wechsel je Rollengruppe in der Leitung, 24 Monate: Zugaenge (neu, Aufstieg hinein) und
//     Abgaenge (verlassen, Wechsel heraus); ein Wechsel = max(Zugaenge, Abgaenge), denn eine
//     neu besetzte Vertriebsleitung ist ein Abgang plus ein Zugang. Geschaeftsfuehrung zusaetzlich
//     laut Register (Bestellungen/Abberufungen), es zaehlt die groessere der beiden Quellen.
//   * Mittlere Verweildauer der Leitung: Median ueber Leitungs-Beschaeftigungen mit Startdatum
//     laut Profil (aktuelle bis heute, beendete bis zuletzt gesehen).
//   * Entscheidung E5: Personen werden geloescht (Widerspruch, 180-Tage-Aufbewahrung), ihre
//     Ereignisse verschwinden mit. Vorher werden sie ANONYM festgehalten (Firma, Art, Rollengruppe,
//     Ebene, Zeitpunkt, ohne Person), damit die Kennzahl nicht mit der Zeit absinkt.
//     Tabelle "PersonalEreignisAnonym" in der Kontakt-DB, angelegt wie PersonTombstone.

import type pg from "pg";
import { firmenEreignisse } from "./firmen-ereignisse";
import { getProducerPool } from "./producer-pools";
import { rolleEinordnen, ROLLENGRUPPEN, type Ebene, type Rollengruppe } from "./rollengruppe";
import { hinweiseAus, leitungZaehlen, type FluktuationGruppe, type Zaehlbar } from "./fluktuation-zaehlen";

export type { FluktuationGruppe };
import { logger } from "./logger";

const TAG = 86_400_000;
const FENSTER_TAGE = 730;

let schemaBereit = false;
async function anonymSchema(pool: pg.Pool): Promise<void> {
  if (schemaBereit) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "PersonalEreignisAnonym" (
      "ereignisId"   TEXT PRIMARY KEY,
      "companyId"    TEXT NOT NULL,
      "art"          TEXT NOT NULL,
      "gruppe"       TEXT NOT NULL,
      "ebene"        TEXT NOT NULL,
      "gruppeVorher" TEXT,
      "ebeneVorher"  TEXT,
      "zeitpunkt"    TIMESTAMPTZ NOT NULL,
      "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Neue, leere Tabelle: der Index entsteht sofort (keine Last auf der geteilten Datenbank).
  await pool.query(`CREATE INDEX IF NOT EXISTS "PersonalEreignisAnonym_companyId_idx" ON "PersonalEreignisAnonym"("companyId")`);
  schemaBereit = true;
}

/**
 * Vor dem Loeschen von Personen: ihre Personalereignisse anonym festhalten. Best-effort — eine
 * Loeschung (Betroffenenrecht, Aufbewahrung) scheitert nie daran.
 */
export async function anonymMerken(pool: pg.Pool, personIds: string[]): Promise<number> {
  const ids = [...new Set(personIds.filter(Boolean))];
  if (ids.length === 0) return 0;
  try {
    await anonymSchema(pool);
    const f = await pool.query<{ companyId: string }>(`SELECT DISTINCT "companyId" FROM "Employment" WHERE "personId" = ANY($1::text[])`, [ids]);
    const firmen = f.rows.map((r) => r.companyId);
    if (firmen.length === 0) return 0;
    const ereignisse = await firmenEreignisse({ companyIds: firmen, personIds: ids, arten: ["neu", "verlassen", "wechsel"], ohneLimit: true });
    let n = 0;
    for (const e of ereignisse) {
      const r = await pool.query(
        `INSERT INTO "PersonalEreignisAnonym" ("ereignisId","companyId","art","gruppe","ebene","gruppeVorher","ebeneVorher","zeitpunkt")
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("ereignisId") DO NOTHING`,
        [e.id, e.companyId, e.art, e.gruppe, e.ebene, e.gruppeVorher, e.ebeneVorher, e.zeitpunkt],
      );
      n += r.rowCount ?? 0;
    }
    return n;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), personen: ids.length }, "[fluktuation] anonymes Mitzaehlen vor dem Loeschen fehlgeschlagen");
    return 0;
  }
}

export interface Fluktuation {
  companyId: string;
  fensterMonate: number;
  /** Erste Erfassung von Personen dieser Firma; davor kennt AVA nur Profildaten. */
  beobachtetSeit: string | null;
  gruppen: FluktuationGruppe[];
  leitungVerweildauer: { medianMonate: number; anzahl: number } | null;
  /** Kurze Saetze fuer Kopf, Uebersicht und Chat, z. B. „Vertriebsleitung: 2 neu, 1 ausgeschieden in 2 Jahren“. */
  hinweise: string[];
}

export async function fluktuation(companyId: string): Promise<Fluktuation> {
  const pool = getProducerPool("company-contact");
  const seit = new Date(Date.now() - FENSTER_TAGE * TAG);
  const [ereignisse, anonym, basis, dauer] = await Promise.all([
    firmenEreignisse({ companyIds: [companyId], seit, ohneLimit: true }),
    pool
      .query<Zaehlbar>(`SELECT art, gruppe, ebene, "gruppeVorher", "ebeneVorher" FROM "PersonalEreignisAnonym" WHERE "companyId" = $1 AND zeitpunkt >= $2`, [companyId, seit])
      .then((r) => r.rows)
      .catch(() => [] as Zaehlbar[]),
    pool.query<{ ab: Date | null }>(`SELECT min("firstSeen") AS ab FROM "Employment" WHERE "companyId" = $1`, [companyId]),
    pool.query<{ title: string | null; startDate: Date; ende: Date }>(
      `SELECT title, "startDate", CASE WHEN "isCurrent" THEN NOW() ELSE "lastSeen" END AS ende
         FROM "Employment" WHERE "companyId" = $1 AND "startDate" IS NOT NULL`,
      [companyId],
    ),
  ]);
  const personal = ereignisse.filter((e) => e.art !== "geschaeftsfuehrung");
  let regZu = 0;
  let regAb = 0;
  for (const e of ereignisse) if (e.art === "geschaeftsfuehrung") {
    regZu += e.neuBestellt?.length ?? 0;
    regAb += e.ausgeschieden?.length ?? 0;
  }
  const gruppen = leitungZaehlen([...personal, ...anonym.map((a) => ({ ...a, gruppe: a.gruppe as Rollengruppe, ebene: a.ebene as Ebene, gruppeVorher: (a.gruppeVorher as Rollengruppe | null) ?? null, ebeneVorher: (a.ebeneVorher as Ebene | null) ?? null }))], { zu: regZu, ab: regAb });
  const monate = dauer.rows
    .filter((r) => {
      const ro = rolleEinordnen(r.title);
      return ro.ebene === "leitung" && ro.gruppe !== "sonstige";
    })
    .map((r) => (new Date(r.ende).getTime() - new Date(r.startDate).getTime()) / (30.44 * TAG))
    .filter((m) => m >= 0 && m < 600)
    .sort((a, b) => a - b);
  const median = monate.length === 0 ? null : monate.length % 2 ? monate[(monate.length - 1) / 2]! : (monate[monate.length / 2 - 1]! + monate[monate.length / 2]!) / 2;
  const fensterMonate = FENSTER_TAGE / 365 * 12;
  return {
    companyId,
    fensterMonate,
    beobachtetSeit: basis.rows[0]?.ab ? new Date(basis.rows[0].ab).toISOString() : null,
    gruppen,
    leitungVerweildauer: median === null ? null : { medianMonate: Math.round(median), anzahl: monate.length },
    hinweise: hinweiseAus(gruppen, fensterMonate),
  };
}

export { ROLLENGRUPPEN };
