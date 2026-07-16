#!/usr/bin/env node
// Fetch Ollama binaries for all bundled platforms (D7).
//
// Pulls the standalone server binaries from upstream's GitHub releases and
// drops them into `resources/ollama/<platform>-<arch>/ollama[.exe]`, which
// is where electron-builder's `extraResources` block expects to find them.
//
// Run once before `electron-builder` (CI does this in the package step).
// Idempotent: if a binary already exists at the target path with the
// matching version it's skipped.
//
// Usage:
//   node scripts/fetch-ollama.mjs              # all platforms
//   node scripts/fetch-ollama.mjs --platform=darwin-arm64
//   OLLAMA_VERSION=v0.3.14 node scripts/fetch-ollama.mjs
//
// Why a custom script vs a library: the upstream release-asset names are
// stable enough that adding a dependency (got, undici, etc.) is overkill;
// node:fetch + node:fs is one screen of code and zero supply-chain risk.
//
// Caveats:
//   - macOS asset is a tarball containing a `.app` bundle; we extract the
//     server binary from inside it. Linux is a raw binary in a tar.gz.
//     Windows is a .zip with `ollama.exe`. The platform-specific extraction
//     lives in `extract*` helpers below.
//   - The script does NOT verify checksums. Step 7 hardening: pin a
//     SHA256SUMS file from the release page and verify before extraction.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// v0.1.220 — Upstream-Schema-Wechsel von v0.3.x auf v0.5.x+. Wir
// landen ab hier auf der modernen Linie.
// v0.1.361 — Default-Bundle-Version auf v0.30.0 angehoben (Stand Juni
// 2026): neuere Modelle + Fixes. Neu-Installationen bringen damit direkt
// 0.30.0 mit; Bestandsinstallationen bekommen das ohnehin über den
// In-App-Updater angeboten (latest-Lookup). Asset-Layout (Ollama-darwin.zip
// mit Ollama.app/Contents/Resources/ollama) ist unverändert — geprüft.
const VERSION = process.env.OLLAMA_VERSION ?? "v0.30.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = resolve(__dirname, "..", "resources", "ollama");

const TARGETS = [
  {
    id: "darwin-arm64",
    asset: `Ollama-darwin.zip`,
    extract: extractMacApp,
  },
  {
    id: "darwin-x64",
    asset: `Ollama-darwin.zip`,
    extract: extractMacApp,
  },
  {
    id: "linux-x64",
    asset: `ollama-linux-amd64.tgz`,
    extract: extractLinuxTgz,
  },
  {
    id: "win32-x64",
    asset: `ollama-windows-amd64.zip`,
    extract: extractWindowsZip,
  },
];

const argv = process.argv.slice(2);
const onlyPlatform = argv
  .find((a) => a.startsWith("--platform="))
  ?.split("=")[1];

async function main() {
  const targets = onlyPlatform
    ? TARGETS.filter((t) => t.id === onlyPlatform)
    : TARGETS;
  if (targets.length === 0) {
    throw new Error(`No matching target for --platform=${onlyPlatform}`);
  }

  for (const target of targets) {
    const outDir = join(RESOURCES_ROOT, target.id);
    const exeName = target.id.startsWith("win32") ? "ollama.exe" : "ollama";
    const outBin = join(outDir, exeName);
    const versionMarker = join(outDir, ".version");

    if (existsSync(outBin) && existsSync(versionMarker)) {
      const have = await readFile(versionMarker, "utf8");
      if (have.trim() === VERSION) {
        console.log(`[ollama] ${target.id}: already at ${VERSION}, skipping`);
        continue;
      }
    }

    console.log(`[ollama] ${target.id}: fetching ${target.asset} @ ${VERSION}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });

    const url = `https://github.com/ollama/ollama/releases/download/${VERSION}/${target.asset}`;
    const tmp = join(outDir, target.asset);
    await download(url, tmp);
    await target.extract(tmp, outDir, exeName, target.id);
    rmSync(tmp, { force: true });
    await writeFile(versionMarker, VERSION);
    console.log(`[ollama] ${target.id}: written ${outBin}`);
  }

  console.log("[ollama] all targets up to date");
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`download failed: ${url} → HTTP ${res.status}`);
  }
  if (!res.body) throw new Error(`empty body for ${url}`);
  await mkdir(dirname(dest), { recursive: true });
  // Node's fetch returns a web ReadableStream; pipeline-via-Readable wraps it.
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// ---- Platform-specific extraction ------------------------------------------

async function extractMacApp(archive, outDir, exeName, targetId) {
  // The macOS release ships an .app bundle inside a .zip. The server binary
  // lives at `Ollama.app/Contents/Resources/ollama`.
  //
  // v0.1.406 — WICHTIG: seit Ollama v0.30.0 ist der Inferenz-Server aus der
  // einzelnen `ollama`-Binary herausgelöst. `Contents/Resources/` enthält
  // jetzt NEBEN `ollama` auch eine separate `llama-server`-Binary sowie die
  // GGML/LLAMA-Runner-Libs (`libggml-*.so`, `libllama*.dylib`,
  // `libllama-server-impl.dylib`) und die MLX-Metal-Runner (`mlx_metal_v*`).
  // Die alte Extraktion nahm NUR `ollama` und warf den Rest weg — dann
  // findet der Server beim Start seine `llama-server`-Binary nicht
  // ("llama-server binary not found") und JEDE lokale Inferenz scheitert mit
  // HTTP 500 (auf Intel-Macs besonders sichtbar, da kein Metal-Fallback).
  // Fix: die KOMPLETTE Resources-Payload flach nach outDir übernehmen, damit
  // `ollama` seine Geschwister-Binary + Libs findet.
  await runCmd("unzip", ["-q", "-o", archive, "-d", outDir]);
  const resources = join(outDir, "Ollama.app", "Contents", "Resources");
  const innerBin = join(resources, "ollama");
  if (!existsSync(innerBin)) {
    throw new Error(`expected ${innerBin} after unzip — release layout changed?`);
  }
  // Alle Einträge aus Resources/ nach outDir verschieben (ollama →
  // outDir/exeName, llama-server + Libs als Geschwister daneben).
  for (const name of readdirSync(resources)) {
    const dest = name === "ollama" ? exeName : name;
    await rename(join(resources, name), join(outDir, dest));
  }
  rmSync(join(outDir, "Ollama.app"), { recursive: true, force: true });

  // Apple-Silicon-only: die MLX-Metal-Runner (`mlx_metal_v3/v4`, ~350 MB)
  // laufen NUR auf Apple-GPUs. Auf Intel (x64) sind sie nutzlos — prunen,
  // um das DMG nicht unnötig aufzublähen. Der CPU-Pfad (libggml-cpu-*.so)
  // bleibt erhalten.
  if (targetId === "darwin-x64") {
    for (const dir of ["mlx_metal_v3", "mlx_metal_v4"]) {
      rmSync(join(outDir, dir), { recursive: true, force: true });
    }
  }

  // chmod +x auf die ausführbaren Binaries (rename erhält Perms, aber sicher
  // ist sicher — v. a. auf x64-Slices).
  await runCmd("chmod", ["+x", join(outDir, exeName)]);
  const llamaServer = join(outDir, "llama-server");
  if (existsSync(llamaServer)) {
    await runCmd("chmod", ["+x", llamaServer]);
  }
}

async function extractLinuxTgz(archive, outDir, exeName) {
  await runCmd("tar", ["-xzf", archive, "-C", outDir]);
  const inner = join(outDir, "bin", "ollama");
  if (!existsSync(inner)) {
    throw new Error(`expected ${inner} after tar — release layout changed?`);
  }
  await rename(inner, join(outDir, exeName));
  rmSync(join(outDir, "bin"), { recursive: true, force: true });
  rmSync(join(outDir, "lib"), { recursive: true, force: true });
  await runCmd("chmod", ["+x", join(outDir, exeName)]);
}

async function extractWindowsZip(archive, outDir, exeName) {
  await runCmd("unzip", ["-q", "-o", archive, "-d", outDir]);
  // Upstream zip extracts `ollama.exe` directly at the root.
  const inner = join(outDir, "ollama.exe");
  if (!existsSync(inner)) {
    throw new Error(`expected ${inner} after unzip — release layout changed?`);
  }
  if (inner !== join(outDir, exeName)) {
    await rename(inner, join(outDir, exeName));
  }
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
    p.on("error", reject);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
