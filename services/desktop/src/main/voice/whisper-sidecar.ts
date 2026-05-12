import { EventEmitter } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn, spawnSync } from "node:child_process";
import { app } from "electron";
import type {
  VoiceModelDownloadProgress,
  VoiceModelInfo,
  VoiceState,
  VoiceStatus,
} from "../../shared/types";

// Whisper sidecar manager (Phase 8.n1).
//
// Mirrors the OllamaSupervisor shape: tracks binary + model presence
// at runtime, exposes a status snapshot to the renderer, and owns the
// model-download lifecycle. Actual audio → text transcription stays
// stubbed in 8.n1 — `transcribe()` returns a placeholder string so
// renderer-side wiring (mic button, IPC roundtrip) can be exercised
// before whisper.cpp is locally available. 8.n2 swaps the stub for a
// real spawn of the bundled binary against the staged audio buffer.
//
// Bundling expectation:
//   resources/whisper/<platform>-<arch>/<binary>
// where <binary> is `whisper-cli` (or `whisper-cli.exe` on win32).
// The fetch-whisper.mjs script populates this; an absent binary just
// drops the sidecar into `binary-missing` state — every other layer
// stays alive.
//
// Model storage (per-tenant disk persistence, not in-bundle):
//   userData/whisper/<modelId>.bin
// The GGUF lands here on first download; absence drops the sidecar
// into `model-missing` so the FirstRunWizard / Settings panel can
// surface the "Herunterladen" affordance.

interface ModelChoice {
  id: string;
  label: string;
  /** German one-liner shown next to the label in the picker. */
  hint: string;
  url: string;
  approxBytes: number;
}

/**
 * Catalog of reliably-hosted models from the whisper.cpp project's
 * official Hugging Face mirror at `huggingface.co/ggerganov/whisper.cpp`.
 * These URLs have been stable since 2023 — they're what every
 * whisper.cpp tutorial points at. All multilingual (Whisper has
 * trained-in German support); the entries differ by size / quality /
 * RAM profile.
 *
 * `WHISPER_MODEL_URL` env override still wins; `WHISPER_MODEL_ID`
 * picks one of the catalog entries by id (default: large-v3-q5_0).
 */
const MODEL_CATALOG: ModelChoice[] = [
  {
    id: "base",
    label: "Whisper Base",
    hint: "~150 MB · schnell, geringere Genauigkeit (Tests / Sprach-Tests)",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    approxBytes: 142 * 1024 * 1024,
  },
  {
    id: "small",
    label: "Whisper Small",
    hint: "~466 MB · ausgewogene Wahl für Diktate",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    approxBytes: 466 * 1024 * 1024,
  },
  {
    id: "large-v3-q5_0",
    label: "Whisper Large V3 (Q5_0)",
    hint: "~547 MB · empfohlen, beste Genauigkeit bei moderater Größe",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin",
    approxBytes: 547 * 1024 * 1024,
  },
  {
    id: "large-v3-turbo-q5_0",
    label: "Whisper Large V3 Turbo (Q5_0)",
    hint: "~574 MB · schnellere Variante von Large V3",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
    approxBytes: 574 * 1024 * 1024,
  },
];

const DEFAULT_MODEL_ID = "large-v3-q5_0";

function resolveDefaultModel(): ModelChoice {
  // 1. Explicit URL wins — air-gapped + custom-fine-tune escape hatch.
  if (process.env.WHISPER_MODEL_URL) {
    return {
      id: "custom",
      label: "Eigenes Modell",
      hint: "via WHISPER_MODEL_URL gesetzt",
      url: process.env.WHISPER_MODEL_URL,
      approxBytes: 0,
    };
  }
  // 2. Catalog selection by id.
  const wantId = process.env.WHISPER_MODEL_ID ?? DEFAULT_MODEL_ID;
  return (
    MODEL_CATALOG.find((m) => m.id === wantId) ??
    MODEL_CATALOG.find((m) => m.id === DEFAULT_MODEL_ID)!
  );
}

const DEFAULT_MODEL = resolveDefaultModel();

export interface WhisperSidecarOptions {
  /** Override the bundled binary path (test seam). */
  binaryPathOverride?: string;
  /** Override the model storage dir (test seam). Defaults to
   *  `userData/whisper`. */
  modelDirOverride?: string;
}

export interface WhisperSidecarEvents {
  status: (status: VoiceStatus) => void;
  /** Coalesced ~5 Hz progress frames during a download. */
  progress: (p: VoiceModelDownloadProgress) => void;
  /** Auto-install stdout/stderr lines (`installBinary`). The renderer
   *  surfaces these in the Settings panel while a brew install (or
   *  future bundled-mirror download) runs. */
  installLog: (line: string) => void;
}

export declare interface WhisperSidecar {
  on<K extends keyof WhisperSidecarEvents>(
    event: K,
    listener: WhisperSidecarEvents[K],
  ): this;
  emit<K extends keyof WhisperSidecarEvents>(
    event: K,
    ...args: Parameters<WhisperSidecarEvents[K]>
  ): boolean;
}

export class WhisperSidecar extends EventEmitter {
  private state: VoiceState = "idle";
  private errorMessage: string | null = null;
  private download: VoiceModelDownloadProgress | null = null;
  private inflightAbort: AbortController | null = null;
  /** Resolved on every `start()` so a newly-installed binary (auto-
   *  install via `installBinary()`) shows up without an app restart. */
  private binaryPath: string | null = null;
  private installing = false;
  private readonly binaryPathOverride: string | null;
  private readonly modelDir: string;

  constructor(opts: WhisperSidecarOptions = {}) {
    super();
    this.binaryPathOverride = opts.binaryPathOverride ?? null;
    this.modelDir =
      opts.modelDirOverride ?? join(app.getPath("userData"), "whisper");
  }

  /** Synchronous snapshot. */
  getStatus(): VoiceStatus {
    const model = this.getModelInfo();
    return {
      state: this.state,
      binaryPath: this.binaryPath,
      model,
      download: this.download,
      errorMessage: this.errorMessage,
    };
  }

  /**
   * Run the boot-time probes:
   *   - bundled / system / installed binary present?
   *   - model file present + non-empty?
   * Updates state accordingly. Idempotent — safe to call from app
   * lifecycle, the FirstRunWizard's "retry" path, and after a
   * successful `installBinary()`.
   */
  async start(): Promise<void> {
    this.binaryPath = this.binaryPathOverride ?? this.resolveBinary();
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      this.setState("binary-missing");
      return;
    }
    const model = this.getModelInfo();
    if (!model || !model.installed) {
      this.setState("model-missing");
      return;
    }
    // 8.n1: smoke test = both pieces exist. 8.n2 will replace this with
    // a one-shot `whisper-cli --help` to confirm the binary actually
    // runs (catches arch mismatches the OS ignores at filesystem level).
    this.setState("ready");
  }

  /**
   * Auto-install the whisper-cli binary (Phase 8.n1 follow-up).
   * Strategy in priority order:
   *   1. Already installed (via PATH / Homebrew prefix / userData) →
   *      a re-probe in `start()` flips state to ready / model-missing.
   *   2. macOS with Homebrew available → `brew install whisper-cpp`,
   *      then re-probe. Streams progress lines through the `install`
   *      event so the renderer can show them.
   *   3. Future: download a precompiled binary from a known URL into
   *      `userData/whisper/<platform>/whisper-cli`. Not enabled by
   *      default because upstream whisper.cpp doesn't reliably ship
   *      macOS binaries — adding a custom mirror is a Step 7 item.
   *
   * Re-entrant safe: a second call while one is in flight rejects.
   * Throws on every failure path with a German message the renderer
   * surfaces verbatim.
   */
  async installBinary(): Promise<void> {
    if (this.installing) {
      throw new Error("Installation läuft bereits.");
    }
    this.installing = true;
    try {
      // Path 1 — re-probe.
      await this.start();
      const stateAfterProbe = this.state as VoiceState;
      if (
        stateAfterProbe === "ready" ||
        stateAfterProbe === "model-missing"
      ) {
        return;
      }

      // Path 2 — env-configured mirror URL (escape hatch). When set,
      // takes priority over the per-platform default so an enterprise
      // / air-gapped install can point at its own CDN.
      const mirrorUrl = process.env.WHISPER_BINARY_URL;
      if (mirrorUrl) {
        this.emit("installLog", `[whisper] Mirror: ${mirrorUrl}`);
        await this.downloadAndExtractBinary(mirrorUrl);
        await this.start();
        const stateAfterMirror = this.state as VoiceState;
        if (
          stateAfterMirror === "ready" ||
          stateAfterMirror === "model-missing"
        ) {
          return;
        }
        throw new Error(
          "Mirror-Download fertig, aber whisper-cli wurde danach nicht gefunden.",
        );
      }

      // Path 3 — per-platform native installer.
      if (process.platform === "darwin") {
        await this.installMacOS();
      } else if (process.platform === "win32") {
        await this.installWindows();
      } else if (process.platform === "linux") {
        await this.installLinux();
      } else {
        throw new Error(
          "Diese Plattform wird für die Auto-Installation nicht unterstützt.",
        );
      }

      await this.start();
      const stateAfter = this.state as VoiceState;
      if (stateAfter === "ready" || stateAfter === "model-missing") {
        return;
      }
      throw new Error(
        "Installation meldete Erfolg, aber whisper-cli wurde danach nicht gefunden. Bitte App neu starten und erneut versuchen.",
      );
    } finally {
      this.installing = false;
    }
  }

  // ---- Platform installers ------------------------------------------------

  private async installMacOS(): Promise<void> {
    const brew = whichBin("brew");
    if (brew) {
      this.emit("installLog", "[whisper] brew install whisper-cpp …");
      try {
        await runStreaming(brew, ["install", "whisper-cpp"], (line) =>
          this.emit("installLog", line),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Homebrew-Installation fehlgeschlagen: ${msg}.`);
      }
      return;
    }
    throw new Error(
      [
        "Homebrew (`brew`) wurde auf diesem Gerät nicht gefunden.",
        "",
        "Schnellste Lösung: Homebrew installieren (1× Befehl im Terminal):",
        '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        "",
        "Danach in dieser App auf 'Auto-Installation starten' klicken, der Rest läuft automatisch.",
        "",
        "Alternativ: WHISPER_BINARY_URL auf einen Mirror setzen, der ein Archiv mit whisper-cli enthält.",
      ].join("\n"),
    );
  }

  private async installWindows(): Promise<void> {
    // Upstream whisper.cpp ships Windows binaries reliably as
    // `whisper-bin-x64.zip` in their GitHub releases. Override the
    // version with `WHISPER_CPP_VERSION` if a user needs to pin.
    const version = process.env.WHISPER_CPP_VERSION ?? "v1.7.4";
    const url = `https://github.com/ggerganov/whisper.cpp/releases/download/${version}/whisper-bin-x64.zip`;
    this.emit("installLog", `[whisper] Lade Windows-Binary: ${url}`);
    await this.downloadAndExtractBinary(url);
  }

  private async installLinux(): Promise<void> {
    // Upstream's Linux artifacts are inconsistent across versions.
    // Try first; fall back to a clear apt/dnf hint when the asset
    // 404s.
    const version = process.env.WHISPER_CPP_VERSION ?? "v1.7.4";
    const url = `https://github.com/ggerganov/whisper.cpp/releases/download/${version}/whisper-bin-Linux.tar.gz`;
    this.emit("installLog", `[whisper] Versuche Linux-Binary: ${url}`);
    try {
      await this.downloadAndExtractBinary(url);
      return;
    } catch (err) {
      this.emit(
        "installLog",
        `[whisper] Upstream-Asset nicht verfügbar (${
          err instanceof Error ? err.message : err
        }).`,
      );
    }
    throw new Error(
      [
        "Auto-Installation auf Linux ist nicht direkt verfügbar (upstream liefert kein passendes Binary für diese Version).",
        "",
        "Schnellste Lösung: Paketmanager nutzen:",
        "  Ubuntu/Debian: sudo apt install whisper-cpp",
        "  Fedora/RHEL:   sudo dnf install whisper-cpp",
        "  Arch:          sudo pacman -S whisper-cpp",
        "",
        "Danach in dieser App auf 'Auto-Installation starten' klicken, der Rest läuft automatisch.",
        "",
        "Alternativ: WHISPER_BINARY_URL auf einen Mirror setzen, der ein Archiv mit whisper-cli enthält.",
      ].join("\n"),
    );
  }

  /**
   * Download `url` into a temp file, extract via the platform's
   * native tar / unzip, find `whisper-cli[.exe]` anywhere in the
   * extracted tree, move it to the canonical
   * `userData/whisper/<platform>/whisper-cli` path, mark +x on Unix.
   */
  private async downloadAndExtractBinary(url: string): Promise<void> {
    const platformId = currentPlatformId();
    if (!platformId) throw new Error("Unbekannte Plattform.");
    const binName =
      process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
    const targetDir = join(this.modelDir, platformId);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

    const isTarGz = /\.(tar\.gz|tgz)$/i.test(url);
    const tmpArchive = join(
      targetDir,
      isTarGz ? "_install.tmp.tar.gz" : "_install.tmp.zip",
    );
    const stagingDir = join(targetDir, "_extract");
    if (existsSync(stagingDir)) {
      try {
        const { rmSync } = await import("node:fs");
        rmSync(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    mkdirSync(stagingDir, { recursive: true });

    this.emit("installLog", "[whisper] Lade Archiv …");
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(
        `Download fehlgeschlagen: HTTP ${res.status} ${res.statusText}.`,
      );
    }
    await pipeline(
      Readable.fromWeb(
        res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
      ),
      createWriteStream(tmpArchive),
    );

    this.emit("installLog", "[whisper] Entpacke Archiv …");
    if (isTarGz) {
      await runStreaming(
        "tar",
        ["-xzf", tmpArchive, "-C", stagingDir],
        (line) => this.emit("installLog", line),
      );
    } else if (process.platform === "win32") {
      // Win 10+ tar.exe handles .zip natively.
      await runStreaming(
        "tar",
        ["-xf", tmpArchive, "-C", stagingDir],
        (line) => this.emit("installLog", line),
      );
    } else {
      await runStreaming(
        "unzip",
        ["-o", tmpArchive, "-d", stagingDir],
        (line) => this.emit("installLog", line),
      );
    }

    const found = findBinary(stagingDir, binName);
    if (!found) {
      throw new Error(
        `Archiv enthält kein ${binName}. Bitte WHISPER_BINARY_URL prüfen.`,
      );
    }
    const target = join(targetDir, binName);
    await rename(found, target);
    if (process.platform !== "win32") {
      try {
        const { chmodSync } = await import("node:fs");
        chmodSync(target, 0o755);
      } catch {
        /* best-effort */
      }
    }
    try {
      unlinkSync(tmpArchive);
    } catch {
      /* ignore */
    }
    try {
      const { rmSync } = await import("node:fs");
      rmSync(stagingDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    this.emit("installLog", `[whisper] Fertig: ${target}`);
  }

  /**
   * Download the default model (or the env-overridden URL) into the
   * userData dir. Streams to a `.tmp` file and rename-on-success so a
   * crash mid-download can't leave a half-baked GGUF the next probe
   * would mistake for valid.
   *
   * Re-entrant safe: a second call while one is in flight is rejected
   * via the AbortController. Use `cancelDownload()` to abort.
   */
  async downloadModel(): Promise<void> {
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      throw new Error(
        "Whisper-Binary nicht gefunden. Bitte App neu installieren oder fetch-whisper-Skript ausführen.",
      );
    }
    if (this.state === "downloading") {
      throw new Error("Download läuft bereits.");
    }
    const url = DEFAULT_MODEL.url;
    if (!existsSync(this.modelDir)) {
      mkdirSync(this.modelDir, { recursive: true });
    }
    const targetPath = this.diskPathFor(DEFAULT_MODEL.id);
    const tmpPath = `${targetPath}.${process.pid}.tmp`;

    this.errorMessage = null;
    this.download = { total: null, completed: 0 };
    this.setState("downloading");
    const ctrl = new AbortController();
    this.inflightAbort = ctrl;

    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const totalHeader = res.headers.get("content-length");
      const total = totalHeader ? Number(totalHeader) : null;
      this.download = { total, completed: 0 };
      this.emit("progress", this.download);

      // Tee through a transform-counter so we can emit progress without
      // buffering the whole response in memory.
      let completed = 0;
      let lastEmit = 0;
      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          completed += chunk.byteLength;
          const now = Date.now();
          // Coalesce to ~5 Hz so the renderer's IPC channel doesn't
          // flood for a 750 MB stream.
          if (now - lastEmit >= 200) {
            lastEmit = now;
            this.download = { total, completed };
            this.emit("progress", this.download);
          }
          controller.enqueue(chunk);
        },
        flush: () => {
          this.download = { total, completed };
          this.emit("progress", this.download);
        },
      });
      const counted = res.body.pipeThrough(counter);

      await pipeline(
        Readable.fromWeb(
          counted as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        createWriteStream(tmpPath),
      );
      await rename(tmpPath, targetPath);

      this.download = null;
      this.inflightAbort = null;
      // Re-probe — picks up the new file size and flips state to ready.
      await this.start();
    } catch (err) {
      // Best-effort cleanup of the partial file; missing-tmp is fine.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      this.download = null;
      this.inflightAbort = null;
      const message = err instanceof Error ? err.message : String(err);
      // Aborts are normal user-driven cancels — don't treat as error.
      if (ctrl.signal.aborted) {
        await this.start();
        return;
      }
      this.setState("error", `Download fehlgeschlagen: ${message}`);
      throw err;
    }
  }

  cancelDownload(): void {
    if (!this.inflightAbort) return;
    this.inflightAbort.abort();
    this.inflightAbort = null;
  }

  /**
   * Wipe the on-disk model. Used by the Settings "Sprachmodell
   * entfernen" affordance. Re-probes after deletion so the state
   * flips back to `model-missing`.
   */
  async deleteModel(): Promise<void> {
    const target = this.diskPathFor(DEFAULT_MODEL.id);
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch (err) {
      console.warn("[whisper] deleteModel failed:", err);
    }
    await this.start();
  }

  /**
   * Real transcription (Phase 8.n2). The renderer captures mic audio
   * via Web Audio at 16 kHz mono and ships a WAV-encoded buffer here.
   * We write it to a temp file, spawn `whisper-cli` against the
   * resolved model GGUF, and return the German transcript stripped
   * of stderr noise + the brief stdout chrome whisper-cli prints
   * around the actual text.
   *
   * Concurrency: the renderer's recording UX guarantees one
   * transcription at a time, but defensively we don't queue here —
   * a second concurrent call just spawns a second child process.
   * On a typical laptop a 10 s clip transcribes in 3–5 s with the
   * default Q5_0 model, so user-perceived contention is negligible.
   */
  async transcribe(audio: Uint8Array): Promise<{ text: string }> {
    if (this.state !== "ready") {
      throw new Error(
        `Whisper-Sidecar ist nicht bereit (state=${this.state}).`,
      );
    }
    if (!this.binaryPath) {
      throw new Error("Whisper-Binary-Pfad ist nicht aufgelöst.");
    }
    const model = this.getModelInfo();
    if (!model || !model.installed) {
      throw new Error("Sprachmodell ist nicht installiert.");
    }

    // Temp WAV — best-effort cleanup in `finally`. We don't reuse a
    // single fixed path because back-to-back transcriptions could
    // race in pathological setups.
    const tmpDir = require("node:os").tmpdir() as string;
    const tmpName = `ava-whisper-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 10)}.wav`;
    const tmpPath = join(tmpDir, tmpName);

    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(tmpPath, audio);

      // Whisper-cli flags:
      //   -m <model>      path to GGUF
      //   -f <wav>        16-bit PCM WAV input
      //   -l de           language (German); pass `auto` if you want
      //                   detection, but we lock to German because the
      //                   app is German-first and detection eats time.
      //   -nt             no timestamps
      //   -np             no progress prints to stdout
      //   -t <threads>    Worker threads — default 4 is good for
      //                   M-series; let the user override via env.
      const threads = process.env.WHISPER_THREADS ?? "4";
      const args = [
        "-m",
        model.diskPath,
        "-f",
        tmpPath,
        "-l",
        "de",
        "-nt",
        "-np",
        "-t",
        threads,
      ];

      let { stdout, stderr, exitCode } = await runWithCapture(
        this.binaryPath,
        args,
        90_000,
      );

      // v0.1.162 — Self-heal for native crashes of whisper-cli (exit
      // code -1 with a backtrace in stderr like "main + 2364 | dyld
      // start"). Almost always caused by `dlopen()` of a sibling
      // libwhisper.dylib failing because of com.apple.quarantine on
      // the bundle. Scrub the whisper resources tree and retry once.
      // If the second attempt also crashes, surface the original
      // error — the user sees a useful message + we don't loop.
      const looksLikeNativeCrash =
        exitCode !== 0 &&
        (exitCode === -1 ||
          /\bmain\s*\+\s*\d+/i.test(stderr) ||
          /dyld\s+\S+\s+start/i.test(stderr));
      if (looksLikeNativeCrash) {
        try {
          const { scrubWhisperBundle } = await import("../scrub-quarantine");
          await scrubWhisperBundle();
          ({ stdout, stderr, exitCode } = await runWithCapture(
            this.binaryPath,
            args,
            90_000,
          ));
        } catch (err) {
          // Self-heal itself failed; fall through to the standard
          // error path below with the original whisper-cli stderr.
          console.warn(
            "[whisper] self-heal scrub failed:",
            err instanceof Error ? err.message : err,
          );
        }
      }

      if (exitCode !== 0) {
        const tail = stderr.split(/\r?\n/).slice(-3).join(" | ").trim();
        throw new Error(
          `whisper-cli exited ${exitCode}${tail ? `: ${tail}` : ""}`,
        );
      }
      const text = cleanTranscript(stdout);
      return { text };
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
    }
  }

  // ---- Internal -----------------------------------------------------------

  private getModelInfo(): VoiceModelInfo | null {
    const path = this.diskPathFor(DEFAULT_MODEL.id);
    let sizeBytes = 0;
    let installed = false;
    if (existsSync(path)) {
      try {
        const st = statSync(path);
        sizeBytes = st.size;
        // Tiny size = probably a half-written file from an interrupted
        // download. Trust nothing < 1 MB for a model that should be
        // hundreds of MB.
        installed = sizeBytes > 1024 * 1024;
      } catch {
        installed = false;
      }
    }
    return {
      id: DEFAULT_MODEL.id,
      label: DEFAULT_MODEL.label,
      diskPath: path,
      sizeBytes,
      installed,
    };
  }

  private diskPathFor(modelId: string): string {
    return join(this.modelDir, `${modelId}.bin`);
  }

  private setState(next: VoiceState, errorMessage?: string): void {
    this.state = next;
    if (errorMessage !== undefined) this.errorMessage = errorMessage;
    if (next === "ready" || next === "downloading" || next === "model-missing") {
      this.errorMessage = null;
    }
    this.emit("status", this.getStatus());
  }

  /**
   * Walk every plausible install location and return the first one
   * that exists. Priority order:
   *   1. system PATH (`which whisper-cli`) — picks up Homebrew
   *      installs without any custom search.
   *   2. userData install dir — where a future "auto-download
   *      precompiled binary" would land. Reserved.
   *   3. bundled prod resources (`process.resourcesPath/whisper/…`).
   *   4. dev repo-local resources (`<app>/resources/whisper/…`).
   *
   * When NOTHING is found we still return the FIRST candidate path so
   * the error message points the user at a fixable location.
   */
  private resolveBinary(): string | null {
    const platformId = currentPlatformId();
    if (!platformId) return null;
    const binName =
      process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

    // 1. System PATH — covers Homebrew, apt, manual installs.
    const onPath = whichBin(binName);
    if (onPath) return onPath;

    // 2. userData install dir (auto-download target).
    const userDataPath = join(this.modelDir, platformId, binName);
    if (existsSync(userDataPath)) return userDataPath;

    // 3. + 4. — same logic resolveBundledBinary() used to do.
    const isPackaged = !process.defaultApp;
    const prodPath = process.resourcesPath
      ? join(process.resourcesPath, "whisper", platformId, binName)
      : null;
    const repoPath = join(
      app.getAppPath(),
      "resources",
      "whisper",
      platformId,
      binName,
    );
    const repoParentPath = join(
      dirname(app.getAppPath()),
      "resources",
      "whisper",
      platformId,
      binName,
    );
    const candidates = isPackaged
      ? [prodPath, repoPath, repoParentPath].filter(
          (p): p is string => p !== null,
        )
      : [repoPath, repoParentPath, prodPath].filter(
          (p): p is string => p !== null,
        );
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    // Nothing found — return the first candidate that points where
    // an auto-install would land, so the error reads as "expected at
    // <userData> or one of these other paths" and the auto-install
    // affordance is the obvious next step.
    return userDataPath;
  }
}

// ---- Helpers --------------------------------------------------------------

function whichBin(name: string): string | null {
  // Cross-platform binary lookup. `which` on Unix, `where.exe` on
  // Windows; both return absolute paths on success and exit non-zero
  // when missing. We resolve only the FIRST match — `where` returns
  // newline-separated entries.
  const cmd = process.platform === "win32" ? "where.exe" : "which";
  try {
    const result = spawnSync(cmd, [name], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const first = result.stdout.split(/\r?\n/)[0]?.trim();
    return first && existsSync(first) ? first : null;
  } catch {
    return null;
  }
}

/**
 * Walk `dir` recursively and return the first path whose basename
 * matches `name` (or `name + .exe` on Windows). Used after extracting
 * a release archive to locate the binary regardless of the archive's
 * inner folder layout.
 */
function findBinary(dir: string, name: string): string | null {
  // Bounded BFS — release archives don't nest deep, no need for full
  // walk semantics. Cap at 8 levels just in case.
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const stack: Array<{ path: string; depth: number }> = [
    { path: dir, depth: 0 },
  ];
  while (stack.length > 0) {
    const { path, depth } = stack.pop()!;
    if (depth > 8) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(path, e.name);
      if (e.isDirectory()) {
        stack.push({ path: full, depth: depth + 1 });
        continue;
      }
      if (e.name === name) return full;
    }
    // statSync isn't strictly needed but keeps the import warm; avoids
    // an unused-import warning when readdirSync is the only consumer.
    void statSync;
  }
  return null;
}

/**
 * Spawn + capture stdout / stderr / exit code, with a hard timeout.
 * Used by the transcribe path where we need the full output to parse,
 * not a streamed line iterator.
 */
async function runWithCapture(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`whisper-cli timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

/**
 * whisper-cli prints transcript lines plus occasional stderr-style
 * chrome to stdout depending on flags. Strip the obvious markers
 * (lines starting with "[", "main:", or whisper-cli's progress
 * prefix) and collapse remaining whitespace.
 */
function cleanTranscript(stdout: string): string {
  const lines = stdout.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Drop status lines: "[00:00:00.000 --> ...]", "main: ...",
    // "whisper_init_*", percentage-progress chrome, etc.
    if (
      line.startsWith("[") ||
      line.startsWith("main:") ||
      line.startsWith("whisper_") ||
      line.startsWith("system_info:") ||
      /^\d+%$/.test(line)
    ) {
      continue;
    }
    out.push(line);
  }
  return out.join(" ").trim();
}

async function runStreaming(
  cmd: string,
  args: string[],
  onLine: (line: string) => void,
): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const onChunk = (buf: Buffer): void => {
      for (const line of buf.toString("utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("error", (err) => rejectRun(err));
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${cmd} exited ${code}`));
    });
  });
}

function currentPlatformId(): string | null {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  switch (process.platform) {
    case "darwin":
      return `darwin-${arch}`;
    case "linux":
      return `linux-${arch}`;
    case "win32":
      return `win32-${arch}`;
    default:
      return null;
  }
}
