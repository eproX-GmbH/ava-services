// Z3 (docs/PLAN_ABRECHNUNG_ZUGANG.md): Stufe einer aufgenommenen Firma aus Fakten
// nach dem Kontakt-Lauf. Die Stufe ist eine Eigenschaft des Pool-Datensatzes,
// nicht des Kunden: Wer die Firma spaeter ueber den Frisch-Pfad aufnimmt,
// bekommt dieselbe Stufe. Deshalb wird jede offene UsageEntry-Zeile der Firma
// zugeordnet, unabhaengig vom Abrechnungskonto.
//
//   klein  — kein LinkedIn-Firmenprofil (keine Apify-Beobachtungen)
//   mittel — Apify-Profil, Mitarbeiter-Fenster (100) nicht voll
//   gross  — Apify-Profil und mindestens 100 Personen (Fenster voll, Zweitlauf)
//
// Preise und Direktkosten (Cent, netto) aus docs/KALKULATION_VERARBEITUNGSKOSTEN.md
// mit Betreiber-Modell gpt-6-luna; aenderbar per Env ohne Deploy.

import type pg from "pg";
import { getProducerPool } from "./producer-pools";
import { logger } from "./logger";

export type Stufe = "klein" | "mittel" | "gross";

function cents(env: string | undefined, fallback: number): number {
  const n = env ? Number(env) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

export function stufenPreise(): Record<Stufe, { preisCents: number; direktkostenCents: number }> {
  return {
    klein: { preisCents: cents(process.env.STUFE_PREIS_KLEIN_CENTS, 100), direktkostenCents: cents(process.env.STUFE_KOSTEN_KLEIN_CENTS, 11) },
    mittel: { preisCents: cents(process.env.STUFE_PREIS_MITTEL_CENTS, 200), direktkostenCents: cents(process.env.STUFE_KOSTEN_MITTEL_CENTS, 59) },
    gross: { preisCents: cents(process.env.STUFE_PREIS_GROSS_CENTS, 350), direktkostenCents: cents(process.env.STUFE_KOSTEN_GROSS_CENTS, 77) },
  };
}

export const FENSTER_VOLL = 100;
/** Schwelle fuer Stufe gross (Joyce, 2026-10-13): ab 50 Personen ueber Apify oder
 *  50 aktuellen Personen — nicht erst bei vollem Suchfenster (100), sonst gaebe es
 *  praktisch nie eine grosse Firma. Env STUFE_GROSS_AB. */
export function grossAb(): number {
  const n = Number(process.env.STUFE_GROSS_AB);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 50;
}

/** Stufe aus den Kontaktdaten der Firma (Apify-Beobachtungen, aktuelle Personen). */
export async function stufeErmitteln(companyId: string): Promise<{ stufe: Stufe; grund: string; apify: number; personen: number }> {
  const pool = getProducerPool("company-contact");
  const r = await pool.query<{ apify: string; personen: string }>(
    `SELECT
       (SELECT count(DISTINCT o."personId") FROM "Observation" o WHERE o."companyId" = $1 AND o.source LIKE 'apify%')::text AS apify,
       (SELECT count(*) FROM "Employment" e WHERE e."companyId" = $1 AND e."isCurrent")::text AS personen`,
    [companyId],
  );
  const apify = Number(r.rows[0]?.apify ?? 0);
  const personen = Number(r.rows[0]?.personen ?? 0);
  if (apify === 0) return { stufe: "klein", grund: `kein LinkedIn-Firmenprofil, ${personen} Personen`, apify, personen };
  const schwelle = grossAb();
  if (apify >= schwelle || personen >= schwelle) return { stufe: "gross", grund: `LinkedIn-Profil, ${apify} Personen ueber Apify, ${personen} aktuell (ab ${schwelle} = gross)`, apify, personen };
  return { stufe: "mittel", grund: `LinkedIn-Profil, ${apify} Personen ueber Apify, ${personen} aktuell`, apify, personen };
}

/**
 * Ordnet jeder offenen UsageEntry-Zeile der Firma die Stufe zu (oder aktualisiert
 * sie, wenn sich die Stufe nach einem Lauf geaendert hat). Best-effort: ein
 * Fehler hier darf die Datenverarbeitung nie beeinflussen.
 */
export async function stufeZuordnen(pool: pg.Pool, companyId: string, anlass: string): Promise<{ stufe: Stufe; zeilen: number } | null> {
  try {
    const e = await stufeErmitteln(companyId);
    const p = stufenPreise()[e.stufe];
    const r = await pool.query(
      `UPDATE "UsageEntry"
          SET "stufe" = $2, "preisCents" = $3, "direktkostenCents" = $4, "grund" = $5, "zugeordnetAm" = NOW()
        WHERE "companyId" = $1 AND ("stufe" IS DISTINCT FROM $2 OR "zugeordnetAm" IS NULL)`,
      [companyId, e.stufe, p.preisCents, p.direktkostenCents, `${anlass}: ${e.grund}`.slice(0, 200)],
    );
    logger.info({ companyId, stufe: e.stufe, zeilen: r.rowCount ?? 0, anlass, apify: e.apify, personen: e.personen }, "[stufen] zugeordnet");
    return { stufe: e.stufe, zeilen: r.rowCount ?? 0 };
  } catch (err) {
    logger.warn({ companyId, err: err instanceof Error ? err.message : String(err) }, "[stufen] Zuordnung fehlgeschlagen");
    return null;
  }
}
