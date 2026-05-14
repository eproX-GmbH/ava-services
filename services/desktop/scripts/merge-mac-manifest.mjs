#!/usr/bin/env node
// v0.1.174 — merge `latest-mac.yml` from two separate per-arch jobs.
//
// Background: electron-updater on macOS reads ONE manifest file
// (`latest-mac.yml`) at the release root and picks the matching file
// entry for the current `process.arch`. When we build both arches in
// separate jobs (each with its own native Homebrew bottle for whisper),
// each job produces a manifest containing only ITS own arch's entry.
// The later job's `--publish always` overwrites the earlier one and we
// lose the other arch's update path.
//
// This script reconciles the two manifests:
//   1. Reads the arm64 manifest (downloaded as a GitHub Actions
//      artifact from the earlier-finishing arm64 job).
//   2. Reads the x64 manifest just produced locally.
//   3. Emits a merged manifest whose `files:` array is the union of
//      both arches' entries, keeping the arm64 `path` / `sha512` as
//      the manifest's default (because arm64 is the larger user base,
//      and the `path` / `sha512` fields are legacy hints for
//      pre-multi-arch electron-updater clients -- modern ones always
//      consult `files:`).
//
// Usage:
//   node scripts/merge-mac-manifest.mjs <arm64.yml> <x64.yml> <out.yml>
//
// Exit codes:
//   0 — merged successfully
//   1 — i/o or parse error
//   2 — version mismatch between the two manifests (shouldn't happen
//        but indicates a stale artifact, which would be a release-
//        breaking bug)

import { readFileSync, writeFileSync } from "node:fs";
import yaml from "js-yaml";

const [, , armPath, x64Path, outPath] = process.argv;

if (!armPath || !x64Path || !outPath) {
  console.error("usage: merge-mac-manifest.mjs <arm64.yml> <x64.yml> <out.yml>");
  process.exit(1);
}

let arm, x64;
try {
  arm = yaml.load(readFileSync(armPath, "utf8"));
  x64 = yaml.load(readFileSync(x64Path, "utf8"));
} catch (err) {
  console.error(`failed to parse manifest: ${err.message}`);
  process.exit(1);
}

if (arm.version !== x64.version) {
  console.error(
    `version mismatch: arm64=${arm.version} x64=${x64.version}. ` +
      `Likely a stale arm64 artifact (different release tag). Aborting merge.`,
  );
  process.exit(2);
}

const armFiles = Array.isArray(arm.files) ? arm.files : [];
const x64Files = Array.isArray(x64.files) ? x64.files : [];

const seenUrls = new Set();
const mergedFiles = [];
for (const f of [...armFiles, ...x64Files]) {
  if (!f || typeof f.url !== "string") continue;
  if (seenUrls.has(f.url)) continue;
  seenUrls.add(f.url);
  mergedFiles.push(f);
}

const merged = {
  version: arm.version,
  files: mergedFiles,
  // Keep arm64 as the legacy default path/sha512. Modern electron-
  // updater clients (v6+) read from `files:` and pick by arch.
  path: arm.path,
  sha512: arm.sha512,
  releaseDate: arm.releaseDate ?? x64.releaseDate,
};

// Preserve any other top-level keys we didn't explicitly handle
// (e.g. blockMapSize is per-file, not top-level, but if upstream
// adds new top-level keys we want to forward them rather than
// drop silently).
for (const k of Object.keys(arm)) {
  if (!(k in merged)) merged[k] = arm[k];
}
for (const k of Object.keys(x64)) {
  if (!(k in merged)) merged[k] = x64[k];
}

writeFileSync(outPath, yaml.dump(merged, { lineWidth: 200 }), "utf8");

console.log(
  `[merge-mac-manifest] ${armFiles.length} arm64 + ${x64Files.length} x64 file entries -> ${mergedFiles.length} merged (${outPath})`,
);
for (const f of mergedFiles) {
  console.log(`  • ${f.url} (${f.size ?? "?"} bytes)`);
}
