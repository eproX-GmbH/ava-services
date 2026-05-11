// S5 — Skill import / export.
//
// Two halves:
//
//   - Export: serialise an in-memory `LoadedSkill` (or all user-scope
//     skills) into a zip via `adm-zip`. The single-skill form contains
//     just `SKILL.md`; the bulk form contains `<name>/SKILL.md` per
//     skill plus a top-level `MANIFEST.json` for forensic clarity.
//
//   - Import: stage a zip or a raw SKILL.md body into a temp dir
//     (NEVER touching `<userData>/skills/` yet), parse + validate each
//     entry through the same loader pipeline, and return a
//     `SkillImportResult` describing what a subsequent commit would
//     do. The commit step copies validated bytes into place and
//     optionally auto-trusts.
//
// Staging is deliberately ephemeral — the temp dir is wiped after the
// commit (or when the renderer dismisses the dialog). We do NOT persist
// staging state across app restarts; if the user closes AVA mid-import
// they have to re-import.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import AdmZip from "adm-zip";
import { parseSkillFile, SkillParseError } from "./parser";
import { frontmatterSchema } from "./schema";
import type { SkillsTrustStore } from "./trust-store";
import type { LoadedSkill } from "./loader";
import type {
  SkillImportAction,
  SkillImportCommit,
  SkillImportCommitResult,
  SkillImportConflict,
  SkillImportResult,
  SkillImportStagedEntry,
} from "../../shared/types";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------- Export ----------------------------------------------------

/**
 * Single-skill export. Caller resolves the destination path via
 * Electron's `dialog.showSaveDialog` and passes it in; we only build
 * the zip bytes here so the function stays testable without Electron.
 */
export function exportSkillToZipFile(
  skill: LoadedSkill,
  destPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const raw = readFileSync(skill.sourcePath, "utf8");
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from(raw, "utf8"));
    zip.writeZip(destPath);
    return { ok: true, path: destPath };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface ExportAllManifestEntry {
  name: string;
  b2bScope: string;
  hash: string;
  exportedAt: string;
}

/**
 * Multi-skill export. Bundles every user-scope skill in `skills` into
 * a single zip with the layout `<name>/SKILL.md` + a top-level
 * `MANIFEST.json`. Workspace-scope skills are intentionally NOT
 * included — those live in a repo and have their own source of truth.
 */
export function exportAllSkillsToZipFile(
  skills: LoadedSkill[],
  destPath: string,
): { ok: true; path: string; count: number } | { ok: false; error: string } {
  try {
    const userScope = skills.filter((s) => s.scope === "user");
    const zip = new AdmZip();
    const manifest: ExportAllManifestEntry[] = [];
    const exportedAt = new Date().toISOString();
    for (const s of userScope) {
      const raw = readFileSync(s.sourcePath, "utf8");
      zip.addFile(`${s.name}/SKILL.md`, Buffer.from(raw, "utf8"));
      manifest.push({
        name: s.name,
        b2bScope: s.b2bScope,
        hash: s.hash,
        exportedAt,
      });
    }
    zip.addFile(
      "MANIFEST.json",
      Buffer.from(JSON.stringify({ exportedAt, skills: manifest }, null, 2), "utf8"),
    );
    zip.writeZip(destPath);
    return { ok: true, path: destPath, count: userScope.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------- Import staging --------------------------------------------

export interface ImportStagingDeps {
  /** Where the `<userData>/skills/` tree lives — used by the commit
   *  step to figure out the on-disk hash that already exists for each
   *  staged name (to decide create vs. overwrite-*). */
  userSkillsDir: string;
  /** Trust store — used (a) at staging time to look up the
   *  previously-trusted allowed-tools, and (b) at commit time to
   *  revoke / re-grant trust per entry. */
  trustStore: SkillsTrustStore;
  /** Override for the temp-dir parent (tests). Defaults to OS tmpdir. */
  stagingRoot?: string;
}

/** Per-process registry of active staging dirs. The renderer's
 *  `commitImport` and `cancelImport` resolve their `stagingId` back
 *  through here. Ephemeral by design (PLAN §S5: no cross-restart
 *  persistence). */
const stagingDirs = new Map<string, string>();

function newStagingId(): string {
  return `s5-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

interface StagedFile {
  /** Logical name we'll write to disk as `<userData>/skills/<name>/SKILL.md`.
   *  Equal to `validated.name` from the frontmatter (NOT the zip path —
   *  a user might rename the directory). */
  name: string;
  /** Path of the temp file holding the raw SKILL.md bytes. */
  tempPath: string;
  /** Parsed entry for the renderer-facing payload. */
  entry: SkillImportStagedEntry;
}

async function stageOneSkillMd(
  raw: string,
  deps: ImportStagingDeps,
  stagingDir: string,
  conflicts: SkillImportConflict[],
  staged: StagedFile[],
): Promise<void> {
  let parsed;
  try {
    parsed = parseSkillFile(raw);
  } catch (err) {
    conflicts.push({
      name: "",
      reason:
        err instanceof SkillParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err),
    });
    return;
  }
  let validated;
  try {
    validated = await frontmatterSchema.validate(parsed.frontmatter, {
      abortEarly: true,
      stripUnknown: false,
    });
  } catch (err) {
    const guessName =
      parsed.frontmatter &&
      typeof parsed.frontmatter === "object" &&
      "name" in parsed.frontmatter
        ? String(
            (parsed.frontmatter as Record<string, unknown>).name ?? "",
          )
        : "";
    conflicts.push({
      name: guessName,
      reason: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const name = validated.name;
  // Detect duplicates within the same zip (two skills with the same
  // `name` frontmatter). Reject the second one.
  if (staged.some((s) => s.name === name)) {
    conflicts.push({
      name,
      reason: `Doppelter Skill-Name im Paket: '${name}' kommt mehrfach vor.`,
    });
    return;
  }

  const hash = sha256(raw);
  const onDiskPath = join(deps.userSkillsDir, name, "SKILL.md");
  let action: SkillImportAction = "create";
  if (existsSync(onDiskPath)) {
    try {
      const existing = readFileSync(onDiskPath, "utf8");
      const existingHash = sha256(existing);
      const entry = deps.trustStore.getEntry(name);
      if (!entry) {
        action = "overwrite-untrusted";
      } else if (entry.hash === existingHash) {
        action = "overwrite-trusted";
      } else {
        action = "overwrite-modified";
      }
    } catch {
      action = "overwrite-untrusted";
    }
  }

  // Write the raw bytes into the staging dir under the skill's
  // canonical name so the commit step can do a flat copy without
  // re-serialising.
  const targetDir = join(stagingDir, name);
  mkdirSync(targetDir, { recursive: true });
  const tempPath = join(targetDir, "SKILL.md");
  writeFileSync(tempPath, raw, "utf8");

  const trustEntry = deps.trustStore.getEntry(name);
  const previousAllowedTools = trustEntry?.allowedTools
    ? trustEntry.allowedTools.slice()
    : undefined;

  const allowedTools = (validated["allowed-tools"] ?? []).slice();
  const bodyLines = parsed.body ? parsed.body.split(/\r?\n/).length : 0;

  staged.push({
    name,
    tempPath,
    entry: {
      name,
      description: validated.description,
      language: validated.language,
      b2bScope: validated["b2b-scope"],
      allowedTools,
      requiresUserConfirm: validated["requires-user-confirm"],
      disableModelInvocation: validated["disable-model-invocation"],
      userInvocable: validated["user-invocable"],
      body: parsed.body,
      bodyLength: parsed.body.length,
      bodyLines,
      hash,
      action,
      previousAllowedTools,
    },
  });
}

/**
 * Stage a zip file. Walks the archive looking for either a root-level
 * `SKILL.md` (a single-skill export) or `<name>/SKILL.md` entries (a
 * bulk export). Anything else is ignored silently — common noise from
 * macOS Finder zips (`__MACOSX/`, `.DS_Store`) doesn't surface as a
 * conflict.
 */
export async function stageImportZip(
  localPath: string,
  deps: ImportStagingDeps,
): Promise<SkillImportResult> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(localPath);
  } catch (err) {
    return {
      ok: false,
      error: `Zip-Datei konnte nicht gelesen werden: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const stagingRoot = deps.stagingRoot ?? tmpdir();
  if (!existsSync(stagingRoot)) {
    mkdirSync(stagingRoot, { recursive: true });
  }
  const stagingDir = mkdtempSync(join(stagingRoot, "ava-skill-import-"));
  const stagingId = newStagingId();
  stagingDirs.set(stagingId, stagingDir);

  const conflicts: SkillImportConflict[] = [];
  const staged: StagedFile[] = [];

  // Collect candidate `SKILL.md` entries. We accept depth-0 (single)
  // and depth-1 (`<name>/SKILL.md`). Anything deeper is ignored.
  const candidates: Array<{ raw: string }> = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const path = entry.entryName.replace(/\\/g, "/");
    if (path.startsWith("__MACOSX/") || path.endsWith(".DS_Store")) continue;
    const parts = path.split("/").filter((p) => p.length > 0);
    const isRootSkill = parts.length === 1 && parts[0] === "SKILL.md";
    const isOneLevelSkill = parts.length === 2 && parts[1] === "SKILL.md";
    if (!isRootSkill && !isOneLevelSkill) continue;
    try {
      candidates.push({ raw: entry.getData().toString("utf8") });
    } catch (err) {
      conflicts.push({
        name: path,
        reason: `Eintrag '${path}' konnte nicht entpackt werden: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (candidates.length === 0 && conflicts.length === 0) {
    // Nothing usable in the archive — wipe the staging dir + bail.
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    stagingDirs.delete(stagingId);
    return {
      ok: false,
      error:
        "Zip enthält keine SKILL.md (weder im Wurzelverzeichnis noch eine Ebene tief).",
    };
  }

  for (const c of candidates) {
    await stageOneSkillMd(c.raw, deps, stagingDir, conflicts, staged);
  }

  return {
    ok: true,
    stagingId,
    staged: staged.map((s) => s.entry),
    conflicts,
  };
}

/**
 * Stage a single SKILL.md body pasted by the user. Same return shape
 * as `stageImportZip` so the renderer can route them through one
 * dialog.
 */
export async function stageImportMarkdown(
  body: string,
  deps: ImportStagingDeps,
): Promise<SkillImportResult> {
  if (typeof body !== "string" || body.trim().length === 0) {
    return { ok: false, error: "SKILL.md-Body ist leer." };
  }
  const stagingRoot = deps.stagingRoot ?? tmpdir();
  if (!existsSync(stagingRoot)) {
    mkdirSync(stagingRoot, { recursive: true });
  }
  const stagingDir = mkdtempSync(join(stagingRoot, "ava-skill-import-"));
  const stagingId = newStagingId();
  stagingDirs.set(stagingId, stagingDir);

  const conflicts: SkillImportConflict[] = [];
  const staged: StagedFile[] = [];
  await stageOneSkillMd(body, deps, stagingDir, conflicts, staged);

  if (staged.length === 0 && conflicts.length > 0) {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    stagingDirs.delete(stagingId);
  }

  return {
    ok: true,
    stagingId,
    staged: staged.map((s) => s.entry),
    conflicts,
  };
}

// ---------------- Commit ----------------------------------------------------

/**
 * Apply a previously-staged import. For each entry the renderer
 * opted to keep:
 *   1. Copy `<stagingDir>/<name>/SKILL.md` → `<userSkillsDir>/<name>/SKILL.md`.
 *   2. If `trust === "auto"`, hash the on-disk file and write a fresh
 *      trust-store entry with the new allowed-tools.
 *   3. If `trust === "deferred"`, REVOKE any existing trust entry —
 *      the skill needs to be re-confirmed (PLAN §S5 re-confirm-on-change).
 *
 * Path-traversal defence: each `name` is resolved against `userSkillsDir`
 * and rejected if it escapes. Same guard as the S4 delete handler.
 */
export function commitImport(
  payload: SkillImportCommit,
  deps: ImportStagingDeps,
): SkillImportCommitResult {
  const stagingDir = stagingDirs.get(payload.stagingId);
  if (!stagingDir || !existsSync(stagingDir)) {
    return {
      ok: false,
      error:
        "Staging-Verzeichnis nicht gefunden. Bitte den Import-Vorgang neu starten.",
    };
  }
  if (!Array.isArray(payload.staged)) {
    return { ok: false, error: "Commit-Payload ohne 'staged'-Liste." };
  }

  const written: string[] = [];
  const userRoot = resolve(deps.userSkillsDir);
  try {
    for (const entry of payload.staged) {
      if (!entry || typeof entry.name !== "string") continue;
      const src = join(stagingDir, entry.name, "SKILL.md");
      if (!existsSync(src)) {
        return {
          ok: false,
          error: `Staging-Datei für '${entry.name}' fehlt. Bitte erneut importieren.`,
        };
      }
      const targetDir = join(deps.userSkillsDir, entry.name);
      const resolvedTarget = resolve(targetDir);
      if (
        resolvedTarget !== userRoot &&
        !resolvedTarget.startsWith(userRoot + sep)
      ) {
        return {
          ok: false,
          error: `Ungültiger Skill-Name '${entry.name}' (Pfad-Traversal abgewiesen).`,
        };
      }
      mkdirSync(targetDir, { recursive: true });
      const targetFile = join(targetDir, "SKILL.md");
      copyFileSync(src, targetFile);

      const raw = readFileSync(targetFile, "utf8");
      const hash = sha256(raw);
      if (entry.trust === "auto") {
        // Re-parse to pull the canonical allowed-tools out of the
        // file we just wrote. This way the trust-store entry reflects
        // the exact bytes on disk, not whatever the renderer thought
        // was in the staging payload.
        let allowedTools: string[] = [];
        try {
          const parsed = parseSkillFile(raw);
          if (parsed.frontmatter && typeof parsed.frontmatter === "object") {
            const fm = parsed.frontmatter as Record<string, unknown>;
            const list = fm["allowed-tools"];
            if (Array.isArray(list)) {
              allowedTools = list.filter(
                (t): t is string => typeof t === "string",
              );
            }
          }
        } catch {
          // best-effort
        }
        deps.trustStore.trust(entry.name, hash, allowedTools);
      } else {
        // Deferred trust → revoke any prior entry so the skill shows
        // up as "untrusted" / "modified" until the user explicitly
        // confirms it. This is the loophole-closer mentioned in the
        // S5 spec: a teammate's v2 must re-prompt even if v1 was
        // trusted.
        deps.trustStore.revoke(entry.name);
      }
      written.push(targetFile);
    }
  } catch (err) {
    return {
      ok: false,
      error: `Import-Commit fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // Wipe the staging dir regardless of success — partial commits
    // leave already-written files in place, but the temp dir is
    // ephemeral by design.
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {}
    stagingDirs.delete(payload.stagingId);
  }

  return { ok: true, written };
}

/**
 * Drop a staging dir without committing (renderer dismissed the
 * dialog). No-op if the id is unknown.
 */
export function discardImportStaging(stagingId: string): void {
  const dir = stagingDirs.get(stagingId);
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
  stagingDirs.delete(stagingId);
}

// ---------------- Test-only helpers -----------------------------------------

/** Test-only: inspect the active staging registry. */
export function _peekStagingDirs(): Record<string, string> {
  return Object.fromEntries(stagingDirs.entries());
}

/** Test-only: re-list candidate SKILL.md files in a staging dir
 *  without committing. Used by the round-trip test to assert the temp
 *  state matches the staged payload. */
export function _listStagedSkillFiles(stagingId: string): string[] {
  const dir = stagingDirs.get(stagingId);
  if (!dir || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const sub = join(dir, entry);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const f = join(sub, "SKILL.md");
    if (existsSync(f)) out.push(f);
  }
  return out;
}
