// v0.1.434 — Firmennamen-Cache im Gateway.
//
// Die Stammdaten (Namen) leben in master-data; der Verarbeitungs-Feed soll
// Namen aber SERVERSEITIG liefern, ohne je Feed-Aufruf Upstream zu fragen.
// Loesung: Die Firmen-Matrix (die ohnehin bei jeder Nutzung Upstream-Seiten
// zieht) pflegt als Nebeneffekt einen kleinen Namens-Cache; der Feed joint
// lokal dagegen. Kaltstart-Luecke (Name noch nie gesehen) faengt der
// Desktop mit seinem bisherigen Fallback ab.

import type { Pool } from "pg";

let schemaReady = false;

async function ensureSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CompanyNameCache" (
      "companyId" TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  schemaReady = true;
}

/** Namen einpflegen (Batch-Upsert). Best-effort — wirft nie. */
export async function cacheCompanyNames(
  pool: Pool,
  entries: Array<{ companyId: string; name: string }>,
): Promise<void> {
  const rows = entries.filter(
    (e) => e.companyId && e.name && e.name.trim().length > 0,
  );
  if (rows.length === 0) return;
  try {
    await ensureSchema(pool);
    const values: unknown[] = [];
    const tuples: string[] = [];
    rows.forEach((e, i) => {
      values.push(e.companyId, e.name.trim().slice(0, 300));
      tuples.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
    });
    await pool.query(
      `INSERT INTO "CompanyNameCache" ("companyId", name)
       VALUES ${tuples.join(", ")}
       ON CONFLICT ("companyId") DO UPDATE SET
         name = EXCLUDED.name, "updatedAt" = NOW()`,
      values,
    );
  } catch (err) {
    console.warn("[company-names] cache upsert failed:", err);
  }
}

/** Namen fuer eine ID-Menge aufloesen. Fehlende IDs fehlen im Ergebnis. */
export async function resolveCompanyNames(
  pool: Pool,
  companyIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    await ensureSchema(pool);
    const r = await pool.query<{ companyId: string; name: string }>(
      `SELECT "companyId", name FROM "CompanyNameCache"
       WHERE "companyId" = ANY($1::text[])`,
      [ids],
    );
    for (const row of r.rows) out.set(row.companyId, row.name);
  } catch (err) {
    console.warn("[company-names] resolve failed:", err);
  }
  return out;
}
