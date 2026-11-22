// Staging/UAT (docs/PLAN_STAGING.md ST6): Freigabe eines Kandidaten ausliefern. Stößt den
// GitHub-Workflow `freigabe.yml` an (Desktop-Release auf „latest“, Prod-Gateway-Deploy desselben
// Commits, Web-Zweige vorspulen). Die Kunden-Server ziehen freigegebene Versionen von selbst
// (Rollout je Kanal). Ohne Token bleibt die Freigabe in der Datenbank stehen und der Workflow
// lässt sich von Hand starten.
import { logger } from "./logger";

const REPO = process.env.GH_FREIGABE_REPO || "eproX-GmbH/ava-services";

export async function freigabeAusliefern(version: string, von: string): Promise<{ ok: boolean; fehler?: string }> {
  const token = process.env.GH_FREIGABE_TOKEN?.trim();
  if (!token) return { ok: false, fehler: "Auslieferung nicht eingerichtet (GH_FREIGABE_TOKEN fehlt); Workflow freigabe.yml von Hand starten." };
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/freigabe.yml/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ava-gateway" },
    body: JSON.stringify({ ref: "main", inputs: { version: `v${version.replace(/^v/, "")}`, von } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (r.status !== 204) {
    const text = (await r.text().catch(() => "")).slice(0, 200);
    logger.warn({ version, status: r.status, text }, "[freigabe] Workflow-Start fehlgeschlagen");
    return { ok: false, fehler: `GitHub ${r.status}: ${text}` };
  }
  logger.info({ version, von }, "[freigabe] Workflow freigabe.yml gestartet");
  return { ok: true };
}
