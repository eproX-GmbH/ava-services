// Register-Personen fuer das Buying Center: eingetragene Geschaeftsfuehrer
// (structured-content, fuer praktisch jede Firma vorhanden) und natuerliche
// Gesellschafter der aktuellen Gesellschafterliste (master-data, nur mit
// Orga-Feature `verflechtungen` und nach Abruf ueber den DK-Knopf).
//
// Reines Laden und Zusammenfuehren; was daraus im Buying Center wird, steht
// in routes/v1/buying-center.ts (registerNachziehen) und die Vorschlaege in
// lib/buying-center-vorschlag.ts.

import type { Context } from "hono";
import { getGatewayPool, getProducerPool } from "./producer-pools";
import { callUpstream } from "./upstream";
import { loadFeatures } from "./policy-guard";
import { logger } from "./logger";
import { gleicherName, type RegisterPerson } from "./buying-center-vorschlag";

interface Beteiligung { typ: "PERSON" | "FIRMA"; personName: string | null; prozent: number | null; listeDatum: string }

export async function registerPersonenLaden(c: Context | null, tenantId: string, companyId: string): Promise<RegisterPerson[]> {
  const aus: RegisterPerson[] = [];
  const md = await getProducerPool("structured-content").query<{ firstName: string; lastName: string }>(
    `SELECT "firstName", "lastName" FROM "ManagingDirector" WHERE "companyId" = $1 ORDER BY id`,
    [companyId],
  );
  for (const r of md.rows) {
    const name = `${r.firstName ?? ""} ${r.lastName ?? ""}`.replace(/\s+/g, " ").trim();
    if (!name || aus.some((x) => gleicherName(x.name, name))) continue;
    aus.push({ name, geschaeftsfuehrer: true, gesellschafter: null });
  }

  // Gesellschafter nur mit Feature — und nie ein Fehler nach aussen: Ohne
  // Liste gibt es eben nur die Geschaeftsfuehrer.
  if (c) {
    try {
      const feats = await loadFeatures(getGatewayPool(), tenantId);
      if (feats["verflechtungen"] !== false) {
        const u = await callUpstream<{ beteiligungen?: Beteiligung[] }>(c, "masterData", `/api/germany/v1/companies/${encodeURIComponent(companyId)}/shareholders`);
        for (const b of u.beteiligungen ?? []) {
          if (b.typ !== "PERSON" || !b.personName?.trim()) continue;
          const name = b.personName.replace(/\s+/g, " ").trim();
          const gesellschafter = { prozent: typeof b.prozent === "number" ? b.prozent : null, listeDatum: b.listeDatum ?? null };
          const vorhanden = aus.find((x) => gleicherName(x.name, name));
          if (vorhanden) vorhanden.gesellschafter = vorhanden.gesellschafter ?? gesellschafter;
          else aus.push({ name, geschaeftsfuehrer: false, gesellschafter });
        }
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), companyId }, "buying-center: gesellschafterliste nicht lesbar");
    }
  }
  return aus;
}
