// Z11 (docs/PLAN_ABRECHNUNG_ZUGANG.md, Joyce 2026-10-13): Abgerechnet wird jede
// Firma, die in einem Monat im Bestand ("Meine Firmen") eines Abrechnungskontos
// steht — einmal je Konto und Monat, egal wie viele Mitglieder oder Listen sie
// fuehren und egal, ob in dem Monat verarbeitet wurde. Entfernen aus "Meine
// Firmen" wirkt ab dem Folgemonat. Bestand = Firmen aus den eigenen Vorgaengen
// (master-data Transaction.userId) minus Tombstones (CompanyTombstone).
//
//   - bestandVerbuchen(): einmal je Konto und Periode (BillingEvent
//     bestand_verbucht), laeuft im Billing-Cron; schreibt UsageEntry source
//     'bestand' und ordnet die Stufe zu.
//   - bestandAufnahme(): beim Import (Vorgangsanlage) fuer bezahlte Konten —
//     die Firma zaehlt im laufenden Monat ab Aufnahme. Free bleibt beim alten
//     Weg (Zeile bei der Verarbeitung, 25 lebenslang).
import type { Pool } from "pg";
import { logger } from "./logger";
import { masterData } from "./register-jobs";
import { readBillingAccount, effectiveTier, periodKeyFor, resolveBillingAccountId, ensureBillingAccount, recordUsage } from "./billing";
import { recordBillingEvent } from "./billing-events";

async function bestandJeKonto(pool: Pool, billingAccountId: string, kind: string, mode: string): Promise<{ userIds: string[]; companyIds: string[] }> {
  const userIds: string[] = [];
  if (kind === "organisation" && (mode === "seats" || mode === "enterprise")) {
    const m = await pool.query<{ actorId: string }>(`SELECT "actorId" FROM "TenantMember" WHERE "tenantId" = $1`, [billingAccountId]);
    userIds.push(...m.rows.map((r) => r.actorId));
  } else {
    userIds.push(billingAccountId);
  }
  if (userIds.length === 0) return { userIds, companyIds: [] };
  const r = await masterData<{ rows: Array<{ userId: string; companyId: string }> }>("POST", "/internal/transactions/companies-by-users", { userIds });
  const tomb = await pool.query<{ userId: string; companyId: string }>(
    `SELECT "userId", "companyId" FROM "CompanyTombstone" WHERE "userId" = ANY($1::text[])`,
    [userIds],
  );
  const weg = new Set(tomb.rows.map((t) => `${t.userId}|${t.companyId}`));
  const ids = new Set<string>();
  for (const row of r.rows ?? []) if (!weg.has(`${row.userId}|${row.companyId}`)) ids.add(row.companyId);
  return { userIds, companyIds: [...ids] };
}

/** Monatslauf: fuer jedes bezahlte Konto den Bestand der laufenden Periode verbuchen. */
export async function bestandVerbuchen(pool: Pool, now: Date = new Date()): Promise<{ konten: number; zeilen: number }> {
  const periodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const konten = await pool.query<{ tenantId: string; kind: string; mode: string }>(
    `SELECT b."tenantId", b."kind", b."mode" FROM "TenantBilling" b
      WHERE b."mode" IN ('subscription', 'seats', 'enterprise')
        AND NOT EXISTS (SELECT 1 FROM "BillingEvent" e WHERE e."billingAccountId" = b."tenantId" AND e.kind = 'bestand_verbucht' AND e.payload->>'periodKey' = $1)`,
    [periodKey],
  );
  let zeilen = 0;
  let n = 0;
  for (const k of konten.rows) {
    try {
      const acc = await readBillingAccount(pool, k.tenantId);
      if (!acc || effectiveTier(acc) === "free") continue;
      const { userIds, companyIds } = await bestandJeKonto(pool, k.tenantId, k.kind, k.mode);
      const ins = await pool.query(
        `INSERT INTO "UsageEntry" ("billingAccountId", "periodKey", "companyId", source, "createdAt")
         SELECT $1, $2, c, 'bestand', NOW() FROM unnest($3::text[]) c
         ON CONFLICT ("billingAccountId", "periodKey", "companyId") DO NOTHING`,
        [k.tenantId, periodKey, companyIds],
      );
      zeilen += ins.rowCount ?? 0;
      n++;
      await recordBillingEvent(pool, {
        billingAccountId: k.tenantId,
        kind: "bestand_verbucht",
        source: "cron",
        payload: { periodKey, mitglieder: userIds.length, bestand: companyIds.length, neu: ins.rowCount ?? 0 },
      });
      // Stufen fuer Zeilen ohne Zuordnung (best-effort, nacheinander).
      const offen = await pool.query<{ companyId: string }>(
        `SELECT "companyId" FROM "UsageEntry" WHERE "billingAccountId" = $1 AND "periodKey" = $2 AND "stufe" IS NULL`,
        [k.tenantId, periodKey],
      );
      const { stufeZuordnen } = await import("./stufen");
      for (const row of offen.rows) await stufeZuordnen(pool, row.companyId, "bestand");
      logger.info({ billingAccountId: k.tenantId, periodKey, bestand: companyIds.length, neu: ins.rowCount ?? 0 }, "[bestand] Monat verbucht");
    } catch (err) {
      logger.warn({ billingAccountId: k.tenantId, periodKey, err: err instanceof Error ? err.message : String(err) }, "[bestand] Verbuchung fehlgeschlagen (naechster Lauf)");
    }
  }
  return { konten: n, zeilen };
}

/** Beim Import: Firmen zaehlen im laufenden Monat ab Aufnahme (bezahlte Konten). */
export async function bestandAufnahme(pool: Pool, args: { tenantId: string; actorId: string | null; companyIds: string[] }): Promise<void> {
  if (args.companyIds.length === 0) return;
  try {
    const billingAccountId = await resolveBillingAccountId(pool, { tenantId: args.tenantId, actorId: args.actorId });
    const acc = await ensureBillingAccount(pool, billingAccountId, "personal");
    const tier = effectiveTier(acc);
    if (tier === "free") return; // Free: Zeile entsteht bei der Verarbeitung (25 lebenslang)
    void periodKeyFor(tier);
    for (const companyId of args.companyIds) {
      await recordUsage(pool, logger, { tenantId: args.tenantId, actorId: args.actorId, companyId, source: "aufnahme" });
    }
  } catch (err) {
    logger.warn({ tenantId: args.tenantId, err: err instanceof Error ? err.message : String(err) }, "[bestand] Aufnahme nicht verbucht");
  }
}
