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

// v0.1.221 — Floor-Version statt fixer Pin.
//
// Bedeutet: AVA installiert beim Update IMMER mindestens diese Version,
// kann aber auch eine NEUERE installieren, wenn Upstream eine
// veröffentlicht hat. Beim Klick auf "Aktualisieren" fragt der
// Updater GitHub `/repos/ollama/ollama/releases/latest` ab und nimmt
// `max(floor, latest)`. So bekommen Nutzer automatisch neue Ollama-
// Versionen, sobald Upstream sie released — ohne dass wir AVA-seitig
// für jeden Bump ein Release machen müssen.
//
// Wozu der Floor: Schutz gegen seltsame Antworten von GitHub (z. B. ein
// zurückgezogenes Release das niedriger ist als unsere bekannte
// Mindest-Kompatibilität). qwen3 / qwen3.5 / qwen3.6 brauchen ≥ v0.24.0;
// alles darunter ist für uns funktional unbrauchbar.
//
// Wann den Floor bumpen: nur wenn wir wissen, dass eine Version unter X
// definitiv nicht mehr funktioniert (z. B. Ollama macht erneut einen
// Breaking Change wie damals v0.3→v0.5). Routine-Bumps sind nicht
// nötig — der Latest-Lookup macht das automatisch.
export const OLLAMA_FLOOR_VERSION = "v0.24.0";

// 1-Stunden-Cache für den GitHub-Latest-Lookup. Wenn der User
// klick-happy ist, hämmern wir nicht die API. Reset bei App-Restart.
const LATEST_LOOKUP_CACHE_TTL_MS = 60 * 60 * 1000;
let cachedLatestTag: { tag: string; fetchedAt: number } | null = null;

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
  | {
      state: "downloading";
      percent: number;
      bytesPerSec: number;
      /** v0.1.221 — Welche Version aktuell heruntergeladen wird. UI
       *  zeigt das mit, damit der User Bescheid weiß. */
      targetVersion?: string;
    }
  | { state: "installing"; targetVersion?: string }
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
   * Lädt eine Ollama-Binary herunter und legt sie unter
   * `<userData>/ollama-managed/<version>/` ab.
   *
   * v0.1.221 — Version-Resolution-Strategie:
   *   - Caller gibt nichts an → wir fragen GitHub nach dem neuesten
   *     stable Release. Floor-Version dient als Schutz: wir nehmen
   *     `max(floor, latest)`. Bei GitHub-Down fallen wir auf den
   *     Floor zurück.
   *   - Caller gibt explizite Version an → wir nehmen die. Power-
   *     User-Pfad (Settings „bestimmte Version installieren").
   *
   * Bestehende Managed-Versionen werden NICHT gelöscht — Disk-
   * Aufräumung als späterer Featuretopf.
   */
  async update(explicitVersion?: string): Promise<void> {
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

    let version: string;
    if (explicitVersion) {
      version = explicitVersion;
    } else {
      try {
        version = await this.resolveTargetVersion();
      } catch (err) {
        // GitHub nicht erreichbar → degradieren auf Floor. User
        // bekommt wenigstens eine funktionierende Version, AVA
        // läuft. Fehler wird geloggt, aber nicht eskaliert.
        console.warn(
          "[ollama-updater] latest-version-lookup failed, falling back to floor:",
          err instanceof Error ? err.message : err,
        );
        version = OLLAMA_FLOOR_VERSION;
      }
    }

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
      this.setState({
        state: "downloading",
        percent: 0,
        bytesPerSec: 0,
        targetVersion: version,
      });
      await this.downloadWithProgress(url, archivePath, version);
      this.setState({ state: "installing", targetVersion: version });
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

  /**
   * v0.1.221 — Resolved-Version-Strategie: GitHub fragen + Floor
   * anwenden. Mit 1-Stunden-Cache, damit GitHub nicht bei jedem Klick
   * angerufen wird.
   */
  private async resolveTargetVersion(): Promise<string> {
    const latest = await fetchLatestOllamaTag();
    // semver-ähnliches Vergleich: höhere von beiden gewinnt.
    return compareVersions(latest, OLLAMA_FLOOR_VERSION) >= 0
      ? latest
      : OLLAMA_FLOOR_VERSION;
  }

  /**
   * Gibt — falls bekannt — die Version zurück, die ein Update gerade
   * installieren würde. Nutzt den Cache; wenn der Cache leer ist und
   * GitHub nicht erreichbar war, gibt `null` zurück. Nur zur UI-
   * Anzeige gedacht (z. B. Settings-Tab: „Neueste verfügbare Version:
   * v0.27.1"). Wirft NIE.
   */
  async peekResolvedTargetVersion(): Promise<string | null> {
    try {
      return await this.resolveTargetVersion();
    } catch {
      return null;
    }
  }

  private async downloadWithProgress(
    url: string,
    dest: string,
    targetVersion: string,
  ): Promise<void> {
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
        this.setState({
          state: "downloading",
          percent,
          bytesPerSec,
          targetVersion,
        });
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

/**
 * v0.1.221 — Holt den Tag-Namen des aktuellsten stable Releases von
 * GitHub. `/releases/latest` liefert nur Non-Draft, Non-Prerelease, also
 * keine zusätzliche Filterung nötig.
 *
 * Mit 1-Stunden-Cache, damit zufällige Klick-Bursts nicht das GitHub-
 * Anonymous-Rate-Limit (60 req/h) anknabbern.
 */
async function fetchLatestOllamaTag(): Promise<string> {
  const now = Date.now();
  if (
    cachedLatestTag &&
    now - cachedLatestTag.fetchedAt < LATEST_LOOKUP_CACHE_TTL_MS
  ) {
    return cachedLatestTag.tag;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const res = await fetch(
      "https://api.github.com/repos/ollama/ollama/releases/latest",
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub responded HTTP ${res.status}`);
    }
    const body = (await res.json()) as { tag_name?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : null;
    if (!tag || !/^v\d/.test(tag)) {
      throw new Error(`Unexpected tag_name in GitHub response: ${tag}`);
    }
    cachedLatestTag = { tag, fetchedAt: now };
    return tag;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sehr leichter Semver-Vergleich für die Form `vMAJOR.MINOR.PATCH`. Gibt
 * 1 zurück wenn `a > b`, -1 wenn `a < b`, 0 wenn gleich. Pre-release-Tags
 * werden ignoriert (sollten bei `releases/latest` eh nie kommen).
 */
function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((n) => parseInt(n, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i] ?? 0;
    const y = bb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

// Backward-compat-Alias. Wir hatten `PINNED_OLLAMA_VERSION` in v0.1.220
// exportiert und im main/index.ts via Re-Export aus diesem Modul geholt.
// v0.1.221 verschiebt die Semantik: das ist jetzt der FLOOR. Der alte
// Name bleibt erhalten damit der Import-Pfad nicht bricht.
export const PINNED_OLLAMA_VERSION = OLLAMA_FLOOR_VERSION;

// Re-export für unit tests + die Supervisor-Patch-Stelle.
export { managedRoot, targetForHost, fetchLatestOllamaTag, compareVersions };

// Avoid TS unused-warning when `readFileSync` is imported only for symmetry.
void readFileSync;
