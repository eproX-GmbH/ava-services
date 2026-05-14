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
//              We use Homebrew bottles for both arches:
//
//                - darwin-arm64 → native arm64 brew install on the
//                                 runner (macos-14 / macos-15).
//                - darwin-x64   → for v0.1.0…v0.1.173 we relied on
//                                 the macos-13 (Intel) runner. As of
//                                 May 2026 GitHub has phased out
//                                 macos-13 runner capacity so badly
//                                 that x64 jobs queue indefinitely
//                                 (v0.1.174…v0.1.176 each sat for
//                                 30-45 min without a runner). v0.1.178
//                                 switched to a cross-arch bottle
//                                 fetch: run on macos-14 (arm64)
//                                 and pull the Intel `sonoma`-tagged
//                                 bottle of whisper-cpp + ggml
//                                 directly from Homebrew's CDN, then
//                                 extract the tarball manually into
//                                 the same layout `placeMacDylibs`
//                                 already expects.
//
//   - Linux:   upstream also ships no Linux asset. Not in the v0.1.0
//              build matrix; AppImage is opt-in for later.
const TARGETS = [
  {
    id: "darwin-arm64",
    source: "brew",
    formula: "whisper-cpp",
  },
  {
    id: "darwin-x64",
    source: "brew-cross",
    formula: "whisper-cpp",
    /** Intel macOS 14 (Sonoma) -- the only Intel bottle Homebrew
     *  currently builds for whisper-cpp / ggml. Binaries are still
     *  forward-compatible to Intel users on macOS 13 (Ventura). */
    bottleTag: "sonoma",
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
        // v0.1.177 — also re-runs placeMacDylibs to copy the new
        // ggml backend plugins (libexec/*.so) into existing caches
        // without forcing a full re-fetch.
        if (target.source === "brew") {
          await placeMacDylibs(target.formula, outDir);
          await cleanupMisplacedDylibs(outDir);
        } else if (target.source === "brew-cross") {
          await placeCrossBrewArtifacts(target, outDir);
          await cleanupMisplacedDylibs(outDir);
        }
        continue;
      }
    }

    await mkdir(outDir, { recursive: true });

    if (target.source === "brew") {
      await fetchViaBrew(target.formula, outDir, exeName);
    } else if (target.source === "brew-cross") {
      await fetchViaCrossBrew(target, outDir, exeName);
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
 * v0.1.178 — Cross-arch acquisition for `darwin-x64` when running on
 * an arm64 host (the macos-13 GitHub runner pool was effectively
 * retired in early 2026; x64 jobs there queue indefinitely without
 * ever getting assigned). We pull the Intel Homebrew bottle of the
 * formula AND its `ggml` dependency directly from Homebrew's CDN,
 * extract the tarballs into a temp dir that mirrors brew's `prefix`
 * layout, and reuse the existing `placeCrossBrewArtifacts` logic.
 *
 * Steps:
 *   1. `brew fetch --bottle-tag=<tag> <formula>` for whisper-cpp + ggml
 *      → downloads the bottle tarball into Homebrew's cache without
 *        installing it.
 *   2. `brew --cache --bottle-tag=<tag> <formula>` → returns the
 *      absolute path of that cached tarball.
 *   3. Extract each tarball into `/tmp/ava-cross-brew/<random>/`.
 *      The tarball top-level is `<formula>/<version>/{bin,lib,libexec}`,
 *      which matches what `brew --prefix` would return for an installed
 *      formula. We hand those extracted paths into `placeCrossBrewArtifacts`
 *      which is otherwise identical to `placeMacDylibs`.
 *
 * Cross-arch concerns:
 *   - The resulting whisper-cli + dylibs are Intel Mach-O. `codesign`,
 *     `install_name_tool`, and `otool` all operate on Mach-O metadata
 *     independent of the host CPU and Just Work on an arm64 runner.
 *   - The whisper-cli binary doesn't *run* on the arm64 host (different
 *     ISA), so we can't verify the bundle locally — verification
 *     happens on the Intel user's machine after install.
 */
async function fetchViaCrossBrew(target, outDir, exeName) {
  const { formula, bottleTag } = target;
  // ggml is the direct dependency of whisper-cpp; libomp is a
  // transitive runtime dep of `libggml-cpu.so` (the CPU backend
  // plugin uses OpenMP for parallel math). Both must ship with us.
  const dependencyFormulas = ["ggml", "libomp"];
  const tmpRoot = `/tmp/ava-cross-brew-${process.pid}-${Date.now()}`;
  await mkdir(tmpRoot, { recursive: true });

  // Download Intel bottles (no install)
  console.log(`[whisper] ${target.id}: fetching ${formula} (bottle-tag=${bottleTag})`);
  await runCmd("brew", ["fetch", `--bottle-tag=${bottleTag}`, formula]);
  for (const dep of dependencyFormulas) {
    console.log(`[whisper] ${target.id}: fetching ${dep} (bottle-tag=${bottleTag})`);
    await runCmd("brew", ["fetch", `--bottle-tag=${bottleTag}`, dep]);
  }

  // Resolve cached tarball paths
  const whisperTar = (
    await runCmdCapture("brew", ["--cache", `--bottle-tag=${bottleTag}`, formula])
  ).trim();
  const depTars = {};
  for (const dep of dependencyFormulas) {
    depTars[dep] = (
      await runCmdCapture("brew", ["--cache", `--bottle-tag=${bottleTag}`, dep])
    ).trim();
  }
  if (!existsSync(whisperTar)) {
    throw new Error(`bottle cache resolve failed: whisper=${whisperTar}`);
  }
  for (const [dep, path] of Object.entries(depTars)) {
    if (!existsSync(path)) {
      throw new Error(`bottle cache resolve failed: ${dep}=${path}`);
    }
  }

  // Extract into the temp root. Tarball top-level is `<formula>/<version>/...`
  // which our existing logic treats as the brew prefix.
  console.log(`[whisper] ${target.id}: extracting bottles to ${tmpRoot}`);
  await runCmd("tar", ["xzf", whisperTar, "-C", tmpRoot]);
  for (const path of Object.values(depTars)) {
    await runCmd("tar", ["xzf", path, "-C", tmpRoot]);
  }

  // Resolve the per-formula extracted prefixes.
  const fs = await import("node:fs/promises");
  const whisperPrefix = await firstSubdir(join(tmpRoot, formula), fs);
  const ggmlPrefix = await firstSubdir(join(tmpRoot, "ggml"), fs);
  const libompPrefix = await firstSubdir(join(tmpRoot, "libomp"), fs);
  if (!whisperPrefix || !ggmlPrefix || !libompPrefix) {
    throw new Error(
      `cross-brew extract layout unexpected: ` +
        `whisperPrefix=${whisperPrefix} ggmlPrefix=${ggmlPrefix} libompPrefix=${libompPrefix}`,
    );
  }

  // Copy the Intel whisper-cli binary into outDir.
  const srcBin = join(whisperPrefix, "bin", exeName);
  if (!existsSync(srcBin)) {
    throw new Error(`whisper-cli not found in extracted bottle at ${srcBin}`);
  }
  await fs.copyFile(srcBin, join(outDir, exeName));

  // Reuse the dylib + libexec placement logic, but with our extracted
  // prefixes instead of brew's installed ones.
  await placeCrossBrewArtifacts({ whisperPrefix, ggmlPrefix, libompPrefix }, outDir);
  await cleanupMisplacedDylibs(outDir);

  // Cleanup temp extract (best-effort).
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore — tmp will be GC'd eventually */
  }
}

/**
 * Walks `dir` and returns the first sub-entry that's a directory.
 * Bottle tarballs unpack to `<formula>/<version>/`; this helps us
 * navigate to the version dir without hard-coding the version
 * (which varies as Homebrew bumps).
 */
async function firstSubdir(dir, fs) {
  if (!existsSync(dir)) return null;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const sub = entries.find((e) => e.isDirectory());
  return sub ? join(dir, sub.name) : null;
}

/**
 * v0.1.178 — cross-arch variant of placeMacDylibs. Takes already-
 * resolved prefix paths (from extracted bottle tarballs) instead of
 * calling `brew --prefix` on a locally-installed formula. Logic is
 * otherwise identical: copy libwhisper + libggml dylibs into
 * `<outDir>/../lib/`, copy ggml's libexec backend plugins into
 * `<outDir>/../libexec/`, rewrite absolute brew paths to @rpath.
 *
 * Idempotent across re-runs against an existing cached binary —
 * called from the cache-skip branch in main() as well.
 */
async function placeCrossBrewArtifacts(prefixes, outDir) {
  const { whisperPrefix, ggmlPrefix, libompPrefix } = prefixes;
  const fs = await import("node:fs/promises");
  const dstLibDir = resolve(outDir, "..", "lib");
  await fs.mkdir(dstLibDir, { recursive: true });

  await copyDylibsFromBrew(join(whisperPrefix, "lib"), dstLibDir);
  await copyDylibsFromBrew(join(ggmlPrefix, "lib"), dstLibDir);
  if (libompPrefix) {
    await copyDylibsFromBrew(join(libompPrefix, "lib"), dstLibDir);
  }
  console.log(`[whisper] ${outDir}: copied cross-brew dylibs to ${dstLibDir}`);

  const dstLibexecDir = resolve(outDir, "..", "libexec");
  await fs.mkdir(dstLibexecDir, { recursive: true });
  await copyBackendPluginsFromBrew(join(ggmlPrefix, "libexec"), dstLibexecDir);

  // Rewrite absolute brew paths. The bottle was built against the
  // formula's INSTALL prefix and the LC_LOAD_DYLIB strings embedded
  // in each Mach-O reference either:
  //   - the Cellar/opt path (e.g. `/usr/local/opt/ggml/lib/libggml.dylib`)
  //     when the bottle is built with --keep-prefix
  //   - the Homebrew placeholder `@@HOMEBREW_PREFIX@@/opt/.../...`
  //     when the bottle is "relocatable" -- the placeholder gets
  //     literally written to the binary and brew rewrites it during
  //     `install`. Our cross-fetch + tar-extract DOES NOT install,
  //     so the placeholder stays. We need to strip it ourselves.
  //
  // Both forms are listed below; rewriteBrewPathsToRpath does
  // startsWith(prefix + "/") on each, picks whichever matches, and
  // rewrites to @rpath/<basename>.
  const possiblePrefixes = [
    whisperPrefix,
    ggmlPrefix,
    libompPrefix,
    // Cellar / opt paths (Intel + arm64 brew)
    "/usr/local/Cellar/whisper-cpp",
    "/usr/local/Cellar/ggml",
    "/usr/local/Cellar/libomp",
    "/usr/local/opt/whisper-cpp",
    "/usr/local/opt/ggml",
    "/usr/local/opt/libomp",
    "/opt/homebrew/Cellar/whisper-cpp",
    "/opt/homebrew/Cellar/ggml",
    "/opt/homebrew/Cellar/libomp",
    "/opt/homebrew/opt/whisper-cpp",
    "/opt/homebrew/opt/ggml",
    "/opt/homebrew/opt/libomp",
    // Bottle placeholders (relocatable bottle path inside Mach-O)
    "@@HOMEBREW_PREFIX@@/opt/whisper-cpp",
    "@@HOMEBREW_PREFIX@@/opt/ggml",
    "@@HOMEBREW_PREFIX@@/opt/libomp",
    "@@HOMEBREW_CELLAR@@/whisper-cpp",
    "@@HOMEBREW_CELLAR@@/ggml",
    "@@HOMEBREW_CELLAR@@/libomp",
  ].filter(Boolean);

  const binaryPath = join(outDir, "whisper-cli");
  if (existsSync(binaryPath)) {
    await rewriteBrewPathsToRpath(binaryPath, possiblePrefixes);
  }
  for (const name of await fs.readdir(dstLibDir)) {
    if (!name.endsWith(".dylib")) continue;
    const dylibPath = join(dstLibDir, name);
    const stat = await fs.lstat(dylibPath);
    if (stat.isSymbolicLink()) continue;
    await rewriteBrewPathsToRpath(dylibPath, possiblePrefixes);
  }
  for (const name of await fs.readdir(dstLibexecDir).catch(() => [])) {
    if (!name.endsWith(".so") && !name.endsWith(".dylib")) continue;
    const pluginPath = join(dstLibexecDir, name);
    const stat = await fs.lstat(pluginPath);
    if (stat.isSymbolicLink()) continue;
    await rewriteBrewPathsToRpath(pluginPath, possiblePrefixes);
  }
  console.log(`[whisper] ${outDir}: rewrote brew paths to @rpath (cross-brew)`);
}

/**
 * Copy brew's dylibs into `<outDir>/../lib/`. The whisper-cli binary
 * has LC_RPATH=`@loader_path/../lib` so it looks there.
 *
 * Also copies:
 *   - the dependent `ggml` formula's `.dylib` files into the same
 *     `lib/` directory, and runs `install_name_tool` to rewrite
 *     absolute brew paths (`/usr/local/opt/ggml/lib/libggml.0.dylib`,
 *     `/opt/homebrew/opt/ggml/lib/...`) to `@rpath/libggml.0.dylib`,
 *     so the bundle works on a user without brew at all.
 *
 *   - v0.1.177 — ggml's `libexec/*.so` backend plugins (e.g.
 *     `libggml-cpu.so`, `libggml-metal.so`, `libggml-blas.so`)
 *     into `<outDir>/../libexec/`. ggml v0.10+ refactored
 *     architecture-specific backends out of `libggml.dylib` into
 *     standalone Mach-O bundles loaded via `dlopen()` at runtime.
 *     Without these, `ggml_backend_load_best()` finds nothing,
 *     `whisper_init_from_file_with_params_no_state` fails to
 *     initialize a compute backend, and whisper-cli crashes early
 *     with the "main + N | dyld start +N" stack signature the user
 *     was hitting on v0.1.176.
 *
 *     The runtime path is communicated via the `GGML_BACKEND_PATH`
 *     env var (see whisper-sidecar.ts), since the brew-baked
 *     default path (`/opt/homebrew/Cellar/ggml/X.Y.Z/libexec` or
 *     `/usr/local/Cellar/...`) doesn't exist on a clean install.
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

  // v0.1.177 — ggml backend plugins live under `<ggml>/libexec/`
  // as Mach-O bundles with `.so` extension. Copy them to a sibling
  // `libexec/` of outDir; the spawn-site sets
  // `GGML_BACKEND_PATH=<resources>/whisper/libexec` so libggml's
  // dlopen finds them at runtime.
  if (ggmlPrefix) {
    const dstLibexecDir = resolve(outDir, "..", "libexec");
    await fs.mkdir(dstLibexecDir, { recursive: true });
    await copyBackendPluginsFromBrew(join(ggmlPrefix, "libexec"), dstLibexecDir);
    console.log(`[whisper] ${outDir}: copied ggml backend plugins to ${dstLibexecDir}`);
  }

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
  // v0.1.177 — same rpath rewrite for the libexec/*.so backend
  // plugins. Each plugin links back to libggml + libggml-base in
  // ../lib/; without rewriting, dlopen() at runtime would fail with
  // the same "tried '<brew>/lib/libggml...' (no such file)" message
  // libggml itself was hitting before this commit.
  const dstLibexecDir = resolve(outDir, "..", "libexec");
  if (existsSync(dstLibexecDir)) {
    for (const name of await fs.readdir(dstLibexecDir)) {
      if (!name.endsWith(".so") && !name.endsWith(".dylib")) continue;
      const pluginPath = join(dstLibexecDir, name);
      const stat = await fs.lstat(pluginPath);
      if (stat.isSymbolicLink()) continue;
      await rewriteBrewPathsToRpath(pluginPath, [prefix, ggmlPrefix].filter(Boolean));
    }
  }
  console.log(`[whisper] ${outDir}: rewrote brew paths to @rpath`);
}

/**
 * v0.1.177 — Copy ggml's backend-plugin Mach-O bundles
 * (`libggml-cpu.so`, `libggml-metal.so`, `libggml-blas.so`, ...) from
 * `<brew>/libexec/` to our bundle's `libexec/`. Unlike `.dylib`s these
 * are loaded explicitly via `dlopen()` from libggml's
 * `ggml_backend_load_best()` walker; the runtime search path is
 * provided via `GGML_BACKEND_PATH` env var at spawn-time.
 *
 * Idempotent: skips if a plugin of the same name is already present.
 */
async function copyBackendPluginsFromBrew(srcLibexecDir, dstLibexecDir) {
  const fs = await import("node:fs/promises");
  try {
    const entries = await fs.readdir(srcLibexecDir, { withFileTypes: true });
    let copied = 0;
    for (const e of entries) {
      if (!e.isFile() && !e.isSymbolicLink()) continue;
      // ggml's libexec contains `.so` plugins on macOS too (ggml's
      // upstream uses CMake's MODULE library type which writes .so
      // even on Apple; the actual Mach-O magic is correct).
      if (!e.name.endsWith(".so") && !e.name.endsWith(".dylib")) continue;
      const src = join(srcLibexecDir, e.name);
      const dst = join(dstLibexecDir, e.name);
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
        await fs.chmod(dst, 0o644);
      }
      copied++;
    }
    console.log(`[whisper] copied ${copied} ggml backend plugins from ${srcLibexecDir}`);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      console.warn(
        `[whisper] ${srcLibexecDir} not found -- ggml may be <0.10 or not yet using plugin-based backends. Skipping.`,
      );
      return;
    }
    throw err;
  }
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
