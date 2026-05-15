#!/usr/bin/env node
//
// v0.1.193 — vendor-drift CI guard (v0.1.199: Node-based, line-ending-tolerant).
//
// Asserts the vendored `@ava/ai-provider/dist/index.js` in every
// producer submodule matches the workspace canonical at
// `packages/ai-provider/dist/index.js`. Fails CI on drift with a
// per-producer diff in the log.
//
// History:
//   v0.1.193 — initial shell script using `shasum -a 256`. Failed
//     on Windows runners with exit 127 because `shasum` isn't in
//     Git-Bash's PATH.
//   v0.1.198 — switched to `cmp -s` for portability. Failed on
//     Windows runners again because Git's `core.autocrlf=true`
//     converts LF→CRLF on checkout; cmp does byte-exact comparison
//     and reported false-positive drift (CRLF in vendored copy vs
//     LF in canonical, or vice-versa depending on which path Git
//     deemed text vs binary).
//   v0.1.199 — Node-based, normalises line endings (\r\n → \n)
//     before SHA-256 hashing. Node ships on every CI runner the
//     workflow already uses (setup-node@v4 ran before this step),
//     so no extra tooling. SHA-256 not because the hash matters
//     for security here, just to give a stable identity string in
//     the log.
//
// Why this exists:
//   v0.1.183: company-evaluation shipped with stale ai-provider
//     lacking the null-safe getEmbedder, crashed at boot for
//     Anthropic-only users.
//   v0.1.191: company-contact + company-profile shipped with
//     pre-v0.1.145 vendor lacking the ANTHROPIC_AUTH_TOKEN OAuth
//     fallback, crashed at boot for claude.ai-login users.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CANONICAL = join(REPO_ROOT, "packages/ai-provider/dist/index.js");

const PRODUCERS = [
  "company-profile",
  "company-contact",
  "company-evaluation",
  "website",
];

/**
 * Read the file, normalise CRLF→LF, return both the normalised
 * bytes (for the diff dump on failure) and a SHA-256 of those bytes.
 * Tolerates the Windows-runner case where Git's autocrlf converted
 * checkouts in inconsistent ways across parent and submodule.
 */
function readNormalised(path) {
  const raw = readFileSync(path);
  // Normalise in two passes so the hash is independent of the
  // platform's line-ending convention:
  //   1. CRLF → LF
  //   2. lone CR → LF (legacy Mac line-endings, defensive)
  const text = raw
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { text, hash };
}

if (!existsSync(CANONICAL)) {
  console.error(
    `vendor-drift: canonical ${CANONICAL} missing — has packages/ai-provider been built?`,
  );
  process.exit(1);
}

const canonical = readNormalised(CANONICAL);
console.log(
  `vendor-drift: canonical = packages/ai-provider/dist/index.js (sha256 ${canonical.hash.slice(0, 12)}…)`,
);

const drifted = [];
for (const p of PRODUCERS) {
  const candidate = join(REPO_ROOT, p, "vendor/ai-provider/dist/index.js");
  if (!existsSync(candidate)) {
    console.log(
      `vendor-drift: ${p} — no vendored ai-provider copy (skipped)`,
    );
    continue;
  }
  const cur = readNormalised(candidate);
  if (cur.hash === canonical.hash) {
    console.log(`vendor-drift: ${p} — OK (sha256 ${cur.hash.slice(0, 12)}…)`);
  } else {
    console.error(
      `vendor-drift: ${p} — DRIFT (sha256 ${cur.hash.slice(0, 12)}…, canonical ${canonical.hash.slice(0, 12)}…)`,
    );
    drifted.push({ producer: p, candidate });
  }
}

if (drifted.length > 0) {
  console.error("");
  console.error(
    `vendor-drift: ${drifted.length} producer(s) out of sync with packages/ai-provider:`,
  );
  for (const d of drifted) {
    console.error(`  - ${d.producer}`);
    console.error(
      `    diff packages/ai-provider/dist/index.js ${d.producer}/vendor/ai-provider/dist/index.js`,
    );
    const a = canonical.text.split("\n");
    const b = readNormalised(d.candidate).text.split("\n");
    const max = Math.min(40, Math.max(a.length, b.length));
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < max; i++) {
      if (a[i] !== b[i]) {
        console.error(`    @@ line ${i + 1}`);
        console.error(`    - ${a[i] ?? "<EOF>"}`);
        console.error(`    + ${b[i] ?? "<EOF>"}`);
        shown += 1;
      }
    }
    console.error("");
  }
  console.error("Fix:");
  console.error(
    "  rsync -a --delete packages/ai-provider/dist/ <producer>/vendor/ai-provider/dist/ \\",
  );
  console.error(
    "    && rsync -a --delete packages/ai-provider/src/  <producer>/vendor/ai-provider/src/",
  );
  console.error("Then commit the submodule update + bump the parent.");
  process.exit(1);
}

console.log("");
console.log("vendor-drift: all producers in sync ✓");
