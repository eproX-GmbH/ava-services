// Staging/UAT (docs/PLAN_STAGING.md ST6): Freigabe eines Kandidaten ausliefern. Stößt den
// GitHub-Workflow `freigabe.yml` an (Desktop-Release auf „latest“, Prod-Gateway-Deploy desselben
// Commits, Web-Zweige vorspulen). Die Kunden-Server ziehen freigegebene Versionen von selbst
// (Rollout je Kanal). Ohne Token bleibt die Freigabe in der Datenbank stehen und der Workflow
// lässt sich von Hand starten.
import { z } from "zod";
import { logger } from "./logger";

const REPO = process.env.GH_FREIGABE_REPO || "eproX-GmbH/ava-services";
/** Nur dieser Ordner wird ins Gateway gebaut (Build-Ordner des Fly-Deploys). */
const GATEWAY_ORDNER = "services/db-gateway/";
/** GitHub liefert im Vergleich höchstens 300 Dateien; ab da gilt die Liste als unvollständig. */
const DATEIEN_GRENZE = 300;

const VergleichSchema = z.object({
  ahead_by: z.number(),
  files: z.array(z.object({ filename: z.string() })).optional(),
});

export type FreigabePruefung = { ok: true; basis: string } | { ok: false; grund: string };

/**
 * Schutz vor dem Zurückdrehen (Vorfall 2026-11-23): Die Freigabe baut das Prod-Gateway aus dem
 * Tag der Version. Läuft Prod schon mit neuerem Gateway-Code als dieser Tag (Direkt-Deploy, oder
 * eine ältere Version wird nach einer neueren freigegeben), nähme die Freigabe ihn still zurück.
 *
 * Vergleich über GitHub: Tag gegen den Commit, aus dem dieses Gateway gebaut ist (GATEWAY_COMMIT).
 * Ist er unbekannt, gegen main; das ist strenger (der Tag muss dann alle Gateway-Änderungen von
 * main enthalten), aber sicher: Direkt-Deploys kommen von main. Ohne Antwort von GitHub gibt es
 * keine Freigabe (der Workflow ließe sich dann ohnehin nicht starten).
 */
export async function freigabePruefen(
  version: string,
  d: { holen?: typeof fetch; commit?: string | null; token?: string | null } = {},
): Promise<FreigabePruefung> {
  const holen = d.holen ?? fetch;
  const tag = `v${version.replace(/^v/, "")}`;
  const token = (d.token === undefined ? process.env.GH_FREIGABE_TOKEN : d.token)?.trim();
  const eigen = (d.commit === undefined ? process.env.GATEWAY_COMMIT : d.commit)?.trim() || null;
  const vergleich = async (basis: string) => {
    const r = await holen(`https://api.github.com/repos/${REPO}/compare/${encodeURIComponent(tag)}...${encodeURIComponent(basis)}`, {
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ava-gateway" },
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, daten: r.ok ? VergleichSchema.safeParse(await r.json().catch(() => null)) : null };
  };
  try {
    let basis = eigen ?? "main";
    let v = await vergleich(basis);
    // Eigener Commit bei GitHub unbekannt (lokaler Stand): wie „unbekannt“ behandeln.
    if (v.status === 404 && basis !== "main") { basis = "main"; v = await vergleich(basis); }
    if (!v.daten?.success) {
      logger.warn({ version, basis, status: v.status }, "[freigabe] Prüfung nicht möglich");
      return { ok: false, grund: `Die Prüfung vor der Freigabe ist gerade nicht möglich (GitHub antwortet mit ${v.status}). Bitte gleich noch einmal versuchen.` };
    }
    const dateien = v.daten.data.files ?? [];
    const gateway = dateien.filter((f) => f.filename.startsWith(GATEWAY_ORDNER));
    if (v.daten.data.ahead_by === 0 || (gateway.length === 0 && dateien.length < DATEIEN_GRENZE)) return { ok: true, basis };
    const menge = gateway.length === 1 ? "1 geänderte Datei" : `${gateway.length || "viele"} geänderte Dateien`;
    logger.warn({ version, basis, voraus: v.daten.data.ahead_by, gateway: gateway.length }, "[freigabe] abgelehnt: Freigabe nähme neueren Gateway-Code zurück");
    return {
      ok: false,
      grund: basis === "main"
        ? `Version ${version} enthält nicht alle Server-Änderungen des Hauptzweigs (${menge}), und der Stand der Produktion ist nicht bekannt. Die Freigabe könnte neueren Server-Code zurücknehmen. Bitte einen neuen Kandidaten erstellen und den freigeben.`
        : `Die Produktion läuft schon mit neuerem Server-Code als Version ${version} (${menge}). Die Freigabe würde ihn zurücknehmen. Bitte einen neuen Kandidaten erstellen und den freigeben.`,
    };
  } catch (err) {
    logger.warn({ version, err: err instanceof Error ? err.message : String(err) }, "[freigabe] Prüfung fehlgeschlagen");
    return { ok: false, grund: "Die Prüfung vor der Freigabe ist gerade nicht möglich (GitHub nicht erreichbar). Bitte gleich noch einmal versuchen." };
  }
}

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
