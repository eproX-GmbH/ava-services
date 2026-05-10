// LinkedIn-Beobachter persistent settings store (Phase L0).
//
// Holds the master switch + consent timestamp + scan/image-analysis
// preferences. Lives at userData/linkedin/settings.json. Future phases
// (L1+) will add cookies, scraped posts, signals into the same
// userData/linkedin/ directory; the kill-switch wipes the WHOLE
// directory recursively to honour the "one-click forget everything"
// contract surfaced in the Settings UI.
//
// No secrets in here yet — that lands in L1 with safeStorage. Plain
// JSON is fine for L0.

import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkedInSettings } from "../../shared/types";

export const DEFAULT_LINKEDIN_SETTINGS: LinkedInSettings = {
  enabled: false,
  consentAcceptedAt: null,
  imageAnalysis: "local",
  imageAnalysisCloudOptIn: false,
  automaticScans: false,
  scanIntervalHours: 4,
  lastScanAt: null,
  fingerprint: null,
};

function dir(): string {
  return join(app.getPath("userData"), "linkedin");
}

function file(): string {
  return join(dir(), "settings.json");
}

function ensureDir(): void {
  const d = dir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export function read(): LinkedInSettings {
  try {
    if (!existsSync(file())) return { ...DEFAULT_LINKEDIN_SETTINGS };
    const raw = readFileSync(file(), "utf8");
    const parsed = JSON.parse(raw) as Partial<LinkedInSettings>;
    return { ...DEFAULT_LINKEDIN_SETTINGS, ...parsed };
  } catch (err) {
    console.warn(
      "[linkedin] settings read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return { ...DEFAULT_LINKEDIN_SETTINGS };
  }
}

export function write(partial: Partial<LinkedInSettings>): LinkedInSettings {
  const current = read();
  const next: LinkedInSettings = { ...current, ...partial };
  ensureDir();
  writeFileSync(file(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** Kill-switch contract: wipe the whole linkedin/ subtree. In L1+
 *  this also nukes cookies, downloaded HTML, signal cache, etc. */
export function reset(): void {
  try {
    rmSync(dir(), { recursive: true, force: true });
  } catch (err) {
    console.warn(
      "[linkedin] reset failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
