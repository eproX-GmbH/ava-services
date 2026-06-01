// LinkedIn signal-strength calibration note (v0.1.345).
//
// Holds the ONE compact, size-capped note distilled from the user's
// per-signal 👍/👎 feedback (see calibration.ts). This note — never the
// raw votes — is woven into the signal-extractor prompt as additional
// strength guidance, so the scoring context stays bounded no matter how
// much feedback accumulates.
//
// Persisted as plain JSON under userData/linkedin/calibration.json. Both
// the distillation worker AND the Settings editor write here; the
// extractor reads it live. Atomic write-temp + rename, like the other
// LinkedIn stores.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";

/** Hard cap so the note can never bloat the scoring prompt. */
export const CALIBRATION_NOTE_CAP = 800;

export interface CalibrationNote {
  note: string;
  updatedAt: string | null;
}

const EMPTY: CalibrationNote = { note: "", updatedAt: null };

let cache: CalibrationNote | null = null;

function dir(): string {
  return join(app.getPath("userData"), "linkedin");
}
function filePath(): string {
  return join(dir(), "calibration.json");
}

export function readCalibration(): CalibrationNote {
  if (cache) return cache;
  try {
    if (existsSync(filePath())) {
      const parsed = JSON.parse(
        readFileSync(filePath(), "utf8"),
      ) as Partial<CalibrationNote>;
      cache = {
        note: trimToCap(parsed.note ?? ""),
        updatedAt:
          typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      };
    } else {
      cache = { ...EMPTY };
    }
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

/** Convenience for the extractor: just the (capped) note text. */
export function readCalibrationNote(): string {
  return readCalibration().note;
}

/** Write a new note (from the distillation worker OR the user editor).
 *  Capped + touches updatedAt. Empty string clears it. */
export function writeCalibration(note: string): CalibrationNote {
  const next: CalibrationNote = {
    note: trimToCap(note),
    updatedAt: new Date().toISOString(),
  };
  cache = next;
  persist(next);
  return next;
}

export function clearCalibration(): CalibrationNote {
  return writeCalibration("");
}

function persist(value: CalibrationNote): void {
  try {
    if (!existsSync(dir())) mkdirSync(dir(), { recursive: true });
    const tmp = `${filePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(tmp, filePath());
  } catch (err) {
    console.warn("[linkedin/calibration] write failed:", err);
  }
}

function trimToCap(s: string): string {
  const t = (s ?? "").trim();
  return t.length > CALIBRATION_NOTE_CAP ? t.slice(0, CALIBRATION_NOTE_CAP) : t;
}
