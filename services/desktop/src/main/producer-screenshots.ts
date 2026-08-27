// Producer screenshot inventory + serving.
//
// Selenium-driven producers (structured-content, company-publication,
// website) capture a PNG of the headless browser at every meaningful
// step — form fill, click, navigation, on-error. Captures land on
// disk under <userData>/screenshots/<producer>/<runId>/<ts>-<label>.png
// where runId is `<transactionId>:<companyId>` (matches the persist
// event runId, so the renderer can map a matrix cell directly to its
// frames).
//
// This module:
//   1. Owns the screenshot root directory and exposes the path so
//      ProducerSupervisor can pass it to the producer subprocess via
//      AVA_SCREENSHOT_DIR env var.
//   2. Provides IPC-friendly listing per (producer, runId) that the
//      renderer's drill-down panel queries when the Screenshots tab
//      opens.
//   3. Registers a custom electron protocol `ava-screenshot://` so
//      the renderer can render <img src="ava-screenshot://..."> via
//      the standard image pipeline (no base64 round-trip, no CSP
//      relaxation).
//   4. Prunes old captures on startup so disk usage stays bounded.

import { app, protocol, net } from "electron";
import { existsSync, promises as fs } from "node:fs";
import { join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** One week is plenty for "I'm debugging yesterday's failed import"
 *  flows; longer than that and the per-import ~50MB starts adding up. */
const CAPTURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScreenshotEntry {
  /** Filename in the per-runId directory. Used to construct the
   *  custom-protocol URL the renderer renders. */
  filename: string;
  /** Wallclock ms parsed from the filename prefix. */
  ts: number;
  /** Human-readable step name parsed from the filename suffix
   *  (`click_search`, `before_iframe_sweep`, `failure`, …). */
  label: string;
  /** Bytes on disk. Surfaced so the renderer can show "n KB" without
   *  reading the file. */
  size: number;
}

function screenshotsRoot(): string {
  return join(app.getPath("userData"), "screenshots");
}

/** Returns the path the producer should write to. Caller passes it
 *  in env var AVA_SCREENSHOT_DIR. The producer suffixes runId itself
 *  to avoid main-process round-trips per company. */
export function screenshotDirForProducer(producer: string): string {
  return join(screenshotsRoot(), producer);
}

/**
 * List all captures for a (producer, runId) pair, oldest first. Used
 * by the renderer's drill-down panel when opened on a matrix cell.
 *
 * Defensive: filename parsing tolerates unexpected names (returns
 * ts=0, label=filename) so a stray file doesn't break the listing.
 */
export async function listScreenshots(
  producer: string,
  runId: string,
): Promise<ScreenshotEntry[]> {
  const dir = join(screenshotsRoot(), producer, sanitizeSegment(runId));
  if (!existsSync(dir)) return [];
  const files = await fs.readdir(dir);
  const out: ScreenshotEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".png")) continue;
    const m = f.match(/^(\d+)-(.+)\.png$/);
    let stat;
    try {
      stat = await fs.stat(join(dir, f));
    } catch {
      continue;
    }
    out.push({
      filename: f,
      ts: m && m[1] ? Number(m[1]) : 0,
      label: m && m[2] ? m[2] : f.replace(/\.png$/, ""),
      size: stat.size,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Delete capture directories whose newest file is older than
 *  CAPTURE_TTL_MS. Called once on app boot. */
export async function pruneOldScreenshots(): Promise<void> {
  // v0.1.432 — P5: Regel statt pauschalem 7-Tage-TTL:
  //   Je (Producer × Firma) bleibt der NEUESTE Run-Ordner erhalten, bis
  //   ein neuerer Lauf existiert — der aktuellste Beweis-Screenshot einer
  //   Firma verschwindet also nie durch reines Altern. Aeltere Runs
  //   derselben Firma werden nach CAPTURE_TTL_MS geloescht; als Backstop
  //   faellt ALLES nach 30 Tagen (sonst wachsen verwaiste Firmen ewig).
  const BACKSTOP_MS = 30 * 24 * 60 * 60 * 1000;
  const root = screenshotsRoot();
  if (!existsSync(root)) return;
  const now = Date.now();
  const producers = await fs.readdir(root).catch(() => [] as string[]);
  for (const producer of producers) {
    const producerDir = join(root, producer);
    let runDirs: string[];
    try {
      runDirs = await fs.readdir(producerDir);
    } catch {
      continue;
    }

    // Runs je Firma gruppieren (runId = "<tx>:<companyId>"; Fallback:
    // ganzer Ordnername als Gruppe, z. B. link-monitor/<monitorId>).
    const groups = new Map<string, { dir: string; newest: number }[]>();
    for (const runId of runDirs) {
      const runDir = join(producerDir, runId);
      let newest = 0;
      try {
        for (const f of await fs.readdir(runDir)) {
          const m = f.match(/^(\d+)-/);
          if (m) newest = Math.max(newest, Number(m[1]));
        }
      } catch {
        continue;
      }
      const sep = runId.lastIndexOf(":");
      const companyKey = sep >= 0 ? runId.slice(sep + 1) : runId;
      const arr = groups.get(companyKey) ?? [];
      arr.push({ dir: runDir, newest });
      groups.set(companyKey, arr);
    }

    for (const runs of groups.values()) {
      runs.sort((a, b) => b.newest - a.newest);
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i]!;
        const age = r.newest > 0 ? now - r.newest : Infinity;
        const isNewestOfCompany = i === 0;
        const expired = isNewestOfCompany
          ? age > BACKSTOP_MS
          : age > CAPTURE_TTL_MS;
        if (expired) {
          await fs
            .rm(r.dir, { recursive: true, force: true })
            .catch(() => undefined);
        }
      }
    }
  }
}

/**
 * Register `ava-screenshot://` so the renderer can <img src> into
 * captures without copying bytes through IPC. Must be called BEFORE
 * `app.whenReady()` resolves (electron requires protocol registration
 * during the ready phase).
 *
 * URL format: ava-screenshot://<producer>/<runId>/<filename>
 * Resolves to the on-disk file under <userData>/screenshots/...
 *
 * Hardened: the path components are sanitized to disallow `..`
 * traversal. A malicious or buggy URL can't escape the screenshots
 * directory.
 */
export function registerScreenshotProtocol(): void {
  protocol.handle("ava-screenshot", async (request) => {
    const url = new URL(request.url);
    const segments = (url.host + url.pathname)
      .split("/")
      .map((s) => decodeURIComponent(s))
      .filter(Boolean)
      .map(sanitizeSegment);
    if (segments.length < 3) {
      return new Response("not found", { status: 404 });
    }
    const fullPath = normalize(join(screenshotsRoot(), ...segments));
    if (!fullPath.startsWith(screenshotsRoot() + sep)) {
      // Belt-and-braces: even after sanitizing each segment, refuse
      // anything that doesn't end up under the root.
      return new Response("forbidden", { status: 403 });
    }
    if (!existsSync(fullPath)) {
      return new Response("not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(fullPath).toString());
  });
}

/** Drop slashes / drive separators / dotdot to keep path resolution
 *  inside the screenshots root. Reused by listScreenshots and the
 *  protocol handler so the contract is identical. */
function sanitizeSegment(s: string): string {
  return s.replace(/[/\\]|\.\./g, "_");
}


/**
 * v0.1.431 — P3: Lokale Screenshots einer Firma entfernen (Run-Ordner
 * heissen "<tx>:<companyId>"). Best-effort, Rueckgabe = geloeschte Ordner.
 */
export async function deleteScreenshotsForCompany(
  companyId: string,
): Promise<number> {
  const root = screenshotsRoot();
  if (!existsSync(root)) return 0;
  const safe = sanitizeSegment(companyId);
  let removed = 0;
  const producers = await fs.readdir(root).catch(() => [] as string[]);
  for (const producer of producers) {
    const producerDir = join(root, producer);
    const runs = await fs.readdir(producerDir).catch(() => [] as string[]);
    for (const run of runs) {
      if (run === safe || run.endsWith(`:${safe}`) || run.endsWith(`_${safe}`)) {
        await fs
          .rm(join(producerDir, run), { recursive: true, force: true })
          .then(() => {
            removed += 1;
          })
          .catch(() => undefined);
      }
    }
  }
  return removed;
}
