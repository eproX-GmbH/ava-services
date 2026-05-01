#!/usr/bin/env node
// 8.m6 — German UI lint guard.
//
// Catches English copy that slipped into renderer route files / AppShell /
// DownloadDock after the 8.m1–5 sweep. Cheaper than a full custom ESLint
// rule: this is a regex-based grep step wired into CI via the
// `lint:german` package script.
//
// Heuristic: scan JSX text nodes (>...<) and the four user-facing string
// attrs (placeholder, title, aria-label, alt) for literals that contain
// any of a small list of unmistakably-English stop words. Anything that
// hits is a high-confidence regression.
//
// We deliberately do NOT try to flag every English word: domain
// identifiers like HRA / HRB / KPI / API / URL are legitimate, and a
// stop-word list is far less noisy than a "looks English" heuristic.
// If we ever need broader coverage, swap this for a custom ESLint rule
// (eslint-plugin-react has the JSX visitors we'd want).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = [
  "src/renderer/src/routes",
  "src/renderer/src/components",
];

// Files in components/ that the 8.m sweep is responsible for. Other
// components (e.g. icon SVG wrappers) are out of scope.
const COMPONENTS_ALLOW = new Set(["AppShell.tsx", "DownloadDock.tsx"]);

// Unmistakably-English UI words. If any of these shows up as its own
// token in a JSX text node or one of the watched attrs, we flag it.
// All matched case-insensitively against word boundaries.
// Only words that are unmistakably English — i.e. not loan words German
// uses verbatim (so no "optional", "info", "model", "session", "session",
// "memory", "email", "website", "OK"…). When in doubt, leave it out: this
// guard exists to catch obvious regressions, not to police every literal.
const STOP_WORDS = [
  "the", "and", "with", "without", "please",
  "loading", "saving", "saved",
  "success", "successful", "successfully",
  "failed", "failure",
  "retry", "retrying", "retried",
  "cancel", "cancelled", "submit", "submitting", "submitted",
  "search", "pending", "running", "completed", "skipped", "queued",
  "yes", "back", "next", "previous", "close",
  "open", "delete", "remove", "create", "update", "edit",
  "page",
  "username", "password",
  "sign-in", "sign-out", "logout", "login",
  "user", "users",
  "downloading", "downloaded", "uploading", "uploaded",
  "ready", "unavailable",
  "today", "yesterday",
  "minute", "minutes", "hour", "hours",
  "select", "choose", "confirm", "discard",
  "warning", "notice",
  "are", "was", "were",
  "this", "that", "these", "those",
];

// Allow-listed substrings — if a string contains any of these we leave
// it alone even if a stop word also matched. Mostly: domain identifiers,
// pipeline-stage names that match upstream API vocabulary, code-y
// strings the renderer surfaces as-is.
const ALLOW_SUBSTRINGS = [
  "HRA", "HRB", "KPI", "API", "URL", "JSON", "CSV", "XLSX", "OLLAMA",
  "AVA",
  // Stage ids leak into a couple of code-styled spots (retry-result):
  "structuredContent", "companyPublication", "companyProfile",
  "companyContact", "companyEvaluation", "masterData",
  "structured-content", "company-publication", "company-profile",
  "company-contact", "company-evaluation", "master-data",
];

// Regexes that strip out things we never want to scan: comments, import
// specifiers, URL-like strings, regex literals.
const STRIP_LINE_COMMENT = /\/\/[^\n]*/g;
const STRIP_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRIP_IMPORT = /^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm;

// JSX text: anything between `>` and `<` that has at least one ASCII letter.
// Greedy enough for our short copy; we also skip pure-whitespace runs.
const JSX_TEXT_RE = />([^<>{}]*?)</g;
// Watched attribute literals.
const ATTR_RE = /\b(placeholder|title|aria-label|alt|label)\s*=\s*["']([^"']*)["']/g;

const stopWordPatterns = STOP_WORDS.map(
  (w) => new RegExp(`(?:^|[^A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z]|$)`, "i"),
);

function isAllowListed(s) {
  return ALLOW_SUBSTRINGS.some((sub) => s.includes(sub));
}

function looksGerman(s) {
  // German-only chars or common German function words → almost certainly translated.
  if (/[äöüÄÖÜß]/.test(s)) return true;
  if (/(?:^|[^A-Za-z])(der|die|das|den|dem|des|ein|eine|einen|einem|einer|und|oder|nicht|kein|keine|für|mit|ohne|aber|auch|noch|schon|wird|werden|wurde|sind|ist|war|waren|sein|hat|haben|hatte|sich|von|vom|zum|zur|im|am|als|wie|so|bei|aus|nach|vor|über|unter)(?:[^A-Za-z]|$)/i.test(s))
    return true;
  return false;
}

function tokenHits(s) {
  return stopWordPatterns.filter((re) => re.test(s)).length;
}

function scanFile(absPath) {
  const raw = readFileSync(absPath, "utf8");
  const src = raw
    .replace(STRIP_BLOCK_COMMENT, " ")
    .replace(STRIP_LINE_COMMENT, " ")
    .replace(STRIP_IMPORT, " ");

  const findings = [];

  for (const re of [JSX_TEXT_RE, ATTR_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const literal = (re === JSX_TEXT_RE ? m[1] : m[2]) ?? "";
      const text = literal.trim();
      if (text.length < 4) continue;
      // JSX_TEXT_RE can latch onto TypeScript generics (`useState<…>(…)`),
      // since `>` and `<` also delimit them. Real JSX text never contains
      // any of these tokens; if we see them, the match is code, not copy.
      if (re === JSX_TEXT_RE && /[=(){};\n]/.test(text)) continue;
      // Single-word identifiers / code-ish single tokens: skip.
      if (!/\s/.test(text) && !/[.,!?:]/.test(text)) continue;
      if (looksGerman(text)) continue;
      if (isAllowListed(text)) continue;
      if (tokenHits(text) === 0) continue;
      // Compute approximate line number from char offset in original source.
      const offset = m.index;
      const line = src.slice(0, offset).split("\n").length;
      findings.push({ line, text });
    }
  }

  return findings;
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      yield* walk(p);
    } else if (name.endsWith(".tsx")) {
      yield p;
    }
  }
}

let totalHits = 0;
const report = [];

for (const rel of SCAN_DIRS) {
  const dir = join(ROOT, rel);
  for (const file of walk(dir)) {
    const baseName = file.split("/").pop() ?? "";
    if (rel.endsWith("/components") && !COMPONENTS_ALLOW.has(baseName)) continue;
    const findings = scanFile(file);
    if (findings.length > 0) {
      report.push({ file: relative(ROOT, file), findings });
      totalHits += findings.length;
    }
  }
}

if (totalHits === 0) {
  console.log("[lint:german] OK — no English UI strings found in scanned files.");
  process.exit(0);
}

console.error(`[lint:german] Found ${totalHits} likely-English UI string(s):`);
for (const { file, findings } of report) {
  console.error(`\n  ${file}`);
  for (const { line, text } of findings) {
    const trimmed = text.length > 100 ? text.slice(0, 97) + "…" : text;
    console.error(`    L${line}: ${JSON.stringify(trimmed)}`);
  }
}
console.error(
  "\n  Translate to German, or add the literal/identifier to ALLOW_SUBSTRINGS in scripts/check-german.mjs if it's a domain term.",
);
process.exit(1);
