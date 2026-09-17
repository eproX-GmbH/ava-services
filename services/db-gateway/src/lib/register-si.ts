// Register-Delta S8 (docs/PLAN_STAMMDATEN_DELTA.md): Der refresh-Job laedt den
// strukturierten Registerinhalt (SI) gleich mit. Das Ergebnis landet in der
// structured-content-Datenbank wie ein Persist des Producers (gleicher Kern,
// gleiche Diff-Ereignisse), setzt die Frische fuer die Stufe structured-content
// (Nutzer-Laeufe der naechsten 30 Tage ueberspringen den Portalabruf) und
// spiegelt Geschaeftsfuehrer und Adresse nach master-data. Kein Mandant, keine
// Nutzung, kein EntityProgress: das ist Betreiber-Substrat, nicht ein Nutzerlauf.

import { logger } from "./logger";
import { getProducerPool } from "./producer-pools";
import { recordFreshness, schreibeStructuredContent, spiegleStructuredContentNachMasterData, type StructuredContentResult } from "./persist-bus";

export type SiAusDelta = Omit<StructuredContentResult, "companyId">;

export async function schreibeSiAusDelta(companyId: string, si: SiAusDelta, jobId: string): Promise<"geschrieben" | "uebersprungen"> {
  const result: StructuredContentResult = { ...si, companyId };
  const jetzt = new Date();
  const geschrieben = await schreibeStructuredContent(getProducerPool("structured-content"), result, jetzt, logger, { runId: `register-delta:${jobId}`, tenantId: null });
  if (!geschrieben) return "uebersprungen";
  await recordFreshness(companyId, "structured-content", null, null, `register-delta:${jobId}`);
  try {
    await spiegleStructuredContentNachMasterData(result, jetzt.toISOString(), "register-delta");
  } catch (err) {
    logger.warn({ companyId, err: err instanceof Error ? err.message : String(err) }, "[register-si] Rollen-Spiegel fehlgeschlagen");
  }
  return "geschrieben";
}
