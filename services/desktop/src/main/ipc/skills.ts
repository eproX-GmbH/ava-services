// IPC-Handler „Skills“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { app, dialog, ipcMain, shell } from "electron";
import { createHash } from "node:crypto";
import { existsSync as existsSyncFs, readFileSync, rmSync } from "node:fs";
import * as nodePath from "node:path";
import type { ToolRegistry } from "../agent/tool-registry";
import type { LoadedSkill, SkillStore } from "../skills";
import { commitImport, discardImportStaging, exportAllSkillsToZipFile, exportSkillToZipFile, saveSkillToDisk, stageImportMarkdown, stageImportZip } from "../skills";
import { join } from "node:path";
import type { SkillBody, SkillDeleteResult, SkillExportAllResult, SkillExportResult, SkillImportCommit, SkillImportCommitResult, SkillImportResult, SkillRow, SkillSavePayload, SkillSaveResult } from "../../shared/types";
import type { SkillsPrefsStore, SkillsTrustStore } from "../skills";
import type { BrowserWindow } from "electron";

export interface SkillsIpcDeps {
  agentRegistry: ToolRegistry;
  focusedWindow: () => BrowserWindow | null;
  skillsPrefs: SkillsPrefsStore;
  skillStore: SkillStore | null;
  skillsTrust: SkillsTrustStore;
  toSkillRow: (s: LoadedSkill) => SkillRow;
}

export function registerSkillsIpc(deps: SkillsIpcDeps): void {
  const { agentRegistry, focusedWindow, skillsPrefs, skillStore, skillsTrust, toSkillRow } = deps;

  // ---- Skills IPC (S3) ----------------------------------------------------
  ipcMain.handle("skills:list", (): SkillRow[] => {
    const all = skillStore?.list() ?? [];
    const rows = all.map(toSkillRow);
    rows.sort((a, b) => a.name.localeCompare(b.name, "de"));
    return rows;
  });

  ipcMain.handle(
    "skills:getBody",
    (_e, name: string): SkillBody | null => {
      const s = skillStore?.get(name);
      if (!s) return null;
      return { body: s.body, sourcePath: s.sourcePath, hash: s.hash };
    },
  );

  ipcMain.handle(
    "skills:setEnabled",
    (_e, args: { name: string; enabled: boolean }): void => {
      if (!args || typeof args.name !== "string") {
        throw new Error("skills:setEnabled erwartet { name, enabled }");
      }
      skillsPrefs.setEnabled(args.name, args.enabled !== false);
    },
  );

  ipcMain.handle("skills:reload", async (): Promise<void> => {
    if (!skillStore) return;
    await skillStore.reload();
  });

  ipcMain.handle(
    "skills:openSourceDir",
    async (
      _e,
      target?: string,
    ): Promise<{ ok: true } | { error: string }> => {
      // No argument → user-scope skills directory.
      const path =
        typeof target === "string" && target.length > 0
          ? target
          : join(app.getPath("userData"), "skills");
      try {
        const err = await shell.openPath(path);
        if (err) return { error: err };
        return { ok: true };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "skills:save",
    async (_e, payload: SkillSavePayload): Promise<SkillSaveResult> => {
      if (!payload || typeof payload !== "object") {
        return { ok: false, error: "skills:save erwartet ein Payload-Objekt" };
      }
      const userDir = join(app.getPath("userData"), "skills");
      try {
        const res = await saveSkillToDisk(userDir, payload);
        if (!res.ok || !res.name || !res.path) {
          return { ok: false, error: res.error ?? "Unbekannter Fehler" };
        }
        // Auto-trust the freshly authored content: the user just wrote
        // it, so by definition they trust it. We hash the on-disk file
        // (not the payload) so the value matches what the loader sees
        // on the next scan.
        try {
          const written = readFileSync(res.path, "utf8");
          const hash = createHash("sha256").update(written, "utf8").digest("hex");
          skillsTrust.trust(
            res.name,
            hash,
            payload.frontmatter["allowed-tools"] ?? [],
          );
        } catch (err) {
          console.warn(
            `[skills] Auto-Trust nach Save fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (skillStore) {
          await skillStore.reload();
        }
        return { ok: true, name: res.name };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:delete",
    async (_e, name: string): Promise<SkillDeleteResult> => {
      if (typeof name !== "string" || !name) {
        return { ok: false, error: "skills:delete erwartet einen Namen" };
      }
      // Refuse to touch workspace-scope skills — those live in the
      // user's project repo and we don't want to silently delete
      // committed files.
      const target = skillStore?.get(name);
      if (target && target.scope === "workspace") {
        return {
          ok: false,
          error:
            "Workspace-Skills werden im Projekt-Repo verwaltet und können hier nicht gelöscht werden.",
        };
      }
      const userDir = join(app.getPath("userData"), "skills");
      const skillDir = join(userDir, name);
      try {
        // Bounds check: refuse anything that resolves outside userDir
        // (defence against path-traversal via crafted names).
        const resolved = nodePath.resolve(skillDir);
        const root = nodePath.resolve(userDir);
        if (!resolved.startsWith(root + nodePath.sep)) {
          return {
            ok: false,
            error: "Ungültiger Skill-Name (Pfad-Traversal abgewiesen).",
          };
        }
        if (!existsSyncFs(skillDir)) {
          // Already gone — clear trust state anyway.
          skillsTrust.revoke(name);
          if (skillStore) await skillStore.reload();
          return { ok: true };
        }
        rmSync(skillDir, { recursive: true, force: true });
        skillsTrust.revoke(name);
        if (skillStore) await skillStore.reload();
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("skills:trust", async (_e, name: string): Promise<void> => {
    if (typeof name !== "string" || !name) {
      throw new Error("skills:trust erwartet einen Namen");
    }
    const target = skillStore?.get(name);
    if (!target) return;
    skillsTrust.trust(name, target.hash, target.allowedTools);
    // changed-listener above re-reloads the store so the row's
    // `trust` field flips to "trusted" without a manual refresh.
  });

  ipcMain.handle(
    "skills:listAvailableTools",
    (): { name: string; description: string }[] => {
      return agentRegistry
        .list()
        .map((t) => ({ name: t.name, description: t.description }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  );

  ipcMain.handle(
    "skills:export",
    async (_e, name: string): Promise<SkillExportResult> => {
      if (typeof name !== "string" || !name) {
        return { ok: false, error: "skills:export erwartet einen Namen" };
      }
      const target = skillStore?.get(name);
      if (!target) {
        return { ok: false, error: `Skill '${name}' nicht gefunden.` };
      }
      const parent = focusedWindow();
      const res = await dialog.showSaveDialog(parent ?? undefined as never, {
        title: "Skill exportieren",
        defaultPath: `${name}.zip`,
        filters: [{ name: "Skill-Paket", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePath) {
        return { ok: false, cancelled: true };
      }
      return exportSkillToZipFile(target, res.filePath);
    },
  );

  ipcMain.handle(
    "skills:exportAll",
    async (): Promise<SkillExportAllResult> => {
      const all = skillStore?.list() ?? [];
      const today = new Date().toISOString().slice(0, 10);
      const parent = focusedWindow();
      const res = await dialog.showSaveDialog(parent ?? undefined as never, {
        title: "Alle Skills exportieren",
        defaultPath: `ava-skills-${today}.zip`,
        filters: [{ name: "Skill-Paket", extensions: ["zip"] }],
      });
      if (res.canceled || !res.filePath) {
        return { ok: false, cancelled: true };
      }
      return exportAllSkillsToZipFile(all, res.filePath);
    },
  );

  ipcMain.handle(
    "skills:importZip",
    async (_e, localPath: string): Promise<SkillImportResult> => {
      if (typeof localPath !== "string" || !localPath) {
        return { ok: false, error: "skills:importZip erwartet einen Dateipfad" };
      }
      try {
        return await stageImportZip(localPath, {
          userSkillsDir: join(app.getPath("userData"), "skills"),
          trustStore: skillsTrust,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:importMarkdown",
    async (_e, body: string): Promise<SkillImportResult> => {
      if (typeof body !== "string") {
        return {
          ok: false,
          error: "skills:importMarkdown erwartet einen Body-String",
        };
      }
      try {
        return await stageImportMarkdown(body, {
          userSkillsDir: join(app.getPath("userData"), "skills"),
          trustStore: skillsTrust,
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "skills:commitImport",
    async (
      _e,
      payload: SkillImportCommit,
    ): Promise<SkillImportCommitResult> => {
      if (!payload || typeof payload !== "object") {
        return {
          ok: false,
          error: "skills:commitImport erwartet ein Payload-Objekt",
        };
      }
      const res = commitImport(payload, {
        userSkillsDir: join(app.getPath("userData"), "skills"),
        trustStore: skillsTrust,
      });
      if (skillStore && res.ok) {
        await skillStore.reload().catch(() => {});
      }
      return res;
    },
  );

  ipcMain.handle(
    "skills:cancelImport",
    (_e, stagingId: string): void => {
      if (typeof stagingId === "string" && stagingId) {
        discardImportStaging(stagingId);
      }
    },
  );

  ipcMain.handle(
    "skills:pickImportFile",
    async (): Promise<{ path: string } | { cancelled: true }> => {
      const parent = focusedWindow();
      const res = await dialog.showOpenDialog(parent ?? undefined as never, {
        title: "Skill-Paket importieren",
        properties: ["openFile"],
        filters: [
          { name: "Skill-Paket", extensions: ["zip", "md"] },
          { name: "Alle Dateien", extensions: ["*"] },
        ],
      });
      if (res.canceled || res.filePaths.length === 0) {
        return { cancelled: true };
      }
      return { path: res.filePaths[0]! };
    },
  );
}
