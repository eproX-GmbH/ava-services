// S1 — Public surface of the skills module.
//
// `initSkills(app)` discovers + loads skills from:
//   - userData/skills/<name>/SKILL.md
//   - <cwd>/.ava/skills/<name>/SKILL.md (workspace; only if dir exists)
// It then starts a debounced fs.watch loop so edits hot-reload.
//
// IPC + window.api surface is intentionally deferred — that ships
// with S3 (Settings → Skills UI).

import type { App } from "electron";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SkillStore } from "./store";
import type { GateEvaluator } from "./gate";
import type { TrustEvaluator } from "./loader";
import { parseSkillFile } from "./parser";
import { SkillsTrustStore } from "./trust-store";

export { SkillStore } from "./store";
export type { LoadedSkill, SkillScope } from "./loader";
export type {
  B2bScope,
  SkillLanguage,
  SkillArgument,
  SkillMetadata,
} from "./schema";
export { buildGateEvaluator, denyAllGates } from "./gate";
export type { GateEvaluator, GateDeps, GateResult } from "./gate";
export { SkillsPrefsStore } from "./skills-prefs-store";
export type { SkillsPrefs } from "./skills-prefs-store";
export { SkillsTrustStore } from "./trust-store";
export type { TrustEntry, TrustState } from "./trust-store";
export { buildSkillFile, saveSkillToDisk } from "./save";
export type { SkillSavePayload, BuildResult, SaveResult } from "./save";
export {
  exportSkillToZipFile,
  exportAllSkillsToZipFile,
  stageImportZip,
  stageImportMarkdown,
  commitImport,
  discardImportStaging,
} from "./import-export";
export type {
  ImportStagingDeps,
  ExportAllManifestEntry,
} from "./import-export";
export {
  parseSlashInvocation,
  renderSkillBody,
  checkSkillAllowlist,
  autoActivateSkill,
} from "./allowlist";
export type { SlashInvocation, AllowlistCheck } from "./allowlist";

export interface InitSkillsOptions {
  /** Override userData path — used by the test script with fixtures. */
  userDir?: string | null;
  /** Override workspace dir — used by the test script with fixtures. */
  workspaceDir?: string | null;
  /** Skip starting fs.watch (test script). */
  watch?: boolean;
  /** S2 — gate evaluator (CRM connected? Ollama running?). When omitted,
   *  the loader denies every `metadata.ava.requires` block (S1 behaviour). */
  evaluateGate?: GateEvaluator;
  /** S6 — override the bundled-skills source directory. Used by tests
   *  to point at `resources/skills/` directly. In normal init this is
   *  derived from `app.isPackaged` and skipped if `app` is null. */
  bundledDir?: string | null;
  /** S4 — pre-built trust store (so the orchestrator + IPC layer
   *  share the same instance). When omitted, `initSkills` creates a
   *  fresh `SkillsTrustStore`. Test scripts pass an in-temp-dir
   *  instance. */
  trustStore?: SkillsTrustStore | null;
}

/**
 * S6 — Copy bundled `SKILL.md` files from the desktop's `resources/skills/`
 * tree into `<userData>/skills/<name>/SKILL.md`, but only if the target
 * file does not yet exist. Never overwrites — the user can edit or
 * delete a bundled skill and we must not clobber their changes on
 * upgrade. Errors are logged in German and otherwise swallowed so a
 * single bad copy can't break startup.
 */
export function vendorBundledSkills(
  bundledDir: string,
  userDir: string,
  trustStore?: SkillsTrustStore | null,
): void {
  if (!existsSync(bundledDir)) {
    console.log(
      `[skills] kein gebündeltes Skill-Verzeichnis unter ${bundledDir} — übersprungen`,
    );
    return;
  }
  let entries: string[];
  try {
    entries = readdirSync(bundledDir);
  } catch (err) {
    console.warn(
      `[skills] gebündeltes Skill-Verzeichnis nicht lesbar: ${bundledDir} (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return;
  }
  for (const entry of entries) {
    const src = join(bundledDir, entry, "SKILL.md");
    let st;
    try {
      st = statSync(join(bundledDir, entry));
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!existsSync(src)) continue;
    const targetDir = join(userDir, entry);
    const target = join(targetDir, "SKILL.md");
    // v0.1.281 — Sidecar-File `.vendored-hash` mit dem Content-Hash der
    // ZULETZT vendored-Version. Auf nachfolgenden Boots erlaubt es uns
    // zu unterscheiden:
    //   - User hat das File nicht angefasst (current-hash == sidecar-hash)
    //     → wir DÜRFEN mit der neuen Built-in-Version überschreiben.
    //   - User hat editiert (current-hash != sidecar-hash)
    //     → respektieren, NICHT überschreiben.
    // Vorher (v0.1.280 und älter) wurde NIE überschrieben, sobald das
    // Target einmal existierte — damit klebten Built-in-Skill-Updates
    // hartnäckig im userData und neue Releases haben den Effekt nicht
    // bekommen (Bug-Report v0.1.279: HubSpot-Create-Tool angeblich
    // nicht im Skill, obwohl Build seit v0.1.269 dabei war).
    const sidecar = join(targetDir, ".vendored-hash");
    const bundledRaw = (() => {
      try {
        return readFileSync(src, "utf8");
      } catch {
        return null;
      }
    })();
    if (bundledRaw == null) continue;
    const bundledHash = createHash("sha256")
      .update(bundledRaw, "utf8")
      .digest("hex");

    let shouldWrite = false;
    if (!existsSync(target)) {
      shouldWrite = true;
    } else {
      try {
        const currentRaw = readFileSync(target, "utf8");
        const currentHash = createHash("sha256")
          .update(currentRaw, "utf8")
          .digest("hex");
        if (currentHash === bundledHash) {
          // Bereits identisch — kein Write, aber Sidecar synchron halten
          if (!existsSync(sidecar)) {
            try {
              writeFileSync(sidecar, bundledHash, { mode: 0o644 });
            } catch {
              /* Sidecar ist optional */
            }
          }
          continue;
        }
        const sidecarHash = existsSync(sidecar)
          ? readFileSync(sidecar, "utf8").trim()
          : null;
        if (sidecarHash != null && sidecarHash === currentHash) {
          // User hat NICHT editiert (current matched last-vendored).
          // → Safe overwrite mit neuer Built-in-Version.
          shouldWrite = true;
        } else if (sidecarHash == null) {
          // Legacy: vor v0.1.281 vendorisiert, kein Sidecar. Wir
          // KÖNNEN nicht sicher unterscheiden ob User editiert hat —
          // pragmatischer Kompromiss: aktuelle Datei als
          // .legacy-backup-<timestamp> sichern, dann mit neuer
          // Built-in-Version überschreiben. Future-Runs nutzen
          // sidecar-Logik und werden user-edit-respektierend.
          try {
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const backup = join(targetDir, `SKILL.md.legacy-backup-${ts}`);
            copyFileSync(target, backup);
            console.log(
              `[skills] legacy skill '${entry}' gesichert nach ${backup}, wird mit Built-in-Version aktualisiert`,
            );
          } catch (err) {
            console.warn(
              `[skills] legacy-backup für '${entry}' fehlgeschlagen, force-update trotzdem: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          shouldWrite = true;
        } else {
          // current != sidecar → User hat editiert. Respektieren.
          shouldWrite = false;
        }
      } catch {
        shouldWrite = false;
      }
    }

    if (!shouldWrite) continue;

    try {
      mkdirSync(targetDir, { recursive: true });
      copyFileSync(src, target);
      try {
        writeFileSync(sidecar, bundledHash, { mode: 0o644 });
      } catch {
        /* Sidecar-Write nicht kritisch; nächster Lauf macht's evtl. */
      }
      console.log(`[skills] vendored bundled skill '${entry}' → ${target}`);
      // S4 — auto-trust the vendored copy by its initial content
      // hash. The user implicitly trusts whatever ships with the
      // app; on the next launch the trust store has the entry and
      // the loader marks the skill `"trusted"` straight away.
      if (trustStore) {
        try {
          let allowedTools: string[] = [];
          try {
            const parsed = parseSkillFile(bundledRaw);
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
            // best-effort; trust the file even if allowedTools couldn't
            // be parsed (the loader will surface the schema error on
            // next reload).
          }
          trustStore.trust(entry, bundledHash, allowedTools);
        } catch (err) {
          console.warn(
            `[skills] Auto-Trust für '${entry}' fehlgeschlagen: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } catch (err) {
      console.warn(
        `[skills] Vendor-Kopie fehlgeschlagen für '${entry}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

export async function initSkills(
  app: App | null,
  opts: InitSkillsOptions = {},
): Promise<SkillStore> {
  let userDir: string | null;
  if (opts.userDir !== undefined) {
    userDir = opts.userDir;
  } else if (app) {
    userDir = join(app.getPath("userData"), "skills");
    try {
      mkdirSync(userDir, { recursive: true });
    } catch {
      // best-effort: if we can't create it, loadSkills() will just see
      // an empty list. We don't fail init for that.
    }
  } else {
    userDir = null;
  }

  // S6 — Vendor the bundled starter skills into userDir BEFORE the
  // loader scans the dir. The copy is no-overwrite (per-file
  // existence check) so user edits survive upgrades. Skipped if the
  // caller passed an explicit userDir override (tests) unless they
  // also passed an explicit bundledDir.
  let bundledDir: string | null = null;
  if (opts.bundledDir !== undefined) {
    bundledDir = opts.bundledDir;
  } else if (app && opts.userDir === undefined) {
    bundledDir = app.isPackaged
      ? join(process.resourcesPath, "skills")
      : join(app.getAppPath(), "resources", "skills");
  }
  // S4 — trust store needs to exist before vendoring so the
  // bundled-starter auto-trust hook can write entries during the
  // copy. Callers can pass their own (so the IPC layer shares the
  // instance with the renderer); we fall back to a default-path one
  // (which requires `app` to be present for `userData` resolution).
  // Test scripts that pass `app: null` AND don't supply a trustStore
  // get a tmp-path one rooted in userDir so the loader still has
  // something to consult.
  let trustStore: SkillsTrustStore | null;
  if (opts.trustStore !== undefined) {
    trustStore = opts.trustStore;
  } else if (app) {
    trustStore = new SkillsTrustStore();
  } else {
    // Test runs without `app` AND without an explicit trustStore
    // fall back to a no-op evaluator (everything trusted). Matches
    // pre-S4 behaviour of the S1/S2/S3 loader/agent/bundled tests.
    trustStore = null;
  }

  if (bundledDir && userDir) {
    try {
      mkdirSync(userDir, { recursive: true });
      vendorBundledSkills(bundledDir, userDir, trustStore);
    } catch (err) {
      console.warn(
        `[skills] Vendor-Schritt fehlgeschlagen: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let workspaceDir: string | null;
  if (opts.workspaceDir !== undefined) {
    workspaceDir = opts.workspaceDir;
  } else {
    const candidate = join(process.cwd(), ".ava", "skills");
    workspaceDir = existsSync(candidate) ? candidate : null;
  }

  // S4 — trust evaluator. Looks up the in-memory trust store for
  // each (name, hash). First-seen → "untrusted"; entry exists with
  // matching hash → "trusted"; entry exists with mismatched hash →
  // "modified", and we carry the previously-approved allowed-tools
  // so the dialog can show a diff.
  const evaluateTrust: TrustEvaluator = (name, hash) => {
    if (!trustStore) {
      // No trust store configured (caller ran with `app: null` and
      // no `trustStore` override) → fall back to "everything is
      // trusted", matching S1/S2/S3 behaviour for tests that pre-date
      // S4.
      return { trust: "trusted", previouslyTrustedAllowedTools: [] };
    }
    const entry = trustStore.getEntry(name);
    if (!entry) {
      return { trust: "untrusted", previouslyTrustedAllowedTools: [] };
    }
    if (entry.hash === hash) {
      return { trust: "trusted", previouslyTrustedAllowedTools: [] };
    }
    return {
      trust: "modified",
      previouslyTrustedAllowedTools: entry.allowedTools ?? [],
    };
  };

  const store = new SkillStore(
    userDir,
    workspaceDir,
    opts.evaluateGate,
    evaluateTrust,
  );
  await store.reload();

  const userCount = store.list().filter((s) => s.scope === "user").length;
  const workspaceCount = store
    .list()
    .filter((s) => s.scope === "workspace").length;
  console.log(
    `[skills] loaded ${store.list().length} skills (${userCount} user, ${workspaceCount} workspace)`,
  );

  if (opts.watch !== false) store.startWatching();
  return store;
}
