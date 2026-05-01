#!/usr/bin/env node
// Fetch whisper.cpp binaries for all bundled platforms (Phase 8.n1).
//
// Pulls release assets from the upstream whisper.cpp GitHub releases and
// extracts the `whisper-cli` binary into
// `resources/whisper/<platform>-<arch>/`, where electron-builder's
// `extraResources` block expects to find them. Mirrors the structure
// of `fetch-ollama.mjs` — same script style, same idempotency, same
// per-platform extract helpers.
//
// Usage:
//   node scripts/fetch-whisper.mjs                  # all platforms
//   node scripts/fetch-whisper.mjs --platform=darwin-arm64
//   WHISPER_CPP_VERSION=v1.7.4 node scripts/fetch-whisper.mjs
//
// The model GGUF is NOT bundled — it's ~756 MB, would balloon the
// installer past sane limits, and the user runs it through the
// `voice:downloadModel` IPC after install. Only the binary is fetched
// here.
//
// Caveats:
//   - The release-asset names below track upstream conventions as of
//     2026-04. If upstream renames assets, swap the strings in TARGETS.
//   - No SHA256 verification yet; track as a Step-7 hardening item
//     alongside fetch-ollama.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  chmodSync,
} from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const VERSION = process.env.WHISPER_CPP_VERSION ?? "v1.7.4";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = resolve(__dirname, "..", "resources", "whisper");

/**
 * Asset names follow the pattern upstream uses for their pre-built
 * archives. The `extract` function pulls `whisper-cli[.exe]` out and
 * drops it at the canonical path. If upstream's archive layout
 * changes, only the helper bodies need to move.
 */
const TARGETS = [
  {
    id: "darwin-arm64",
    asset: `whisper-bin-macOS-arm64.zip`,
    extract: extractMacZip,
  },
  {
    id: "darwin-x64",
    asset: `whisper-bin-macOS-x64.zip`,
    extract: extractMacZip,
  },
  {
    id: "linux-x64",
    asset: `whisper-bin-Linux.tar.gz`,
    extract: extractLinuxTgz,
  },
  {
    id: "win32-x64",
    asset: `whisper-bin-x64.zip`,
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
    const exeName =
      target.id.startsWith("win32") ? "whisper-cli.exe" : "whisper-cli";
    const outBin = join(outDir, exeName);

    if (existsSync(outBin)) {
      const sz = statSync(outBin).size;
      if (sz > 0) {
        console.log(`[whisper] ${target.id}: ${exeName} already present (${sz} B), skipping`);
        continue;
      }
    }

    const url = `https://github.com/ggerganov/whisper.cpp/releases/download/${VERSION}/${target.asset}`;
    console.log(`[whisper] ${target.id}: downloading ${url}`);
    await mkdir(outDir, { recursive: true });
    const archivePath = join(outDir, target.asset);
    await streamTo(url, archivePath);
    console.log(`[whisper] ${target.id}: extracting`);
    await target.extract(archivePath, outDir, exeName);
    rmSync(archivePath, { force: true });
    if (!target.id.startsWith("win32")) {
      try {
        chmodSync(outBin, 0o755);
      } catch {
        /* ignore — best-effort */
      }
    }
    console.log(`[whisper] ${target.id}: done → ${outBin}`);
  }
}

async function streamTo(url, path) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

async function extractMacZip(zipPath, outDir, exeName) {
  // ditto preserves macOS extended attributes the binary needs to be
  // gatekeeper-friendly inside an .app bundle.
  await runCmd("ditto", ["-x", "-k", zipPath, outDir]);
  await ensureBinary(outDir, exeName);
}

async function extractLinuxTgz(tgzPath, outDir, exeName) {
  await runCmd("tar", ["xzf", tgzPath, "-C", outDir, "--strip-components=1"]);
  await ensureBinary(outDir, exeName);
}

async function extractWindowsZip(zipPath, outDir, exeName) {
  // System `unzip` is available on the macOS / Linux CI runners we
  // package on; on Windows-hosted CI you'd swap in Expand-Archive.
  await runCmd("unzip", ["-o", zipPath, "-d", outDir]);
  await ensureBinary(outDir, exeName);
}

/**
 * Some upstream archives put the binary inside a nested folder
 * (`whisper-cli-darwin-arm64/whisper-cli`). Walk the outDir once and
 * move the binary to the top-level if needed.
 */
async function ensureBinary(outDir, exeName) {
  const top = join(outDir, exeName);
  if (existsSync(top)) return;
  // Search one level deep — keeps the script trivial and matches the
  // archive shapes upstream actually ships.
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(outDir, e.name, exeName);
    if (existsSync(candidate)) {
      await rename(candidate, top);
      return;
    }
  }
  throw new Error(
    `${exeName} not found inside extracted archive at ${outDir}`,
  );
}

function runCmd(cmd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${cmd} exited ${code}`));
    });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Avoid the build complaining about an unused mkdirSync import — the
// helpers reach for `mkdir` (promise) above; this one's only here to
// match fetch-ollama.mjs's import shape so the two scripts read as a
// pair to a future maintainer.
void mkdirSync;
