// v0.1.430 — P2: Verarbeitung pro Firma aussetzen ("Hold").
//
// Der Nutzerwunsch hinter dem bisherigen "Loeschen" war meist gar kein
// Loeschen, sondern: DIESE Firma soll (vorerst) nicht weiterverarbeitet
// werden. Ein Hold ist zentral gespeichert und wirkt am Gateway-Chokepoint,
// durch den ALLE Wiederanlaeufe laufen (Retry-Route + Retry-Queue) —
// Agent-Tool retry_stage, Freshness-Scheduler, Resume-Sweep des Desktops
// und der Auto-Retry-Heartbeat sind damit alle abgedeckt.
//
// Bewusste Grenze: bereits in AMQP eingereihte Erst-Verarbeitungen laufen
// noch EINMAL durch (nichts kann sie aus der Queue ziehen); danach haelt
// der Hold jede Wiederbelebung auf. Ein expliziter Neu-Import durch den
// Nutzer gilt als bewusste Entscheidung und wird nicht blockiert.

import type { Pool } from "pg";

let schemaReady = false;

async function ensureSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CompanyProcessingHold" (
      "companyId" TEXT PRIMARY KEY,
      reason      TEXT,
      "heldAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  schemaReady = true;
}

export async function setHold(
  pool: Pool,
  companyId: string,
  reason: string | null,
): Promise<void> {
  await ensureSchema(pool);
  await pool.query(
    `INSERT INTO "CompanyProcessingHold" ("companyId", reason)
     VALUES ($1, $2)
     ON CONFLICT ("companyId") DO UPDATE SET reason = EXCLUDED.reason`,
    [companyId, reason],
  );
}

export async function clearHold(pool: Pool, companyId: string): Promise<void> {
  await ensureSchema(pool);
  await pool.query(
    `DELETE FROM "CompanyProcessingHold" WHERE "companyId" = $1`,
    [companyId],
  );
}

export async function isHeld(pool: Pool, companyId: string): Promise<boolean> {
  await ensureSchema(pool);
  const r = await pool.query(
    `SELECT 1 FROM "CompanyProcessingHold" WHERE "companyId" = $1`,
    [companyId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Teilmenge der uebergebenen IDs, die gehalten sind. */
export async function heldSubset(
  pool: Pool,
  companyIds: string[],
): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  await ensureSchema(pool);
  const r = await pool.query<{ companyId: string }>(
    `SELECT "companyId" FROM "CompanyProcessingHold"
     WHERE "companyId" = ANY($1::text[])`,
    [companyIds],
  );
  return new Set(r.rows.map((x) => x.companyId));
}
