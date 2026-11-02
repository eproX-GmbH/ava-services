// Z10 (2026-10-13, Joyce): Erzwungene Neuverarbeitung (Frische-Markierung
// loeschen, kostenpflichtig) duerfen nur Admins ausloesen — Owner/Admin einer
// Organisation oder der Inhaber eines persoenlichen Tenants. Alle anderen und
// alle Hintergrundwege (Chat-Werkzeuge, MCP, Heartbeat, Auffrischung) respektieren
// die Frische-Markierung.
//
// docs/PLAN_PRICING_TIERS.md P5 (2026-11-02, Joyce): Mit PRICING_TIERS=1 gilt
//   - ganze Firma erzwingen (/v1/imports/by-ids): JEDE Rolle des Kontos, zaehlt
//     wie eine weitere Aufnahme zum Stufenpreis (Kontingent-Pruefung in P2);
//   - einzelne Stufe erzwingen (Retry-Endpunkt): nur der Betreiber (Keycloak-
//     Realm-Rolle, istBetreiber). Nicht erzwungene Retries (Reparatur fehlender
//     oder fehlgeschlagener Stufen, kostenlos, Frische bleibt) bleiben fuer alle.
import type { Pool, PoolClient } from "pg";
import type { AuthContext } from "../middleware/auth";
import { istBetreiber } from "../middleware/auth";

type Q = Pool | PoolClient;

export function pricingAktivRollen(): boolean {
  return process.env.PRICING_TIERS === "1";
}

/** P5 — einzelne Stufe erzwingen: nur Betreiber (mit Schalter), sonst Z10-Regel. */
export async function darfEinzelstufeErzwingen(q: Q, auth: AuthContext): Promise<boolean> {
  if (pricingAktivRollen()) return istBetreiber(auth);
  return darfErzwingen(q, auth.tenantId, auth.actorId);
}

/** P5 — ganze Firma erzwingen: mit Schalter jede Rolle, sonst Z10-Regel. */
export async function darfFirmaErzwingen(q: Q, auth: AuthContext): Promise<boolean> {
  if (pricingAktivRollen()) return Boolean(auth.actorId);
  return darfErzwingen(q, auth.tenantId, auth.actorId);
}

export async function darfErzwingen(q: Q, tenantId: string, actorId: string | null | undefined): Promise<boolean> {
  if (!actorId) return false;
  if (actorId === tenantId) return true;
  const t = await q.query<{ kind: string }>(`SELECT "kind" FROM "Tenant" WHERE "id" = $1`, [tenantId]);
  if (t.rows[0]?.kind === "personal") return true;
  const r = await q.query<{ role: string }>(`SELECT "role" FROM "TenantMember" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenantId, actorId]);
  return r.rows[0]?.role === "owner" || r.rows[0]?.role === "admin";
}

/** Pool-Stufen, deren Frische-Markierung eine erzwungene Neuverarbeitung loescht. */
export const POOL_STUFEN = ["website", "company-profile", "company-contact", "company-email", "company-publication", "structured-content"] as const;

export async function frischeLoeschen(q: Q, companyIds: string[], stages: readonly string[] = POOL_STUFEN): Promise<number> {
  if (companyIds.length === 0) return 0;
  const r = await q.query(`DELETE FROM "ContentFreshness" WHERE "companyId" = ANY($1::text[]) AND stage = ANY($2::text[])`, [companyIds, Array.from(stages)]);
  return r.rowCount ?? 0;
}
