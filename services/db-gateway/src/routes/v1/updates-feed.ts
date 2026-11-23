// Staging/UAT (docs/PLAN_STAGING.md ST5): Update-Feed der Desktop-App je Kanal, öffentlich
// (die Installationsdateien liegen ohnehin öffentlich in eproX-GmbH/ava-releases).
//
//   GET /v1/updates/{staging|prod}/{latest-mac.yml|latest.yml}
//
// Liefert die latest*.yml der Version, die der Kanal bekommen soll (staging: neuester nicht
// verworfener Kandidat, prod: höchste freigegebene), mit absoluten Download-Adressen auf GitHub.
// Staging-Konten stellen ihren electron-updater auf diesen Feed um; Prod bleibt bei GitHub latest.
import { OpenAPIHono } from "@hono/zod-openapi";
import { getGatewayPool } from "../../lib/producer-pools";
import { kandidatenVermerken, neueKandidaten, releasesLesen, zielVersion, type Kanal } from "../../lib/kanal";
import { logger } from "../../lib/logger";

const REPO = process.env.DESKTOP_RELEASES_REPO || "eproX-GmbH/ava-releases";
const DATEIEN = new Set(["latest-mac.yml", "latest.yml", "latest-linux.yml"]);

interface GhRelease { tag_name: string; draft: boolean; prerelease: boolean; assets: Array<{ name: string; browser_download_url: string }> }
let releasesMerk: { wert: GhRelease[]; bis: number } = { wert: [], bis: 0 };
const ymlMerk = new Map<string, string>();

async function ghReleases(): Promise<GhRelease[]> {
  if (releasesMerk.bis > Date.now()) return releasesMerk.wert;
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=40`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "ava-gateway" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  releasesMerk = { wert: (await r.json()) as GhRelease[], bis: Date.now() + 5 * 60_000 };
  return releasesMerk.wert;
}

/** Relative Dateinamen (url:, path:) in absolute Download-Adressen der Version umschreiben. */
export function ymlAbsolut(yml: string, version: string, repo = REPO): string {
  const basis = `https://github.com/${repo}/releases/download/v${version}/`;
  return yml
    .split("\n")
    .map((z) => z.replace(/^(\s*(?:-\s+)?(?:url|path):\s*)(?:'([^']+)'|"([^"]+)"|([^'"\s]+))\s*$/, (m, kopf: string, a?: string, b?: string, c?: string) => {
      const name = a ?? b ?? c ?? "";
      return /^https?:/.test(name) ? m : `${kopf}${basis}${encodeURIComponent(name)}`;
    }))
    .join("\n");
}

export const updatesFeedRouter = new OpenAPIHono();

updatesFeedRouter.get("/updates/:kanal{staging|prod}/:datei", async (c) => {
  const kanal = c.req.param("kanal") as Kanal;
  const datei = c.req.param("datei");
  if (!DATEIEN.has(datei)) return c.text("not found", 404);
  try {
    const pool = getGatewayPool();
    const releases = (await ghReleases()).filter((r) => !r.draft && r.assets.some((a) => a.name === datei));
    const versionen = releases.map((r) => r.tag_name.replace(/^v/, ""));
    let zeilen = await releasesLesen(pool);
    const neu = neueKandidaten(versionen, zeilen, "desktop");
    if (neu.length) {
      await kandidatenVermerken(pool, neu, "desktop");
      zeilen = await releasesLesen(pool);
    }
    const version = zielVersion(versionen, zeilen, kanal);
    if (!version) return c.text("no release", 404);
    const schluessel = `${version}/${datei}`;
    let yml = ymlMerk.get(schluessel);
    if (!yml) {
      const asset = releases.find((r) => r.tag_name.replace(/^v/, "") === version)!.assets.find((a) => a.name === datei)!;
      const r = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
      if (!r.ok) throw new Error(`Asset ${r.status}`);
      yml = ymlAbsolut(await r.text(), version);
      ymlMerk.set(schluessel, yml);
    }
    return c.body(yml, 200, { "content-type": "text/yaml; charset=utf-8", "cache-control": "no-store", "x-ava-version": version });
  } catch (err) {
    logger.warn({ kanal, datei, err: err instanceof Error ? err.message : String(err) }, "[updates-feed] fehlgeschlagen");
    return c.text("feed unavailable", 503);
  }
});
