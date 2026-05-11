// LinkedIn-Beobachter per-run diagnostic capture (v0.1.109).
//
// Each scrape invocation creates a timestamped subdirectory under
// `userData/linkedin/runs/<ISO8601-with-dashes>` and drops a sequence
// of PNG screenshots plus a `run.json` sidecar inside. The idea is
// debugging transparency: when the scraper reports "0 Beiträge
// gesehen", the user can open the run folder and see exactly what
// the hidden BrowserWindow was looking at.
//
// Retention is capped to the LAST 10 runs — older directories are
// pruned on each new run so the disk footprint stays bounded.
//
// Screenshot capture is best-effort: if `capturePage()` throws (e.g.
// because the window was already destroyed in a catch path) we
// swallow the error and log. Screenshot failures must NEVER break
// the scrape itself.

import { app, type BrowserWindow } from "electron";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LinkedInScanOutcome } from "../../shared/types";

/** Maximum number of run directories kept on disk. Older ones are
 *  deleted when a new run starts. */
export const MAX_RUNS_RETAINED = 10;

export interface RunMetadata {
  startedAt: string;
  finishedAt: string | null;
  outcome: LinkedInScanOutcome | "no_posts" | "running";
  postsSeen: number;
  signalsLinked: number;
  errorMessage: string | null;
  userAgent: string | null;
  url: string | null;
  /** v0.1.112 — extractor selector diagnostic. Optional; present when
   *  the scraper reached the extraction step. */
  extractionDiagnostic?: {
    candidateCounts: Record<string, number>;
    finalCount: number;
  } | null;
}

export interface RunRecorder {
  /** Absolute path to the per-run directory. */
  dir: string;
  /** ISO timestamp used as the directory name. */
  startedAt: string;
  /** Capture a screenshot named `<name>.png`. Swallows all errors. */
  capture(win: BrowserWindow | null, name: string): Promise<void>;
  /** Update metadata fields. Caller passes a partial; we merge and
   *  rewrite `run.json`. */
  updateMeta(patch: Partial<RunMetadata>): void;
  /** Final write of `run.json`. Idempotent. */
  finalize(): void;
}

function runsRoot(): string {
  return join(app.getPath("userData"), "linkedin", "runs");
}

export function getRunsRoot(): string {
  return runsRoot();
}

/** ISO 8601 with all colons replaced by dashes so the directory name
 *  is filesystem-safe on every OS. Example: 2026-05-10T14-32-07-123Z */
function tsForDir(d: Date = new Date()): string {
  return d.toISOString().replace(/:/g, "-");
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

/** Delete all but the newest `keep` run directories. */
export function pruneOldRuns(keep: number = MAX_RUNS_RETAINED): void {
  const root = runsRoot();
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const dirs = entries
    .map((name) => {
      const full = join(root, name);
      try {
        const st = statSync(full);
        if (!st.isDirectory()) return null;
        return { name, full, mtime: st.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((x): x is { name: string; full: string; mtime: number } => x !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const d of dirs.slice(keep)) {
    try {
      rmSync(d.full, { recursive: true, force: true });
    } catch (err) {
      console.warn(
        "[linkedin/runs] prune failed for",
        d.full,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

export interface ListedRun {
  dir: string;
  startedAt: string;
  meta: RunMetadata | null;
}

/** List the most recent runs, newest first. */
export function listRecentRuns(limit: number = MAX_RUNS_RETAINED): ListedRun[] {
  const root = runsRoot();
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const out: ListedRun[] = [];
  for (const name of entries) {
    const full = join(root, name);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) continue;
      let meta: RunMetadata | null = null;
      const metaPath = join(full, "run.json");
      if (existsSync(metaPath)) {
        try {
          const raw = readFileSyncSafe(metaPath);
          meta = raw ? (JSON.parse(raw) as RunMetadata) : null;
        } catch {
          meta = null;
        }
      }
      out.push({ dir: full, startedAt: name, meta });
    } catch {
      // skip
    }
  }
  out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return out.slice(0, limit);
}

function readFileSyncSafe(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Begin a new run: create the directory, prune older runs, seed
 *  `run.json` with the initial metadata. Returns a recorder the
 *  scraper uses to write screenshots and update metadata. */
export function beginRun(initial: {
  userAgent: string | null;
}): RunRecorder {
  const startedAt = tsForDir();
  const dir = join(runsRoot(), startedAt);
  ensureDir(dir);
  // Prune AFTER creating the new dir so we always keep this one.
  try {
    pruneOldRuns(MAX_RUNS_RETAINED);
  } catch (err) {
    console.warn(
      "[linkedin/runs] prune at beginRun failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const meta: RunMetadata = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "running",
    postsSeen: 0,
    signalsLinked: 0,
    errorMessage: null,
    userAgent: initial.userAgent,
    url: null,
  };

  const writeMeta = (): void => {
    try {
      writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 2));
    } catch (err) {
      console.warn(
        "[linkedin/runs] run.json write failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  writeMeta();

  const capture = async (
    win: BrowserWindow | null,
    name: string,
  ): Promise<void> => {
    if (!win) return;
    try {
      if (win.isDestroyed?.()) return;
      const img = await win.webContents.capturePage();
      if (!img) return;
      const buf = img.toPNG();
      if (!buf || buf.length === 0) return;
      writeFileSync(join(dir, `${name}.png`), buf);
    } catch (err) {
      console.warn(
        `[linkedin/runs] capture ${name} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  const updateMeta = (patch: Partial<RunMetadata>): void => {
    Object.assign(meta, patch);
    writeMeta();
  };

  const finalize = (): void => {
    if (!meta.finishedAt) {
      meta.finishedAt = new Date().toISOString();
    }
    writeMeta();
  };

  return { dir, startedAt, capture, updateMeta, finalize };
}
