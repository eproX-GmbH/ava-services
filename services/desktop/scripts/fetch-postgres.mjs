#!/usr/bin/env node
// Fetch a portable PostgreSQL distribution for bundling (Phase 8.v1.0).
//
// We bundle Postgres into the app the same way we bundle Ollama and
// whisper-cli: pull a known-good portable distribution at packaging
// time, extract the binaries into `resources/postgres/<platform>-<arch>/`,
// let electron-builder's `extraResources` block copy them into the
// final .app / .exe.
//
// Source: Zonky's `embedded-postgres-binaries` Maven artifacts. They
// repackage the official PostgreSQL releases into self-contained
// .txz tarballs that ship `bin/`, `lib/`, `share/`, and `include/`
// — everything `pg_ctl` and `initdb` need to run without touching
// system paths. Maven Central is mirrored worldwide and stable.
//
// Why Zonky vs e.g. PostgreSQL.app: PostgreSQL.app ships a .app bundle
// that's macOS-only and includes a GUI; Zonky's tarballs are headless
// and identical in structure across mac/linux/win, so the extraction
// + path-discovery code stays the same on every platform.
//
// Usage:
//   node scripts/fetch-postgres.mjs                       # all platforms
//   node scripts/fetch-postgres.mjs --platform=darwin-arm64
//   POSTGRES_VERSION=16.4.0 node scripts/fetch-postgres.mjs
//
// Idempotent: the destination dir's `bin/postgres` existence flips it
// into a no-op, matching fetch-ollama / fetch-whisper. Delete the dir
// to force a re-pull.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// PG 17.5 — latest stable version Zonky publishes for all four
// platforms we ship (mac-arm64, mac-x64, win-x64, linux-x64).
// Zonky doesn't publish 16.x, so going one major up rather than two
// down (15.x). Prisma 5.20+ supports PG 17 cleanly.
const VERSION = process.env.POSTGRES_VERSION ?? "17.5.0";
const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCES_ROOT = resolve(__dirname, "..", "resources", "postgres");

// Map our internal platform-arch ids to Zonky's Maven classifier
// strings. Zonky uses `arm64v8` (no underscore, ARMv8 suffix) and
// `amd64` instead of `x64`; the rest matches our convention.
const TARGETS = [
  { id: "darwin-arm64", classifier: "darwin-arm64v8" },
  { id: "darwin-x64", classifier: "darwin-amd64" },
  { id: "win32-x64", classifier: "windows-amd64" },
  { id: "linux-x64", classifier: "linux-amd64" },
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
    const exeName = target.id.startsWith("win32") ? "postgres.exe" : "postgres";
    const outBin = join(outDir, "bin", exeName);

    if (existsSync(outBin) && statSync(outBin).size > 0) {
      console.log(`[postgres] ${target.id}: already present, skipping`);
      continue;
    }

    await mkdir(outDir, { recursive: true });

    // Maven artifact URL. Repository layout:
    //   <group>/<artifactId>/<version>/<artifactId>-<version>.jar
    // groupId  = io.zonky.test.postgres → io/zonky/test/postgres
    // artifact = embedded-postgres-binaries-<classifier>
    const artifactId = `embedded-postgres-binaries-${target.classifier}`;
    const jarUrl =
      `https://repo1.maven.org/maven2/io/zonky/test/postgres/` +
      `${artifactId}/${VERSION}/${artifactId}-${VERSION}.jar`;
    const jarPath = join(outDir, `${artifactId}-${VERSION}.jar`);

    console.log(`[postgres] ${target.id}: downloading ${jarUrl}`);
    await streamTo(jarUrl, jarPath);

    // The .jar is a regular ZIP that contains exactly one .txz file
    // plus a META-INF/. Extract just the .txz to outDir, throw away
    // the rest.
    console.log(`[postgres] ${target.id}: unpacking jar`);
    const txzPath = await extractTxzFromJar(jarPath, outDir);

    console.log(`[postgres] ${target.id}: extracting ${txzPath}`);
    await extractTxz(txzPath, outDir);

    rmSync(jarPath, { force: true });
    rmSync(txzPath, { force: true });

    if (!existsSync(outBin)) {
      throw new Error(
        `[postgres] ${target.id}: bin/${exeName} missing after extract — ` +
          `Zonky archive layout may have changed`,
      );
    }

    console.log(`[postgres] ${target.id}: done → ${outBin}`);
  }
}

async function streamTo(url, path) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(
      `download failed: HTTP ${res.status} ${res.statusText} ${url}`,
    );
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

/**
 * The Zonky JAR is a ZIP. Inside it lives one `.txz` file (the actual
 * Postgres distribution) and a `META-INF/` directory that we can
 * ignore. Use the system `unzip` to dump everything into outDir, then
 * locate the .txz and return its path. macOS, Linux, and modern
 * Windows all have `unzip` available on PATH.
 */
async function extractTxzFromJar(jarPath, outDir) {
  await runCmd("unzip", ["-o", "-q", jarPath, "-d", outDir]);
  // Find the .txz at top-level of outDir.
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".txz")) {
      return join(outDir, e.name);
    }
  }
  throw new Error(`No .txz found inside ${jarPath}`);
}

/**
 * Tar+xz extraction. macOS Big Sur+ tar handles xz natively via -J;
 * GNU tar on Linux likewise; Windows 10+ tar.exe also supports xz.
 * One command per platform — no extra deps.
 */
async function extractTxz(txzPath, outDir) {
  await runCmd("tar", ["xJf", txzPath, "-C", outDir]);
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

// Placeholder used to silence unused-import linting; keeps the script
// shape symmetrical with fetch-ollama/fetch-whisper for future
// maintainers reading them as a triple.
void mkdirSync;
