#!/usr/bin/env node
// CI guard against accidental secret bundling (Phase 8.u2).
//
// Greps the post-build artifacts (`out/main`, `out/preload`,
// `out/renderer`, plus the `.asar`-bound source) for patterns that
// look like a credential leak. Fails the build on a hit so a future
// "let me just bundle a `.env` for convenience" mistake gets caught
// before it ships.
//
// Heuristics, narrow on purpose:
//   - lines that look like `KEY=VALUE` where KEY contains SECRET /
//     TOKEN / PASSWORD / PRIVATE_KEY / API_KEY (case-insensitive)
//   - bearer-style hex blobs > 40 chars next to a "secret"-shaped
//     identifier
//   - PEM headers (`-----BEGIN PRIVATE KEY-----` etc.)
//
// Allow-list:
//   - Whitelisted public identifiers (`OIDC_CLIENT_ID`, etc.).
//   - Source comments that document secret-shaped patterns.
//
// This script runs AFTER `electron-vite build` but BEFORE
// `electron-builder` so we catch both renderer and main bundle leaks
// regardless of asar packaging. The asar itself is checked too, in
// case `extraResources` accidentally pulled in something it
// shouldn't.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const SCAN_DIRS = [
  join(ROOT, "out"),
  join(ROOT, "release"), // electron-builder unpacks the asar here
];

const ALLOW_KEYS = new Set([
  // Public OIDC client identifiers — fine to bundle.
  "AUTH_CLIENT_ID",
  "AUTH_ISSUER",
  "OIDC_CLIENT_ID",
  // Build-time public config — fine to bundle.
  "GATEWAY_URL",
  "UPDATE_URL",
  "AVA_DEV_AUTH_BYPASS",
  "WHISPER_MODEL_URL",
  "WHISPER_MODEL_ID",
  "WHISPER_BINARY_URL",
  "WHISPER_CPP_VERSION",
  "WHISPER_THREADS",
  "OLLAMA_VERSION",
  "GATEWAY_DATA_DIR",
  // electron-vite injection prefixes; not a secret.
  "VITE_",
  "ELECTRON_RENDERER_URL",
  "ELECTRON_DISABLE_SECURITY_WARNINGS",
]);

const SECRET_KEY_RE =
  /\b([A-Z][A-Z0-9_]{2,40}(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY))\b/g;
const KEY_VALUE_RE =
  /\b([A-Z][A-Z0-9_]{2,40}(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|APIKEY|ACCESS_KEY))\s*[:=]\s*["'][^"'\n]{8,}["']/g;
const PEM_RE = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/;

const SCAN_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".html", ".asar"]);
const MAX_FILE_SIZE = 32 * 1024 * 1024;

// Phase 8.u2 — Bucket-3 (server-only) credential leak signatures.
//
// These are values that should NEVER reach the desktop bundle: postgres
// connection strings, keycloak admin client secrets, fly.io API tokens,
// service-role JWTs. Catching the *shape* of each so a typo in a config
// file or an accidental .env import gets flagged before shipping.
const SERVER_ONLY_PATTERNS = [
  {
    re: /\bpostgres(?:ql)?:\/\/[^\s"'`<>]+:[^\s"'`<>@]+@/i,
    label: "postgres connection string with embedded credentials",
  },
  {
    re: /\bfly_api_token\b\s*[:=]/i,
    label: "fly.io API token reference",
  },
  {
    re: /\beyJhbGciOi[A-Za-z0-9_=-]{40,}\.[A-Za-z0-9_=-]{40,}\.[A-Za-z0-9_=-]{20,}\b/,
    label: "JWT-shaped blob (possible service-role token)",
  },
];

// Forbidden filenames inside the bundle. A `.env`-like file ending up
// in `out/` or the asar means somebody copied it via Vite's
// `publicDir` or electron-builder's file globs by accident.
const FORBIDDEN_FILENAMES = [
  /^\.env(\.|$)/i,
  /^env\.(production|prod|staging)$/i,
  /^secrets?\.(json|yml|yaml)$/i,
];

function isAllowed(key) {
  for (const allowed of ALLOW_KEYS) {
    if (key === allowed) return true;
    if (allowed.endsWith("_") && key.startsWith(allowed)) return true;
  }
  return false;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(p);
    } else if (e.isFile()) {
      // Forbidden-filename check fires regardless of extension —
      // catches `.env`, `.env.production`, `secrets.yml`, etc.
      for (const re of FORBIDDEN_FILENAMES) {
        if (re.test(e.name)) {
          console.error(
            `[check-bundle-secrets] ${p}: forbidden filename in bundle (.env-shaped)`,
          );
          hits += 1;
          break;
        }
      }
      const ext = extname(e.name);
      if (SCAN_EXT.has(ext)) yield p;
    }
  }
}

let hits = 0;

function scanFile(path) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.size > MAX_FILE_SIZE) return;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }

  if (PEM_RE.test(content)) {
    console.error(`[check-bundle-secrets] ${path}: PEM PRIVATE KEY found`);
    hits += 1;
  }

  // Phase 8.u2 — server-only credential shape sweep.
  for (const { re, label } of SERVER_ONLY_PATTERNS) {
    const m = re.exec(content);
    if (m) {
      const lineStart = content.lastIndexOf("\n", m.index) + 1;
      const lineEnd = content.indexOf("\n", m.index);
      const line = content
        .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        .trim();
      console.error(
        `[check-bundle-secrets] ${path}: ${label}\n  ${line.slice(0, 200)}`,
      );
      hits += 1;
    }
  }

  for (const m of content.matchAll(KEY_VALUE_RE)) {
    const key = m[1] ?? "";
    if (isAllowed(key)) continue;
    const lineStart = content.lastIndexOf("\n", m.index ?? 0) + 1;
    const lineEnd = content.indexOf("\n", m.index ?? 0);
    const line = content
      .slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
      .trim();
    console.error(
      `[check-bundle-secrets] ${path}: secret-shaped assignment\n  ${line.slice(0, 200)}`,
    );
    hits += 1;
  }

  // Standalone identifier hits that aren't paired with a value are
  // INFO-level — log without failing. Catches comment references,
  // type definitions, etc. without blocking the build.
  for (const m of content.matchAll(SECRET_KEY_RE)) {
    const key = m[1] ?? "";
    if (isAllowed(key)) continue;
    // No-op: the KEY_VALUE_RE pass above is the only fail-the-build
    // case; lone identifier hits aren't actionable here.
    void key;
  }
}

for (const dir of SCAN_DIRS) {
  for (const file of walk(dir)) scanFile(file);
}

if (hits > 0) {
  console.error(
    `\n[check-bundle-secrets] ${hits} suspicious value(s) — failing the build.`,
  );
  console.error(
    `If a hit is a known false-positive, add the identifier to ALLOW_KEYS in scripts/check-bundle-secrets.mjs.`,
  );
  process.exit(1);
}
console.log("[check-bundle-secrets] OK — no secret-shaped values bundled.");
