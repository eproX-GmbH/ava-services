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

import { getSharedDir } from "./account-space";
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

// 2026-11-03 (Joyce): EIN Pin statt "neueste von GitHub". Der Updater
// installiert ausschliesslich OLLAMA_PINNED_VERSION aus ./ollama-pin.ts —
// dieselbe Version, die das Bundle beim Build bekommt. Neue Ollama-Versionen
// kommen nur noch ueber ein AVA-Release, nachdem wir sie geprueft haben.
// Der Download wird gegen sha256sum.txt des Releases geprueft.
import { OLLAMA_PINNED_VERSION } from "./ollama-pin";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

// v0.1.223 — Wie viele alte Managed-Versionen wir nach einem
// erfolgreichen Update aufheben. Jede Version frisst ~200-400 MB
// (extrahierte macOS-App, Windows-Zip kleiner). 1 Behalter = aktuelle
// + 1 vorherige als Rollback-Sicherheit. Nach 3-4 Updates wären sonst
// schnell mehrere GB im UserData-Verzeichnis.
const KEEP_OLD_MANAGED_VERSIONS = 0;

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
        // v0.1.406 — extractMacZip flacht Contents/Resources/ (ollama +
        // llama-server + Runner-Libs) bereits nach outDir ab, daher liegt
        // die Binary direkt unter outDir/ollama.
        innerBinaryPath: "ollama",
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
    const target = targetForHost();
    if (!target) return null;
    const dir = join(managedRoot(), OLLAMA_PINNED_VERSION);
    const p = join(dir, target.exeName);
    if (!existsSync(p)) return null;
    // Vollstaendigkeits-Check (macOS: separate llama-server-Binary seit 0.30).
    if (process.platform === "darwin" && !existsSync(join(dir, "llama-server"))) {
      console.warn(`[ollama-updater] managed ${OLLAMA_PINNED_VERSION} ist unvollstaendig (llama-server fehlt) — uebersprungen`);
      return null;
    }
    return p;
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

    const version = explicitVersion ?? OLLAMA_PINNED_VERSION;

    const versionDir = join(managedRoot(), version);
    const finalBinary = join(versionDir, target.exeName);

    // v0.1.406 — „schon installiert"-Kurzschluss NUR, wenn die Installation
    // auch vollständig ist. Ältere AVA-Versionen extrahierten auf macOS nur
    // die `ollama`-Binary ohne die separate `llama-server`-Runner-Binary
    // (Ollama v0.30.0-Split) — solche Managed-Versionen sind kaputt und
    // müssen neu extrahiert werden, statt hier fälschlich als fertig zu
    // gelten.
    const installComplete =
      existsSync(finalBinary) &&
      (process.platform !== "darwin" ||
        existsSync(join(versionDir, "llama-server")));
    if (installComplete) {
      this.setState({
        state: "ready",
        version,
        path: finalBinary,
      });
      return;
    }
    if (existsSync(finalBinary)) {
      // Unvollständige Alt-Installation — verwerfen und sauber neu ziehen.
      rmSync(versionDir, { recursive: true, force: true });
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
      await verifyChecksum(version, target.assetName, archivePath);
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

      // v0.1.223 — Alte Managed-Versionen aufräumen (keep current +
      // KEEP_OLD_MANAGED_VERSIONS als Fallback). Wir machen das NACH
      // dem .installed-Marker, damit ein Crash mittendrin den neuen
      // Eintrag nicht versehentlich löschen kann.
      try {
        this.cleanupOldVersions(version);
      } catch (err) {
        // Cleanup ist nice-to-have, nicht kritisch.
        console.warn(
          "[ollama-updater] cleanup of old versions failed:",
          err instanceof Error ? err.message : err,
        );
      }

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
   * v0.1.223 — Alte Managed-Versionen aufräumen.
   *
   * Behält:
   *   - `keepVersion` (typisch: was wir gerade installiert haben)
   *   - bis zu KEEP_OLD_MANAGED_VERSIONS weitere höchste Versionen
   *     (Rollback-Sicherheit, falls die neueste Probleme macht)
   *
   * Defensiv:
   *   - Wir löschen nur Verzeichnisse, die mit `v` anfangen und einen
   *     `.installed`-Marker tragen. Beides muss zutreffen.
   *   - Das verhindert, dass wir versehentlich vom User dort
   *     abgelegte Dateien (z. B. manuelle Backups) wegmachen.
   *
   * Returns: Array der gelöschten Versions-Tags (für Tests/Logging).
   */
  cleanupOldVersions(keepVersion?: string): string[] {
    const root = managedRoot();
    if (!existsSync(root)) return [];

    let entries: string[];
    try {
      entries = readdirSync(root).filter((d) => d.startsWith("v"));
    } catch {
      return [];
    }

    // Nur Einträge mit `.installed`-Marker behandeln. Alles andere
    // ignorieren wir (manuell angelegte Test-Dateien etc.).
    const known = entries.filter((d) =>
      existsSync(join(root, d, ".installed")),
    );

    // Höchste Versionen zuerst (Semver-Sortierung).
    const sorted = [...known].sort((a, b) => compareVersions(b, a));

    // Die ersten N + ggf. keepVersion behalten.
    const keepSet = new Set<string>();
    for (let i = 0; i < Math.min(sorted.length, KEEP_OLD_MANAGED_VERSIONS + 1); i++) {
      const entry = sorted[i];
      if (entry) keepSet.add(entry);
    }
    if (keepVersion) keepSet.add(keepVersion);

    const removed: string[] = [];
    for (const v of sorted) {
      if (keepSet.has(v)) continue;
      const dir = join(root, v);
      try {
        rmSync(dir, { recursive: true, force: true });
        removed.push(v);
        console.info(
          `[ollama-updater] removed old managed version ${v} from ${dir}`,
        );
      } catch (err) {
        console.warn(
          `[ollama-updater] failed to remove ${v}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return removed;
  }

  /** Die Version, die AVA fuer diese Fassung vorsieht (der Pin). */
  async peekResolvedTargetVersion(): Promise<string | null> {
    return OLLAMA_PINNED_VERSION;
  }

  /** Stiller Abgleich beim Start: liegt die gepinnte Version noch nicht
   *  vollstaendig im verwalteten Verzeichnis, wird sie geholt. Liefert true,
   *  wenn danach eine (neue) Binary bereitsteht und der Supervisor neu
   *  starten sollte. Nicht unterstuetzte Plattformen: false ohne Fehler. */
  async abgleichen(): Promise<boolean> {
    if (!targetForHost()) return false;
    if (this.getManagedBinaryPath()) return false;
    await this.update();
    return this.getState().state === "ready";
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

    // v0.1.361 — Download-Integrität prüfen. Vorher wurde ein
    // unvollständig geladenes Archiv (Verbindung mitten im 177-MB-Download
    // abgebrochen, Stream endete aber „sauber") stillschweigend an `unzip`
    // übergeben → kryptisches „unzip exited 2". Wenn die empfangenen Bytes
    // nicht zur Content-Length passen, brechen wir mit klarer, aktionabler
    // Meldung ab; der Install-Flow räumt den Versions-Ordner auf, sodass
    // ein erneuter Versuch sauber von vorn lädt.
    if (total > 0 && received !== total) {
      throw new Error(
        `Download unvollständig: ${received} von ${total} Bytes empfangen ` +
          `(die Verbindung wurde vermutlich unterbrochen). Bitte das ` +
          `Ollama-Update erneut starten.`,
      );
    }
  }

  private setState(next: OllamaUpdaterState): void {
    this.current = next;
    this.emit("state", next);
  }
}

function managedRoot(): string {
  return getSharedDir("ollama-managed");
}

// ---- Extractors ----------------------------------------------------------

async function extractMacZip(archive: string, outDir: string): Promise<void> {
  // v0.1.406 — Upstream-macOS-Release ist ein .zip mit `Ollama.app/`.
  // Seit Ollama v0.30.0 liegt der Inferenz-Server als SEPARATE
  // `llama-server`-Binary + GGML/LLAMA-Runner-Libs (und MLX-Metal-Runner)
  // NEBEN `ollama` unter `Contents/Resources/`. Die KOMPLETTE Payload muss
  // flach nach outDir, sonst findet der gestartete Server seine
  // `llama-server`-Binary nicht ("llama-server binary not found") und jede
  // lokale Inferenz scheitert mit HTTP 500.
  await runCmd("unzip", ["-q", "-o", archive, "-d", outDir]);
  const resources = join(outDir, "Ollama.app", "Contents", "Resources");
  const innerBin = join(resources, "ollama");
  if (!existsSync(innerBin)) {
    throw new Error(
      `Erwartete Binary unter ${innerBin} nach Unzip nicht gefunden — Release-Layout geändert?`,
    );
  }
  for (const name of readdirSync(resources)) {
    await rename(join(resources, name), join(outDir, name));
  }
  rmSync(join(outDir, "Ollama.app"), { recursive: true, force: true });
  // Apple-Silicon-only MLX-Metal-Runner (~350 MB) auf Intel (x64) prunen.
  if (process.arch === "x64") {
    for (const dir of ["mlx_metal_v3", "mlx_metal_v4"]) {
      rmSync(join(outDir, dir), { recursive: true, force: true });
    }
  }
  const llamaServer = join(outDir, "llama-server");
  if (existsSync(llamaServer)) {
    await chmod(llamaServer, 0o755);
  }
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

/** Pruefsumme des Archivs gegen sha256sum.txt des Releases (seit Ollama
 *  v0.40 Teil jedes Releases). Fehlt die Datei oder der Eintrag, bricht die
 *  Installation ab — eine ungepruefte Binary wird nie ausgefuehrt. */
async function verifyChecksum(version: string, assetName: string, file: string): Promise<void> {
  const url = `https://github.com/ollama/ollama/releases/download/${version}/sha256sum.txt`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Pruefsummen-Datei fuer ${version} nicht erreichbar (HTTP ${res.status})`);
  let erwartet: string | null = null;
  for (const line of (await res.text()).split("\n")) {
    const m = /^([0-9a-f]{64})\s+\.?\/?(\S+)$/.exec(line.trim());
    if (m && m[2] === assetName) erwartet = m[1]!;
  }
  if (!erwartet) throw new Error(`keine Pruefsumme fuer ${assetName} in sha256sum.txt (${version})`);
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  const ist = hash.digest("hex");
  if (ist !== erwartet) throw new Error(`Pruefsumme von ${assetName} stimmt nicht (erwartet ${erwartet.slice(0, 12)}…, erhalten ${ist.slice(0, 12)}…)`);
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

export const PINNED_OLLAMA_VERSION = OLLAMA_PINNED_VERSION;
export { OLLAMA_PINNED_VERSION };

// Re-export für unit tests + die Supervisor-Patch-Stelle.
export { managedRoot, targetForHost, compareVersions };

// Avoid TS unused-warning when `readFileSync` is imported only for symmetry.
void readFileSync;
