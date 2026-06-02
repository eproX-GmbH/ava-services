// Producer on-disk directory resolution (Windows MAX_PATH fix, v0.1.363).
//
// The bundled producer trees contain a pathological compiled path:
//   dist/application/processing-errors/queries/
//     list-processing-errors-by-transaction-id-and-company-id/
//     list-processing-errors-by-transaction-id-and-company-id-query-mapper.js
// (~170 chars on its own). Under the old `resources/producers/<long-name>/`
// layout the installed absolute path for a producer such as
// `structured-content` or `company-publication` exceeded Windows' 260-char
// MAX_PATH (e.g. 261 for user "Patrick"). The NSIS installer silently drops
// over-long files → the producer crashes on boot with MODULE_NOT_FOUND →
// the whole pipeline stalls (macOS has no such limit, so it was fine).
//
// `fetch-producers.mjs` now vendors each producer into `resources/p/<code>/`
// (a 2-3 char short directory) and writes a `dirs.json` manifest mapping the
// logical producer name → short directory. This module reads that manifest
// at runtime so the supervisor and the boot-time existence check resolve the
// correct directory WITHOUT duplicating the map (which would drift). Legacy
// `resources/producers/<name>/` layouts are still honoured as a fallback so
// a half-migrated dev tree keeps working.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Cache the parsed manifest per resources-root (stable per process). */
const manifestCache = new Map<string, Record<string, string> | null>();

function loadManifest(resourcesRoot: string): Record<string, string> | null {
  const cached = manifestCache.get(resourcesRoot);
  if (cached !== undefined) return cached;
  let parsed: Record<string, string> | null = null;
  try {
    const p = join(resourcesRoot, "p", "dirs.json");
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
      if (raw && typeof raw === "object") {
        parsed = raw as Record<string, string>;
      }
    }
  } catch {
    parsed = null;
  }
  manifestCache.set(resourcesRoot, parsed);
  return parsed;
}

/**
 * Resolve the on-disk directory for a producer under a given resources root
 * (e.g. `process.resourcesPath` packaged, or `<appPath>/resources` in dev).
 *
 * Tries, in order:
 *   1. `resources/p/<short-code>` via the dirs.json manifest (current layout)
 *   2. `resources/p/<name>`        (manifest missing but new root exists)
 *   3. `resources/producers/<name>` (legacy pre-v0.1.363 layout)
 *
 * Returns the first path that exists, or null if the producer isn't vendored.
 */
export function resolveProducerDirUnder(
  resourcesRoot: string,
  name: string,
): string | null {
  if (!resourcesRoot) return null;
  const candidates: string[] = [];
  const code = loadManifest(resourcesRoot)?.[name];
  if (code) candidates.push(join(resourcesRoot, "p", code));
  candidates.push(join(resourcesRoot, "p", name));
  candidates.push(join(resourcesRoot, "producers", name));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
