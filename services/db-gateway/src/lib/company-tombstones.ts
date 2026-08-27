// v0.1.431 — P3: "Echtes Loeschen" als NUTZER-SICHT-Loeschung.
//
// Firmen sind in AVA GETEILTE Stammdaten (master-data, ein Datensatz fuer
// alle Nutzer/Tenants). Ein Nutzer, der eine Firma "loescht", darf deshalb
// nicht den geteilten Datensatz zerstoeren — er entfernt sie aus SEINER
// Sicht: Tombstone je (userId, companyId), Purge der EntityProgress-Zeilen
// seiner eigenen Transaktionen, und Transaktionen, die dadurch leer werden,
// verschwinden aus seiner Vorgaenge-Liste (HiddenTransaction).
//
// Geteilte, abgeleitete Daten (PublicationBlocks, ContentFreshness) bleiben
// bewusst unangetastet — andere Nutzer profitieren weiter davon.

import type { Pool } from "pg";

let schemaReady = false;

async function ensureSchema(pool: Pool): Promise<void> {
  if (schemaReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CompanyTombstone" (
      "userId"    TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "deletedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("userId", "companyId")
    );
  `);
  // Hold-Tabelle mit anlegen — der Loesch-Pfad raeumt sie mit auf und darf
  // nicht an 42P01 scheitern, wenn nie ein Hold gesetzt wurde.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "CompanyProcessingHold" (
      "companyId" TEXT PRIMARY KEY,
      reason      TEXT,
      "heldAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "HiddenTransaction" (
      "userId"        TEXT NOT NULL,
      "transactionId" TEXT NOT NULL,
      "hiddenAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY ("userId", "transactionId")
    );
  `);
  schemaReady = true;
}

/**
 * Firma aus der Sicht des Nutzers loeschen. Entfernt die EntityProgress-
 * Zeilen der Firma fuer die uebergebenen (eigenen!) Transaktionen und
 * versteckt Transaktionen, die dadurch komplett leer werden. Liefert die
 * Anzahl entfernter Zeilen + versteckter Transaktionen.
 */
export async function tombstoneCompany(
  pool: Pool,
  userId: string,
  companyId: string,
  myTransactionIds: string[],
): Promise<{ removedRows: number; hiddenTransactions: number }> {
  await ensureSchema(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "CompanyTombstone" ("userId", "companyId")
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, companyId],
    );

    let removedRows = 0;
    let hiddenTransactions = 0;
    if (myTransactionIds.length > 0) {
      // Betroffene Transaktionen der Firma merken, BEVOR geloescht wird.
      const affected = await client.query<{ transactionId: string }>(
        `SELECT DISTINCT "transactionId" FROM "EntityProgress"
         WHERE "companyId" = $1 AND "transactionId" = ANY($2::text[])`,
        [companyId, myTransactionIds],
      );
      const del = await client.query(
        `DELETE FROM "EntityProgress"
         WHERE "companyId" = $1 AND "transactionId" = ANY($2::text[])`,
        [companyId, myTransactionIds],
      );
      removedRows = del.rowCount ?? 0;

      // Transaktionen, die jetzt keine Zeilen mehr haben → verstecken.
      for (const t of affected.rows) {
        const rest = await client.query(
          `SELECT 1 FROM "EntityProgress" WHERE "transactionId" = $1 LIMIT 1`,
          [t.transactionId],
        );
        if ((rest.rowCount ?? 0) === 0) {
          await client.query(
            `INSERT INTO "HiddenTransaction" ("userId", "transactionId")
             VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [userId, t.transactionId],
          );
          hiddenTransactions += 1;
        }
      }
    }
    // Ein evtl. Hold ist mit dem Loeschen obsolet.
    await client.query(
      `DELETE FROM "CompanyProcessingHold" WHERE "companyId" = $1`,
      [companyId],
    );
    await client.query("COMMIT");
    return { removedRows, hiddenTransactions };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Teilmenge der IDs, die der Nutzer geloescht hat. */
export async function tombstonedSubset(
  pool: Pool,
  userId: string,
  companyIds: string[],
): Promise<Set<string>> {
  if (companyIds.length === 0) return new Set();
  await ensureSchema(pool);
  const r = await pool.query<{ companyId: string }>(
    `SELECT "companyId" FROM "CompanyTombstone"
     WHERE "userId" = $1 AND "companyId" = ANY($2::text[])`,
    [userId, companyIds],
  );
  return new Set(r.rows.map((x) => x.companyId));
}

/** Vom Nutzer versteckte (leergewordene) Transaktionen. */
export async function hiddenTransactionSubset(
  pool: Pool,
  userId: string,
  transactionIds: string[],
): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set();
  await ensureSchema(pool);
  const r = await pool.query<{ transactionId: string }>(
    `SELECT "transactionId" FROM "HiddenTransaction"
     WHERE "userId" = $1 AND "transactionId" = ANY($2::text[])`,
    [userId, transactionIds],
  );
  return new Set(r.rows.map((x) => x.transactionId));
}
