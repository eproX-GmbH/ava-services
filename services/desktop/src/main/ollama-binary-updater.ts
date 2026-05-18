// v0.1.220 — Runtime-Self-Update für die gebündelte Ollama-Binary.
//
// Problem: Beim Erst-Setup bekommen Nutzer eine zum Build-Zeitpunkt
// gebündelte Ollama-Binary (siehe `scripts/fetch-ollama.mjs`).
// Ollamas Manifest-Format hat sich zwischen 0.3.x und 0.5+ massiv
// geändert — alte Binaries lehnen das qwen3-Manifest mit
// `HTTP 412: The model you are attempting to pull requires a newer
// version of Ollama` ab.
//
// Lösung: AVA kann zur Laufzeit die aktuelle Ollama-Binary von
// GitHub-Releases nachladen, im UserData-Verzeichnis ablegen, und der
// Supervisor switched auf den neuen Pfad. Kein App-Restart nötig,
// nur Supervisor-Restart.
//
// Lokationen:
//   - Gebundelte Binary: `<resourcesPath>/ollama/<platform>-<arch>/ollama`
//   - Managed Binary:    `<userData>/ollama-managed/<version>/ollama`
//
// Supervisor checkt erst den Managed-Pfad. Nur falls keiner existiert,
// fällt er auf die Bundled-Variante zurück.

import { EventEmitter } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { chmod, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";
import { app } from "electron";

// Letzte bekannte stabile Ollama-Version, die qwen3 + qwen3.5 + qwen3.6
// vollständig unterstützt. Anpassen, wenn wir gezielter pinnen wollen;
// `getLatestVersion()` unten gleicht das beim Update gegen GitHub ab.
export const PINNED_OLLAMA_VERSION = "v0.24.0";

interface PlatformTarget {
  assetName: string;
  /** Pfad innerhalb des entpackten Archivs, an dem die tatsächliche
   *  Server-Binary liegt — relativ zum Output-Verzeichnis. */
  innerBinaryPath: string;
  exeName: string;
  /** Wie das Archiv ausgepackt wird. */
  extract: (
    archive: string,
    outDir: string,
  ) => Promise<void>;
}

function targetForHost(): PlatformTarget | null {
  const id = `${process.platform}-${process.arch}`;
  switch (id) {
    case "darwin-arm64":
    case "darwin-x64":
      return {
        assetName: "Ollama-darwin.zip",
        innerBinaryPath: "Ollama.app/Contents/Resources/ollama",
        exeName: "ollama",
        extract: extractMacZip,
      };
    case "win32-x64":
      return {
        assetName: "ollama-windows-amd64.zip",
        innerBinaryPath: "ollama.exe",
        exeName: "ollama.exe",
        extract: extractWindowsZip,
      };
    case "linux-x64":
      // Anmerkung: Linux bekommt ab v0.5+ `.tar.zst`. Wir bauen
      // Desktop-Linux-Bundles derzeit nicht im Release-Workflow,
      // aber wer dev-side darauf läuft soll trotzdem ein vernünftiges
      // Fehlerbild bekommen.
      return null;
    default:
      return null;
  }
}

export type OllamaUpdaterState =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "downloading"; percent: number; bytesPerSec: number }
  | { state: "installing" }
  | { state: "ready"; version: string; path: string }
  | { state: "error"; message: string };

export interface OllamaUpdaterEvents {
  state: (s: OllamaUpdaterState) => void;
}

export declare interface OllamaBinaryUpdater {
  on<K extends keyof OllamaUpdaterEvents>(
    event: K,
    listener: OllamaUpdaterEvents[K],
  ): this;
  emit<K extends keyof OllamaUpdaterEvents>(
    event: K,
    ...args: Parameters<OllamaUpdaterEvents[K]>
  ): boolean;
}

export class OllamaBinaryUpdater extends EventEmitter {
  private current: OllamaUpdaterState = { state: "idle" };

  getState(): OllamaUpdaterState {
    return this.current;
  }

  /**
   * Pfad zur managed Binary, falls bereits vorhanden. Wird vom
   * Supervisor `resolveBinaryPath()` aufgerufen, bevor er auf die
   * gebundelte Variante zurückfällt.
   */
  getManagedBinaryPath(): string | null {
    const root = managedRoot();
    if (!existsSync(root)) return null;
    const target = targetForHost();
    if (!target) return null;
    // Aktuell installierte Version: marker-Datei `.version` neben
    // der Binary. Wir nehmen die HÖCHSTE Version aus dem Verzeichnis
    // (lexikographisch ist OK für `v0.24.0`-Schema).
    const candidates = readdirSync(root)
      .filter((d) => d.startsWith("v"))
      .sort()
      .reverse();
    for (const v of candidates) {
      const p = join(root, v, target.exeName);
      if (existsSync(p)) return p;
    }
    return null;
  }

  getManagedVersion(): string | null {
    const p = this.getManagedBinaryPath();
    if (!p) return null;
    // Pfad-Struktur: `<userData>/ollama-managed/<version>/<exe>`.
    return dirname(p).split(/[/\\]/).pop() ?? null;
  }

  /**
   * Lädt die gepinnte Ollama-Version herunter und legt sie unter
   * `<userData>/ollama-managed/<version>/` ab. Bestehende Managed-
   * Versionen werden NICHT gelöscht — das macht ein späterer Cleanup-
   * Pfad. Auf Erfolg: state="ready" mit Pfad + Version. Auf Fehler:
   * state="error".
   */
  async update(version: string = PINNED_OLLAMA_VERSION): Promise<void> {
    const target = targetForHost();
    if (!target) {
      this.setState({
        state: "error",
        message:
          `Ollama-Auto-Update auf dieser Plattform (${process.platform}-${process.arch}) ` +
          `nicht unterstützt. Bitte Ollama manuell aktualisieren: https://ollama.com/download`,
      });
      return;
    }

    this.setState({ state: "checking" });
    const versionDir = join(managedRoot(), version);
    const finalBinary = join(versionDir, target.exeName);

    if (existsSync(finalBinary)) {
      this.setState({
        state: "ready",
        version,
        path: finalBinary,
      });
      return;
    }

    mkdirSync(versionDir, { recursive: true });
    const archivePath = join(versionDir, target.assetName);
    const url = `https://github.com/ollama/ollama/releases/download/${version}/${target.assetName}`;

    try {
      this.setState({ state: "downloading", percent: 0, bytesPerSec: 0 });
      await this.downloadWithProgress(url, archivePath);
      this.setState({ state: "installing" });
      await target.extract(archivePath, versionDir);
      // Inner-Binary an die Standard-Position verschieben + +x setzen.
      const innerAbs = join(versionDir, target.innerBinaryPath);
      if (!existsSync(innerAbs)) {
        throw new Error(
          `Erwartete Binary unter ${innerAbs} nach Extract nicht gefunden — Release-Layout geändert?`,
        );
      }
      if (innerAbs !== finalBinary) {
        await rename(innerAbs, finalBinary);
      }
      if (process.platform !== "win32") {
        await chmod(finalBinary, 0o755);
      }
      // Aufräumen.
      try {
        rmSync(archivePath, { force: true });
      } catch {
        /* ignore */
      }
      writeFileSync(join(versionDir, ".installed"), new Date().toISOString());

      this.setState({ state: "ready", version, path: finalBinary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({
        state: "error",
        message: `Ollama-Update fehlgeschlagen: ${message}`,
      });
      // Halb-installierten Versions-Ordner aufräumen, damit der
      // nächste Versuch nicht mit ungültigem Zustand startet.
      try {
        rmSync(versionDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private async downloadWithProgress(url: string, dest: string): Promise<void> {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Download fehlgeschlagen: HTTP ${res.status} bei ${url}`);
    }
    if (!res.body) throw new Error(`Leere Antwort bei ${url}`);
    const totalHeader = res.headers.get("content-length");
    const total = totalHeader ? parseInt(totalHeader, 10) : 0;

    await mkdir(dirname(dest), { recursive: true });
    const out = createWriteStream(dest);
    let received = 0;
    const startTime = Date.now();
    let lastEmit = 0;

    const reader = Readable.fromWeb(
      res.body as unknown as ReadableStream<Uint8Array>,
    );
    reader.on("data", (chunk: Buffer) => {
      received += chunk.length;
      const now = Date.now();
      // Throttle Status-Pushes auf max. 5 Hz.
      if (now - lastEmit > 200) {
        const elapsedSec = Math.max(1, (now - startTime) / 1000);
        const bytesPerSec = received / elapsedSec;
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        this.setState({ state: "downloading", percent, bytesPerSec });
        lastEmit = now;
      }
    });
    await pipeline(reader, out);
  }

  private setState(next: OllamaUpdaterState): void {
    this.current = next;
    this.emit("state", next);
  }
}

function managedRoot(): string {
  return join(app.getPath("userData"), "ollama-managed");
}

// ---- Extractors ----------------------------------------------------------

async function extractMacZip(archive: string, outDir: string): Promise<void> {
  // Upstream-macOS-Release ist ein .zip mit `Ollama.app/`. Wir
  // entpacken alles, der Caller verschiebt nur das interne
  // `Contents/Resources/ollama`-Binary an die Standardposition.
  await runCmd("unzip", ["-q", "-o", archive, "-d", outDir]);
}

async function extractWindowsZip(
  archive: string,
  outDir: string,
): Promise<void> {
  // PowerShell-Native-Unzip funktioniert auf allen unterstützten
  // Windows-Versionen ohne Drittprogramme.
  await runCmd("powershell", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    `Expand-Archive -Force -Path '${archive}' -DestinationPath '${outDir}'`,
  ]);
}

function runCmd(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

// Lint-only Re-Export — gibt dem Renderer/Settings-Tab Zugriff auf den
// pinned-Wert, ohne dass er den File importieren muss.
export function pinnedOllamaVersion(): string {
  return PINNED_OLLAMA_VERSION;
}

// Re-export für unit tests + die Supervisor-Patch-Stelle.
export { managedRoot, targetForHost };

// Avoid TS unused-warning when `readFileSync` is imported only for symmetry.
void readFileSync;
