// Vorgangsnamen, die der Nutzer beim Import vergibt (Chat, Konsole, MCP).
//
// Warum im Gateway: master-data nimmt den Namen an, reicht ihn aber nicht bis
// zum Vorgangsdatensatz durch, den die Lese-Routen liefern. Das Gateway legt
// ihn deshalb selbst ab; liefert master-data spaeter einen eigenen Namen,
// gewinnt der (Aufrufer mischen „Upstream zuerst“).
//
// 2026-11-06: Ablage in der Gateway-Datenbank (Tabelle TransaktionsName)
// statt in einer Datei unter /app/.gateway-data — der Ordner ist im Fly-
// Container schreibgeschuetzt (EACCES), dadurch gingen alle Namen verloren.
// Die Lesefunktionen bleiben synchron: ein Speicherabbild wird beim Start
// geladen (vorladenTransaktionsnamen) und bei jedem Schreiben nachgefuehrt.

import { getGatewayPool } from "./producer-pools";
import { logger } from "./logger";

const cache = new Map<string, string>();
let geladen: Promise<void> | null = null;

/** Beim Start einmal aufrufen; spaetere Aufrufe teilen sich den ersten Lauf. */
export function vorladenTransaktionsnamen(): Promise<void> {
  if (geladen) return geladen;
  geladen = (async () => {
    try {
      const r = await getGatewayPool().query<{ transactionId: string; name: string }>(
        `SELECT "transactionId", name FROM "TransaktionsName"`,
      );
      for (const row of r.rows) if (!cache.has(row.transactionId)) cache.set(row.transactionId, row.name);
      logger.info({ anzahl: r.rows.length }, "[transaction-names] geladen");
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, "[transaction-names] Laden fehlgeschlagen");
      geladen = null;
    }
  })();
  return geladen;
}

/** Namen merken (leer = keine Angabe) und in die Datenbank schreiben. */
export function setTransactionName(transactionId: string, name: string | null | undefined): void {
  const trimmed = (name ?? "").trim().slice(0, 300);
  if (!transactionId || !trimmed) return;
  cache.set(transactionId, trimmed);
  void getGatewayPool()
    .query(
      `INSERT INTO "TransaktionsName" ("transactionId", name, "updatedAt") VALUES ($1, $2, NOW())
       ON CONFLICT ("transactionId") DO UPDATE SET name = EXCLUDED.name, "updatedAt" = NOW()`,
      [transactionId, trimmed],
    )
    .catch((err: unknown) => logger.warn({ err: err instanceof Error ? err.message : String(err), transactionId }, "[transaction-names] Schreiben fehlgeschlagen"));
}

export function getTransactionName(transactionId: string): string | null {
  if (!geladen) void vorladenTransaktionsnamen();
  return cache.get(transactionId) ?? null;
}

/** Sammelabfrage fuer die Liste. */
export function getTransactionNames(transactionIds: readonly string[]): Map<string, string> {
  if (!geladen) void vorladenTransaktionsnamen();
  const out = new Map<string, string>();
  for (const id of transactionIds) {
    const v = cache.get(id);
    if (v) out.set(id, v);
  }
  return out;
}
