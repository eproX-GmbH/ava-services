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

import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = process.env.OLLAMA_VERSION ?? "v0.3.14";
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
    await target.extract(tmp, outDir, exeName);
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

async function extractMacApp(archive, outDir, exeName) {
  // The macOS release ships an .app bundle inside a .zip. The server binary
  // we want lives at `Ollama.app/Contents/Resources/ollama`.
  await runCmd("unzip", ["-q", "-o", archive, "-d", outDir]);
  const inner = join(outDir, "Ollama.app", "Contents", "Resources", "ollama");
  if (!existsSync(inner)) {
    throw new Error(`expected ${inner} after unzip — release layout changed?`);
  }
  await rename(inner, join(outDir, exeName));
  rmSync(join(outDir, "Ollama.app"), { recursive: true, force: true });
  // chmod +x — `rename` preserves perms but the upstream may not set them
  // on x64 universal slices.
  await runCmd("chmod", ["+x", join(outDir, exeName)]);
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
