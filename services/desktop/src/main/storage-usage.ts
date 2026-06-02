// Speicher-Aufschlüsselung + Bereinigung (v0.1.365).
//
// Nutzer berichten volllaufende Platten — der @avadesktop-Installations-
// ordner ist es nicht. Hauptursache: die Ollama-Modelle unter
// ~/.ollama/models veralten über AVA-Versionen hinweg (Default-Chat-Modell
// wechselte qwen2.5:3b → qwen3:8b; der Modell-Picker lässt Nutzer große
// Modelle ausprobieren), und NICHTS räumt die abgelösten Modelle auf.
// Dieses Modul scannt alle relevanten Ordner, schlüsselt den Verbrauch
// auf und bietet gezielte + automatische Bereinigung — wobei das aktive
// und die erforderlichen Modelle immer geschützt sind.

import { existsSync, readdirSync, rmSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { REQUIRED_MODELS } from "./ollama-models";
import { handelsregisterTempDir } from "./temp-sweep";
import type {
  OllamaInstalledModel,
  StorageCategory,
  StorageCategoryKey,
  StorageCleanupResult,
  StorageDeleteResult,
  StorageItem,
  StorageOverview,
  VoiceStatus,
} from "../shared/types";

export interface StorageDeps {
  ollama: {
    getStatus(): { installed?: OllamaInstalledModel[] };
    deleteModel(name: string): Promise<void>;
  };
  whisper: { getStatus(): VoiceStatus };
  providerStore: { getConfig(): { models?: Partial<Record<string, string>> } };
}

// ---- Pfad-Helfer ----------------------------------------------------------

/** Ollama-Modellverzeichnis — Standard `~/.ollama/models`, sofern nicht
 *  per OLLAMA_MODELS überschrieben (gleiche Logik wie im Supervisor). */
function ollamaModelsDir(): string {
  const fromEnv = process.env.OLLAMA_MODELS;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(app.getPath("home"), ".ollama", "models");
}
function whisperDir(): string {
  return join(app.getPath("userData"), "whisper");
}
function ollamaManagedDir(): string {
  return join(app.getPath("userData"), "ollama-managed");
}
function userDataDir(): string {
  return app.getPath("userData");
}

/** Gefahrlos leerbare Cache-/Temp-Ordner (Logs/Screenshots unter userData +
 *  der Producer-Handelsregister-Download-Ordner im OS-Temp). Single source
 *  of truth für Anzeige UND Lösch-Guard. */
function managedCacheDirs(): Array<{ path: string; label: string }> {
  const ud = userDataDir();
  return [
    { path: join(ud, "logs"), label: "Logs" },
    { path: join(ud, "producer-logs"), label: "Producer-Logs" },
    { path: join(ud, "screenshots"), label: "Producer-Screenshots" },
    {
      path: handelsregisterTempDir(),
      label: "Handelsregister-Downloads (Temp)",
    },
  ];
}

// ---- Größen-Helfer --------------------------------------------------------

/** Rekursive Verzeichnisgröße in Bytes. Best-effort: unlesbare Einträge
 *  werden übersprungen, niemals geworfen. */
function dirSizeBytes(path: string): number {
  let total = 0;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(path, e.name);
    try {
      if (e.isDirectory()) {
        total += dirSizeBytes(p);
      } else if (e.isFile()) {
        total += statSync(p).size;
      }
    } catch {
      /* skip unreadable */
    }
  }
  return total;
}

function fileSizeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// ---- Schutz-Regeln --------------------------------------------------------

const REQUIRED_MODEL_NAMES = new Set(REQUIRED_MODELS.map((m) => m.name));

/** Aktives Ollama-Chat-Modell (leerer String = Default → qwen3:8b). */
function activeOllamaModel(deps: StorageDeps): string {
  const sel = deps.providerStore.getConfig().models?.ollama ?? "";
  return sel.trim();
}

/** Ein Ollama-Modell ist geschützt, wenn es erforderlich (qwen3:8b,
 *  embeddinggemma) ODER das gerade gewählte Chat-Modell ist. Vergleich
 *  tolerant gegen ein fehlendes/zusätzliches `:latest`-Tag. */
function isOllamaModelProtected(name: string, active: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`);
  const n = norm(name);
  if (REQUIRED_MODEL_NAMES.has(name) || REQUIRED_MODEL_NAMES.has(n)) return true;
  if (active && (active === name || norm(active) === n)) return true;
  return false;
}

/** Aktives Whisper-Modell (Dateiname `<id>.bin`). */
function activeWhisperFile(deps: StorageDeps): string | null {
  const id = deps.whisper.getStatus().model?.id;
  return id ? `${id}.bin` : null;
}

// ---- Überblick ------------------------------------------------------------

export function buildStorageOverview(deps: StorageDeps): StorageOverview {
  const categories: StorageCategory[] = [];

  // 1. Ollama-Modelle (Haupt-Platzfresser).
  {
    const active = activeOllamaModel(deps);
    const installed = deps.ollama.getStatus().installed ?? [];
    const items: StorageItem[] = installed
      .map((m): StorageItem => {
        const prot = isOllamaModelProtected(m.name, active);
        const isActive = active
          ? m.name === active
          : REQUIRED_MODEL_NAMES.has(m.name);
        const detail = REQUIRED_MODEL_NAMES.has(m.name)
          ? "erforderlich"
          : isActive
            ? "aktiv"
            : "nicht in Benutzung";
        return {
          id: m.name,
          label: m.name,
          sizeBytes: m.size,
          protected: prot,
          detail,
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    categories.push({
      key: "ollamaModels",
      label: "Ollama-Modelle (Sprachmodelle)",
      path: ollamaModelsDir(),
      // True disk usage (shared blobs counted once) vs. summed logical sizes.
      totalBytes: dirSizeBytes(ollamaModelsDir()),
      deletable: true,
      items,
    });
  }

  // 2. Whisper-Modelle (Sprache → Text).
  {
    const dir = whisperDir();
    const activeFile = activeWhisperFile(deps);
    const items: StorageItem[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".bin"));
    } catch {
      entries = [];
    }
    for (const f of entries) {
      const isActive = activeFile === f;
      items.push({
        id: join(dir, f),
        label: f.replace(/\.bin$/, ""),
        sizeBytes: fileSizeBytes(join(dir, f)),
        protected: isActive,
        detail: isActive ? "aktiv" : "nicht in Benutzung",
      });
    }
    items.sort((a, b) => b.sizeBytes - a.sizeBytes);
    categories.push({
      key: "whisperModels",
      label: "Whisper-Modelle (Spracherkennung)",
      path: dir,
      totalBytes: items.reduce((s, i) => s + i.sizeBytes, 0),
      deletable: true,
      items,
    });
  }

  // 3. Ollama-Programmversionen (sollten i. d. R. nur eine sein).
  {
    const root = ollamaManagedDir();
    let versions: string[] = [];
    try {
      versions = readdirSync(root).filter((d) => d.startsWith("v"));
    } catch {
      versions = [];
    }
    // Höchste Version = aktuell genutzt → schützen.
    const current = versions.slice().sort(compareVersionDesc)[0];
    const items: StorageItem[] = versions
      .map((v): StorageItem => {
        const isCurrent = v === current;
        return {
          id: join(root, v),
          label: v,
          sizeBytes: dirSizeBytes(join(root, v)),
          protected: isCurrent,
          detail: isCurrent ? "aktuell" : "alte Version",
        };
      })
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    categories.push({
      key: "ollamaManaged",
      label: "Ollama-Programmversionen",
      path: root,
      totalBytes: items.reduce((s, i) => s + i.sizeBytes, 0),
      deletable: true,
      items,
    });
  }

  // 4. AVA-Cache (Logs / Screenshots / Producer-Temp) — gefahrlos leerbar.
  {
    const items: StorageItem[] = managedCacheDirs().map(({ path, label }) => ({
      id: path,
      label,
      sizeBytes: dirSizeBytes(path),
      protected: false,
      detail: "leerbar",
    }));
    categories.push({
      key: "avaCache",
      label: "AVA-Cache (Logs & Screenshots)",
      path: userDataDir(),
      totalBytes: items.reduce((s, i) => s + i.sizeBytes, 0),
      deletable: true,
      items,
    });
  }

  // 5. AVA-Daten (Datenbanken) — NUR Anzeige, nie löschbar.
  {
    const pglite = join(userDataDir(), "pglite");
    const size = dirSizeBytes(pglite);
    categories.push({
      key: "avaData",
      label: "AVA-Daten (Datenbanken)",
      path: pglite,
      totalBytes: size,
      deletable: false,
      items: [
        {
          id: pglite,
          label: "Lokale Datenbanken (Firmen, Mails, LinkedIn, Verlauf)",
          sizeBytes: size,
          protected: true,
          detail: "deine Daten — nicht löschbar",
        },
      ],
    });
  }

  const totalBytes = categories.reduce((s, c) => s + c.totalBytes, 0);
  // „Verwaist" = löschbare, nicht-geschützte Modell-Items (Ollama + Whisper).
  let orphanBytes = 0;
  let orphanCount = 0;
  for (const c of categories) {
    if (c.key !== "ollamaModels" && c.key !== "whisperModels") continue;
    for (const it of c.items) {
      if (!it.protected) {
        orphanBytes += it.sizeBytes;
        orphanCount += 1;
      }
    }
  }

  return {
    categories,
    totalBytes,
    orphanBytes,
    orphanCount,
    generatedAt: new Date().toISOString(),
  };
}

// ---- Löschen ---------------------------------------------------------------

export async function deleteStorageItem(
  deps: StorageDeps,
  category: StorageCategoryKey,
  id: string,
): Promise<StorageDeleteResult> {
  try {
    switch (category) {
      case "ollamaModels": {
        const active = activeOllamaModel(deps);
        if (isOllamaModelProtected(id, active)) {
          return {
            ok: false,
            freedBytes: 0,
            error: "Aktives/erforderliches Modell ist geschützt.",
          };
        }
        const before =
          (deps.ollama.getStatus().installed ?? []).find((m) => m.name === id)
            ?.size ?? 0;
        await deps.ollama.deleteModel(id);
        return { ok: true, freedBytes: before };
      }
      case "whisperModels": {
        const activeFile = activeWhisperFile(deps);
        if (activeFile && id.endsWith(activeFile)) {
          return {
            ok: false,
            freedBytes: 0,
            error: "Aktives Whisper-Modell ist geschützt.",
          };
        }
        if (!isUnderUserData(id)) {
          return { ok: false, freedBytes: 0, error: "Ungültiger Pfad." };
        }
        const before = fileSizeBytes(id);
        rmSync(id, { force: true });
        return { ok: true, freedBytes: before };
      }
      case "ollamaManaged": {
        if (!isUnder(id, ollamaManagedDir())) {
          return { ok: false, freedBytes: 0, error: "Ungültiger Pfad." };
        }
        // Schutz der aktuellen Version: höchste vorhandene Version.
        const root = ollamaManagedDir();
        const versions = safeReaddir(root).filter((d) => d.startsWith("v"));
        const current = versions.slice().sort(compareVersionDesc)[0];
        if (current && id === join(root, current)) {
          return {
            ok: false,
            freedBytes: 0,
            error: "Aktuelle Programmversion ist geschützt.",
          };
        }
        const before = dirSizeBytes(id);
        rmSync(id, { recursive: true, force: true });
        return { ok: true, freedBytes: before };
      }
      case "avaCache": {
        // Nur exakt die verwalteten Cache-/Temp-Ordner zulassen (der
        // Handelsregister-Temp liegt im OS-Temp, nicht unter userData).
        if (!managedCacheDirs().some((d) => d.path === id)) {
          return { ok: false, freedBytes: 0, error: "Ungültiger Pfad." };
        }
        const before = dirSizeBytes(id);
        // Inhalt leeren, Ordner selbst neu anlegen (Subsysteme schreiben rein).
        rmSync(id, { recursive: true, force: true });
        mkdirSync(id, { recursive: true });
        return { ok: true, freedBytes: before };
      }
      default:
        return { ok: false, freedBytes: 0, error: "Nicht löschbar." };
    }
  } catch (err) {
    return {
      ok: false,
      freedBytes: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Alle nicht-geschützten Ollama- + Whisper-Modelle auf einmal entfernen. */
export async function cleanupOrphanModels(
  deps: StorageDeps,
): Promise<StorageCleanupResult> {
  const overview = buildStorageOverview(deps);
  const removed: string[] = [];
  let freedBytes = 0;
  for (const c of overview.categories) {
    if (c.key !== "ollamaModels" && c.key !== "whisperModels") continue;
    for (const it of c.items) {
      if (it.protected) continue;
      const res = await deleteStorageItem(deps, c.key, it.id);
      if (res.ok) {
        removed.push(it.label);
        freedBytes += res.freedBytes;
      }
    }
  }
  return { ok: true, freedBytes, removed };
}

// ---- kleine Helfer --------------------------------------------------------

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
function isUnder(child: string, parent: string): boolean {
  const c = child.replace(/[/\\]+$/, "");
  const p = parent.replace(/[/\\]+$/, "");
  return c === p || c.startsWith(p + "/") || c.startsWith(p + "\\");
}
function isUnderUserData(child: string): boolean {
  return isUnder(child, userDataDir());
}
/** Sortiert Versions-Strings ("v0.30.0") absteigend (höchste zuerst). */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return b.localeCompare(a);
}
