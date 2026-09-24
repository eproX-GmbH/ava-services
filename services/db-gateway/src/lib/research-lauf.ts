// Protokoll der manuellen Recherche-Laeufe je Firma (2026-09-24).
//
// Start: routes/v1/companies-research.ts legt eine Zeile "laufend" an.
// Ende: persist-bus (company-evaluation-Ereignis mit #research:-Suffix im
// source) traegt die Anzahl der Ergebnisse ein; event-bus meldet ein
// "failed" des Website-Producers als Fehler. Was nach 45 Minuten noch
// "laufend" ist, zeigt die Abfrage als "unbekannt" — der Producer hat sich
// nicht mehr gemeldet (App beendet, Netz weg).

import { getGatewayPool } from "./producer-pools";
import { logger } from "./logger";

export const LAUF_STALE_MS = 45 * 60 * 1000;
export type ResearchFeature = "jobs" | "expansion";

const RE = /#research:([a-z]+=[a-z]+(?:,[a-z]+=[a-z]+)*)\b/;

/** Welche Recherchen ein Ereignis-`source` anstoesst; null ohne Suffix. */
export function researchFeaturesAusSource(source: string | null | undefined): ResearchFeature[] | null {
  const m = RE.exec(source ?? "");
  if (!m) return null;
  const aus = m[1]!.split(",").map((p) => p.split("=")[0]).filter((k): k is ResearchFeature => k === "jobs" || k === "expansion");
  return aus.length ? aus : null;
}

/** Persist-Ereignis angekommen: je Funktion die juengste laufende Zeile abschliessen. */
export async function laufAbschliessen(companyId: string, source: string | null | undefined, anzahl: { jobs?: number; expansion?: number }): Promise<void> {
  const features = researchFeaturesAusSource(source);
  if (!features) return;
  const pool = getGatewayPool();
  for (const f of features) {
    const n = anzahl[f];
    try {
      await pool.query(
        `UPDATE "CompanyResearchLauf" SET state = 'fertig', ergebnisse = $3, "beendetAt" = NOW()
          WHERE id = (SELECT id FROM "CompanyResearchLauf" WHERE "companyId" = $1 AND feature = $2 AND state = 'laufend' ORDER BY "gestartetAt" DESC LIMIT 1)`,
        [companyId, f, typeof n === "number" ? n : null],
      );
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), companyId, feature: f }, "research-lauf: abschliessen fehlgeschlagen");
    }
  }
}

/** Website-Producer meldet "failed": alle laufenden Zeilen der Firma als Fehler markieren. */
export async function laufFehler(companyId: string, transactionId: string | null, meldung: string | null): Promise<void> {
  try {
    await getGatewayPool().query(
      `UPDATE "CompanyResearchLauf" SET state = 'fehler', fehler = $2, "beendetAt" = NOW()
        WHERE "companyId" = $1 AND state = 'laufend' AND ($3::text IS NULL OR "transactionId" = $3)`,
      [companyId, (meldung ?? "unbekannter Fehler").slice(0, 500), transactionId],
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), companyId }, "research-lauf: fehler markieren fehlgeschlagen");
  }
}
