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

// v1.8.4 is the first release that ships the `whisper-bin-x64.zip`
// asset we need for Windows. v1.7.4 was source-only (zero assets).
const VERSION = process.env.WHISPER_CPP_VERSION ?? "v1.8.4";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = resolve(__dirname, "..", "resources", "whisper");

/**
 * Asset names follow the pattern upstream uses for their pre-built
 * archives. The `extract` function pulls `whisper-cli[.exe]` out and
 * drops it at the canonical path. If upstream's archive layout
 * changes, only the helper bodies need to move.
 */
// Acquisition strategies per platform:
//
//   - Windows: upstream ships `whisper-bin-x64.zip` from v1.8.0+.
//   - macOS:   upstream ships NO darwin assets — only an iOS xcframework.
//              Use Homebrew on the runner (`brew install whisper-cpp`)
//              and copy the resulting `whisper-cli` into resources/.
//              The runtime arch follows the runner's arch — that's why
//              v0.1.0 pilots arm64 only. darwin-x64 needs an Intel
//              Homebrew or an explicit cross-compile (Phase 8.u3).
//   - Linux:   upstream also ships no Linux asset. Not in the v0.1.0
//              build matrix; AppImage is opt-in for later.
const TARGETS = [
  {
    id: "darwin-arm64",
    source: "brew",
    formula: "whisper-cpp",
  },
  {
    id: "win32-x64",
    source: "release",
    asset: "whisper-bin-x64.zip",
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
        console.log(`[whisper] ${target.id}: ${exeName} already present (${sz} B)`);
        // Even if the binary is cached, re-run the dylib placement step
        // on macOS — earlier versions of this script copied the dylibs
        // next to the binary, but the binary's rpath looks at `../lib/`.
        // This block fixes existing checkouts in place.
        if (target.source === "brew") {
          await placeMacDylibs(target.formula, outDir);
          await cleanupMisplacedDylibs(outDir);
        }
        continue;
      }
    }

    await mkdir(outDir, { recursive: true });

    if (target.source === "brew") {
      await fetchViaBrew(target.formula, outDir, exeName);
    } else {
      const url = `https://github.com/ggerganov/whisper.cpp/releases/download/${VERSION}/${target.asset}`;
      console.log(`[whisper] ${target.id}: downloading ${url}`);
      const archivePath = join(outDir, target.asset);
      await streamTo(url, archivePath);
      console.log(`[whisper] ${target.id}: extracting`);
      await target.extract(archivePath, outDir, exeName);
      rmSync(archivePath, { force: true });
    }
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

/**
 * Brew-based acquisition for macOS. Idempotent: if `whisper-cli` is
 * already on PATH (cached on the CI runner), we skip the install
 * step. Copies the resolved binary into the resources/ tree so
 * electron-builder's `extraResources` block bundles it.
 */
async function fetchViaBrew(formula, outDir, exeName) {
  // 1. Ensure the formula is installed. `brew install` is a no-op on
  //    a runner that already has it.
  await runCmd("brew", ["install", formula]);
  // 2. Resolve the absolute path of the installed binary. `brew --prefix`
  //    of the formula gives us `/opt/homebrew/opt/whisper-cpp` (arm64)
  //    or `/usr/local/opt/whisper-cpp` (x64); the binary lives under
  //    `bin/whisper-cli`.
  const prefix = (await runCmdCapture("brew", ["--prefix", formula])).trim();
  const srcBin = join(prefix, "bin", exeName);
  if (!existsSync(srcBin)) {
    throw new Error(`brew installed ${formula} but ${srcBin} is missing`);
  }
  const fs = await import("node:fs/promises");
  await fs.copyFile(srcBin, join(outDir, exeName));
  await placeMacDylibs(formula, outDir);
  await cleanupMisplacedDylibs(outDir);
}

/**
 * Copy brew's dylibs into `<outDir>/../lib/`. The whisper-cli binary
 * has LC_RPATH=`@loader_path/../lib` so it looks there.
 *
 * Also copies the dependent `ggml` formula's dylibs into the same
 * directory and runs `install_name_tool` to rewrite the absolute
 * brew paths (`/usr/local/opt/ggml/lib/libggml.0.dylib`,
 * `/opt/homebrew/opt/ggml/lib/...`) to `@rpath/libggml.0.dylib`,
 * so the bundle works on a user without brew at all.
 */
async function placeMacDylibs(formula, outDir) {
  const prefix = (await runCmdCapture("brew", ["--prefix", formula])).trim();
  const fs = await import("node:fs/promises");
  // The whisper formula depends on the `ggml` formula. Copy its
  // dylibs alongside libwhisper so dyld can resolve them via @rpath.
  let ggmlPrefix = null;
  try {
    ggmlPrefix = (await runCmdCapture("brew", ["--prefix", "ggml"])).trim();
  } catch {
    /* ggml not present as a separate formula on this brew version —
       libwhisper may be self-contained. Continue. */
  }
  // Also copy any shared libraries the binary links to. The Homebrew
  // whisper-cli binary on macOS has LC_RPATH set to
  // `@loader_path/../lib`, so it looks for libwhisper.1.dylib + ggml
  // dylibs at `<binary-dir>/../lib/`. With our layout
  // (`resources/whisper/<arch>/whisper-cli`), that resolves to
  // `resources/whisper/lib/`. Earlier versions of this script copied
  // the dylibs next to the binary, which produced the
  // "dyld: tried `…/whisper/darwin-arm64/../lib/libwhisper.1.dylib`
  // (no such file)" failure that surfaced as
  // "whisper-cli exited -1" in `voice:transcribe` (v0.1.134-).
  const dstLibDir = resolve(outDir, "..", "lib");
  await fs.mkdir(dstLibDir, { recursive: true });

  await copyDylibsFromBrew(join(prefix, "lib"), dstLibDir);
  if (ggmlPrefix) {
    await copyDylibsFromBrew(join(ggmlPrefix, "lib"), dstLibDir);
  }
  console.log(`[whisper] ${outDir}: copied dylibs to ${dstLibDir}`);

  // Rewrite absolute brew paths in the binary + every copied dylib
  // to @rpath so dyld resolves them inside the .app bundle.
  const binaryPath = join(outDir, "whisper-cli");
  if (existsSync(binaryPath)) {
    await rewriteBrewPathsToRpath(binaryPath, [prefix, ggmlPrefix].filter(Boolean));
  }
  for (const name of await fs.readdir(dstLibDir)) {
    if (!name.endsWith(".dylib")) continue;
    const dylibPath = join(dstLibDir, name);
    const stat = await fs.lstat(dylibPath);
    if (stat.isSymbolicLink()) continue;
    await rewriteBrewPathsToRpath(dylibPath, [prefix, ggmlPrefix].filter(Boolean));
  }
  console.log(`[whisper] ${outDir}: rewrote brew paths to @rpath`);
}

async function copyDylibsFromBrew(srcLibDir, dstLibDir) {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(srcLibDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.name.endsWith(".dylib")) continue;
      const src = join(srcLibDir, e.name);
      const dst = join(dstLibDir, e.name);
      if (e.isSymbolicLink()) {
        const target = await fs.readlink(src);
        try {
          await fs.unlink(dst);
        } catch {
          /* not present */
        }
        await fs.symlink(target, dst);
      } else {
        await fs.copyFile(src, dst);
        // Make writable so install_name_tool can mutate.
        await fs.chmod(dst, 0o644);
      }
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
}

/**
 * For each `LC_LOAD_DYLIB` entry that starts with one of `brewPrefixes`,
 * rewrite it to `@rpath/<basename>`. Also rewrites the binary's own
 * `LC_ID_DYLIB` if present.
 */
async function rewriteBrewPathsToRpath(target, brewPrefixes) {
  const linked = (await runCmdCapture("otool", ["-L", target]))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(":"));
  for (const line of linked) {
    const m = line.match(/^(\S+)\s/);
    if (!m) continue;
    const oldPath = m[1];
    if (oldPath.startsWith("@rpath/") || oldPath.startsWith("@loader_path/")) continue;
    const isBrew = brewPrefixes.some((p) => oldPath.startsWith(p + "/"));
    if (!isBrew) continue;
    const base = oldPath.split("/").pop();
    const newPath = `@rpath/${base}`;
    await runCmd("install_name_tool", ["-change", oldPath, newPath, target]);
  }
  // Self-id (`-id`) — rewrite if it points at a brew path so other
  // dylibs that load this one via the new @rpath still resolve.
  const idLine = (await runCmdCapture("otool", ["-D", target]))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.endsWith(":"))[0];
  if (idLine && brewPrefixes.some((p) => idLine.startsWith(p + "/"))) {
    const base = idLine.split("/").pop();
    await runCmd("install_name_tool", ["-id", `@rpath/${base}`, target]);
  }
}

/**
 * Old versions of this script copied dylibs into the arch dir next
 * to the binary. The new layout puts them in `<outDir>/../lib/`. To
 * keep existing checkouts clean (and avoid confusing both paths
 * being populated), prune any `.dylib` files left at the arch level.
 */
async function cleanupMisplacedDylibs(outDir) {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(outDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.name.endsWith(".dylib")) continue;
      const stale = join(outDir, e.name);
      await fs.unlink(stale);
      console.log(`[whisper] ${outDir}: removed stale ${e.name}`);
    }
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
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

function runCmdCapture(cmd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (b) => {
      out += b.toString();
    });
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      if (code === 0) resolveRun(out);
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
