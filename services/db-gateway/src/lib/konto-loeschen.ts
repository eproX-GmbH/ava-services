// Konto loeschen (docs/PLAN_KONTO_LOESCHEN.md, Joyce 2026-11-08). Unumkehrbar.
//
// Regeln:
//   - Organisation wird nie geloescht, es bleibt immer mind. ein Owner.
//   - Allein in der Organisation → kein Loeschen, aber Deaktivieren (Joyce
//     2026-11-08): Keycloak-Konto aus, Sitzungen beendet, Daten bleiben (Rechnungs-
//     ansprechpartner). Nur das AVA-Team kann es wieder einschalten.
//   - Einziger Owner mit weiteren Mitgliedern → erst Inhaberschaft uebertragen.
//   - Enterprise (Organisation oder Konto mit Abrechnungsmodus/Stufe enterprise):
//     nie selbst, immer ueber das AVA-Team (z. B. eigener Server auf Fly).
//   - Abo: endet zum Ende der laufenden Zahlungsperiode (cancel_at_period_end),
//     keine Erstattung; der Dialog sagt das vorher.
//   - Keycloak: anonymisieren statt loeschen (E-Mail = <sub>@<Domain>, Namen
//     "*****", deaktiviert, Sitzungen beendet, Attribut ava_geloescht).
//   - Eigene Daten loeschen; geteilte Inhalte bleiben unter der pseudonymen ID;
//     Abrechnung bleibt (Aufbewahrung), Namen/E-Mails dort anonymisiert.

import type pg from "pg";
import type { AuthContext } from "../middleware/auth";
import { logger } from "./logger";
import { removeMember } from "./tenants";
import { kontoInKeycloakAnonymisieren, kontoInKeycloakDeaktivieren, listeEinwilligungen, widerrufeEinwilligung } from "./keycloak-admin";
import { getProducerPool } from "./producer-pools";
import { invalidateMembership } from "./membership-cache";
import { readBillingAccount } from "./billing";
import { recordBillingEvent } from "./billing-events";

export const STERNE = "*****";

/** Laufendes bezahltes Abo, das mit dem Loeschen/Deaktivieren zum Periodenende endet. */
export interface AboHinweis { endetAm: string | null; bereitsGekuendigt: boolean }

export type Pruefung =
  | { moeglich: true; organisation: string | null; abo: AboHinweis | null }
  | { moeglich: false; grund: "allein_in_organisation"; organisation: string | null; mitglieder: number; abo: AboHinweis | null }
  | { moeglich: false; grund: "einziger_owner" | "enterprise"; organisation: string | null; mitglieder: number };

async function aboHinweis(pool: pg.Pool, billingAccountId: string): Promise<AboHinweis | null> {
  const acc = await readBillingAccount(pool, billingAccountId).catch(() => null);
  if (!acc?.stripeSubscriptionId || acc.status === "canceled") return null;
  return { endetAm: acc.periodEnd?.toISOString() ?? null, bereitsGekuendigt: acc.cancelAtPeriodEnd };
}

async function istEnterprise(pool: pg.Pool, ids: string[]): Promise<boolean> {
  for (const id of ids) {
    const acc = await readBillingAccount(pool, id).catch(() => null);
    if (acc && ((acc.mode as string) === "enterprise" || (acc.tier as string) === "enterprise")) return true;
  }
  return false;
}

/** Abo zum Ende der Zahlungsperiode beenden (keine Erstattung). */
async function aboZumPeriodenende(pool: pg.Pool, billingAccountId: string, actorId: string, grund: string): Promise<void> {
  const acc = await readBillingAccount(pool, billingAccountId);
  if (!acc?.stripeSubscriptionId || acc.cancelAtPeriodEnd || acc.status === "canceled") return;
  const { getStripe } = await import("./stripe-client");
  await getStripe().subscriptions.update(acc.stripeSubscriptionId, { cancel_at_period_end: true, metadata: { cancelReason: grund } });
  await pool.query(`UPDATE "TenantBilling" SET "cancelAtPeriodEnd" = TRUE, "updatedAt" = NOW() WHERE "tenantId" = $1`, [billingAccountId]);
  await recordBillingEvent(pool, {
    billingAccountId, kind: "subscription_cancel_scheduled", source: "system", actorId,
    payload: { reason: grund, subscriptionId: acc.stripeSubscriptionId, periodEnd: acc.periodEnd?.toISOString() ?? null },
  });
}

export function anonymeEmail(sub: string, email: string | null | undefined): string {
  const at = (email ?? "").lastIndexOf("@");
  const domain = at > 0 ? (email ?? "").slice(at + 1).toLowerCase() : "geloescht.ava.bi";
  return `${sub}@${domain}`;
}

/** Darf dieses Konto geloescht werden? (Organisationsregeln) */
export async function pruefen(pool: pg.Pool, actorId: string): Promise<Pruefung> {
  const m = await pool.query<{ tenantId: string; role: string; kind: string; name: string | null }>(
    `SELECT m."tenantId", m."role", t."kind", t."name" FROM "TenantMember" m JOIN "Tenant" t ON t."id" = m."tenantId" WHERE m."actorId" = $1 LIMIT 1`,
    [actorId],
  );
  const z = m.rows[0];
  if (await istEnterprise(pool, [actorId, ...(z ? [z.tenantId] : [])])) {
    return { moeglich: false, grund: "enterprise", organisation: z?.name ?? null, mitglieder: 0 };
  }
  if (!z || z.kind !== "organisation") return { moeglich: true, organisation: null, abo: await aboHinweis(pool, actorId) };
  const n = await pool.query<{ alle: string; owner: string }>(
    `SELECT COUNT(*)::text AS alle, COUNT(*) FILTER (WHERE "role" = 'owner')::text AS owner FROM "TenantMember" WHERE "tenantId" = $1`,
    [z.tenantId],
  );
  const alle = Number(n.rows[0]?.alle ?? 0);
  const owner = Number(n.rows[0]?.owner ?? 0);
  if (alle <= 1) return { moeglich: false, grund: "allein_in_organisation", organisation: z.name, mitglieder: alle, abo: await aboHinweis(pool, z.tenantId) };
  if (z.role === "owner" && owner <= 1) return { moeglich: false, grund: "einziger_owner", organisation: z.name, mitglieder: alle };
  // Mitglied einer Organisation: deren Abrechnung laeuft weiter (Sitz wird frei);
  // ein eigenes persoenliches Abo endet zum Periodenende.
  return { moeglich: true, organisation: z.name, abo: await aboHinweis(pool, actorId) };
}

// ---- gesperrte Konten (Anmeldepruefung) ------------------------------------

let geloescht: Set<string> | null = null;
let geladenAm = 0;
const NEU_LADEN_MS = 60_000;

export async function istGeloescht(pool: pg.Pool, actorId: string): Promise<boolean> {
  if (!geloescht || Date.now() - geladenAm > NEU_LADEN_MS) {
    try {
      const r = await pool.query<{ actorId: string }>(`SELECT "actorId" FROM "KontoStatus"`);
      // geloescht UND deaktiviert: beide duerfen sich nicht mehr anmelden
      geloescht = new Set(r.rows.map((x) => x.actorId));
      geladenAm = Date.now();
    } catch {
      // Tabelle fehlt (Migration ausstehend): niemanden aussperren
      return false;
    }
  }
  return geloescht.has(actorId);
}

/** Welche der genannten Konten sind geloescht oder deaktiviert? (Kontowechsler) */
export async function geloeschteKonten(pool: pg.Pool, subs: string[]): Promise<string[]> {
  if (subs.length === 0) return [];
  const r = await pool.query<{ actorId: string }>(`SELECT "actorId" FROM "KontoStatus" WHERE "actorId" = ANY($1::text[])`, [subs.slice(0, 50)]);
  return r.rows.map((x) => x.actorId);
}

// ---- Loeschen --------------------------------------------------------------

/** Eigene Daten: [Tabelle, Spalte]. Fehlende Tabellen werden uebersprungen. */
const EIGENE_DATEN: Array<[string, string]> = [
  ["RelevanzSignal", "actorId"],
  ["RelevanzWert", "actorId"],
  ["RelevanzSperre", "actorId"],
  ["FokusKunde", "actorId"],
  ["FirmenZustand", "actorId"],
  ["CompanyResearchLauf", "actorId"],
  ["A2aTask", "actorId"],
  ["DienstEreignis", "actorId"],
  ["WebhookEmpfaenger", "actorId"],
  ["OrgShareSeen", "actorId"],
  ["SuchBlock", "actorId"],
  ["BuyingCenter", "eigentuemerActorId"],
  ["PromptAudit", "actorId"],
  ["NutzerAktivitaet", "actorId"],
  ["DiscoveryScan", "actorId"],
  ["DiscoveryDecision", "userId"],
  ["CompanyTombstone", "userId"],
  ["HiddenTransaction", "userId"],
  ["LinkedInLead", "actorId"],
  ["StartAuftrag", "actorId"],
  ["MailVersand", "actorId"],
  ["MailEinstellung", "actorId"],
];

export interface LoeschErgebnis {
  geloeschteZeilen: Record<string, number>;
  keycloak: boolean;
  fehler: string[];
}

export async function kontoLoeschen(pool: pg.Pool, auth: AuthContext, deps: { masterDataAnonymisieren?: (sub: string, email: string) => Promise<void> } = {}): Promise<LoeschErgebnis | { abgelehnt: Pruefung }> {
  const sub = auth.actorId;
  const p = await pruefen(pool, sub);
  if (!p.moeglich) return { abgelehnt: p };
  const fehler: string[] = [];
  const email = auth.email ?? (await pool.query<{ email: string | null }>(`SELECT "email" FROM "TenantMember" WHERE "actorId" = $1`, [sub])).rows[0]?.email ?? null;
  const anon = anonymeEmail(sub, email);

  // 1. Marke zuerst: ab jetzt weist die Anmeldepruefung das Konto ab.
  await pool.query(
    `INSERT INTO "KontoStatus" ("actorId", "art", "domain") VALUES ($1, 'geloescht', $2)
     ON CONFLICT ("actorId") DO UPDATE SET "art" = 'geloescht', "domain" = EXCLUDED."domain", "am" = NOW()`,
    [sub, anon.slice(anon.indexOf("@") + 1)],
  );
  geloescht?.add(sub);

  // 2. Organisation verlassen (Sitz frei, Mitgliedschaft geschlossen, Abrechnungsereignis).
  if (p.organisation !== null) {
    try {
      await removeMember(pool, auth, sub);
    } catch (err) {
      fehler.push(`Organisation verlassen: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2b. Eigenes Abo zum Periodenende beenden (keine Erstattung).
  try {
    await aboZumPeriodenende(pool, sub, sub, "konto_geloescht");
  } catch (err) {
    fehler.push(`Abo beenden: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Eigene Daten loeschen.
  const geloeschteZeilen: Record<string, number> = {};
  for (const [tabelle, spalte] of EIGENE_DATEN) {
    try {
      const r = await pool.query(`DELETE FROM "${tabelle}" WHERE "${spalte}" = $1`, [sub]);
      if ((r.rowCount ?? 0) > 0) geloeschteZeilen[tabelle] = r.rowCount ?? 0;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!/does not exist/.test(m)) fehler.push(`${tabelle}: ${m}`);
    }
  }

  // 3b. Themen-Befunde (Website-Datenbank) und MCP-Einwilligungen samt dynamischer Clients.
  try {
    const r = await getProducerPool("website").query(`DELETE FROM "CompanyThema" WHERE "actorId" = $1`, [sub]);
    if ((r.rowCount ?? 0) > 0) geloeschteZeilen.CompanyThema = r.rowCount ?? 0;
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (!/does not exist/.test(m)) fehler.push(`CompanyThema: ${m}`);
  }
  try {
    for (const e of await listeEinwilligungen(sub)) await widerrufeEinwilligung(sub, e.clientId).catch(() => undefined);
  } catch (err) {
    fehler.push(`Einwilligungen: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 4. Anonymisieren, was bleiben muss (Mitgliedschaft, Abrechnung, Support).
  const anonym: Array<[string, string]> = [
    [`UPDATE "TenantMember" SET "email" = $2, "name" = '${STERNE}' WHERE "actorId" = $1`, "TenantMember"],
    [`UPDATE "TenantJoinRequest" SET "email" = $2, "name" = '${STERNE}' WHERE "actorId" = $1`, "TenantJoinRequest"],
    [`UPDATE "TenantMembership" SET "email" = $2, "name" = '${STERNE}' WHERE "actorId" = $1`, "TenantMembership"],
    [`UPDATE "SeatInvoiceSeat" SET "email" = $2, "name" = '${STERNE}' WHERE "actorId" = $1`, "SeatInvoiceSeat"],
    [`UPDATE "ProblemMeldung" SET "actorEmail" = $2, "actorName" = '${STERNE}' WHERE "actorId" = $1`, "ProblemMeldung"],
    [`UPDATE "ProblemNachricht" SET "actorName" = '${STERNE}' WHERE "actorId" = $1 AND $2::text IS NOT NULL`, "ProblemNachricht"],
    [`UPDATE "Tenant" SET "name" = $2 WHERE "id" = $1 AND "kind" = 'personal'`, "Tenant"],
  ];
  for (const [sql, name] of anonym) {
    try {
      await pool.query(sql, [sub, anon]);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (!/does not exist/.test(m)) fehler.push(`${name}: ${m}`);
    }
  }
  invalidateMembership(sub);

  // 5. master-data (Nutzer-Zeile) und Keycloak zuletzt.
  if (deps.masterDataAnonymisieren) {
    try {
      await deps.masterDataAnonymisieren(sub, anon);
    } catch (err) {
      fehler.push(`master-data: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let keycloak = false;
  try {
    await kontoInKeycloakAnonymisieren(sub, anon, STERNE);
    keycloak = true;
  } catch (err) {
    fehler.push(`Keycloak: ${err instanceof Error ? err.message : String(err)}`);
  }
  await pool.query(`UPDATE "KontoStatus" SET "fehler" = $2 WHERE "actorId" = $1`, [sub, fehler.length ? fehler.join(" | ").slice(0, 2000) : null]).catch(() => undefined);
  logger.info({ actorId: sub, geloeschteZeilen, keycloak, fehler: fehler.length }, "[konto-loeschen] Konto geloescht");
  return { geloeschteZeilen, keycloak, fehler };
}

/**
 * Allein in der Organisation: Konto deaktivieren statt loeschen. Keine
 * Anonymisierung (Rechnungsansprechpartner der Organisation bleibt erhalten),
 * nur Anmeldung gesperrt. Nur fuer diesen Fall erlaubt.
 */
export async function kontoDeaktivieren(pool: pg.Pool, auth: AuthContext): Promise<{ ok: true; keycloak: boolean; fehler: string[] } | { abgelehnt: Pruefung | { moeglich: true } }> {
  const p = await pruefen(pool, auth.actorId);
  if (p.moeglich || p.grund !== "allein_in_organisation") return { abgelehnt: p };
  await pool.query(
    `INSERT INTO "KontoStatus" ("actorId", "art") VALUES ($1, 'deaktiviert') ON CONFLICT ("actorId") DO NOTHING`,
    [auth.actorId],
  );
  geloescht?.add(auth.actorId);
  const fehler: string[] = [];
  // Abo der Organisation (nur diese Person) zum Periodenende beenden, keine Erstattung.
  const org = (await pool.query<{ tenantId: string }>(`SELECT "tenantId" FROM "TenantMember" WHERE "actorId" = $1`, [auth.actorId])).rows[0]?.tenantId;
  for (const id of [org, auth.actorId].filter((x): x is string => !!x)) {
    try {
      await aboZumPeriodenende(pool, id, auth.actorId, "konto_deaktiviert");
    } catch (err) {
      fehler.push(`Abo beenden: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  let keycloak = false;
  try {
    await kontoInKeycloakDeaktivieren(auth.actorId);
    keycloak = true;
  } catch (err) {
    fehler.push(`Keycloak: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fehler.length) await pool.query(`UPDATE "KontoStatus" SET "fehler" = $2 WHERE "actorId" = $1`, [auth.actorId, fehler.join(" | ")]).catch(() => undefined);
  logger.info({ actorId: auth.actorId, keycloak }, "[konto-loeschen] Konto deaktiviert (allein in der Organisation)");
  return { ok: true, keycloak, fehler };
}
