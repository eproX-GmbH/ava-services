#!/usr/bin/env node
// Phase T5 — auto-generate TOOLS.md from src/main/agent/tools/*.ts.
//
// Parses each `defineTool({ ... })` block out of the TypeScript source
// with a small regex / brace-balancing scanner; we deliberately do NOT
// execute the TS (the tools have Electron + module-side-effect imports
// that don't run cleanly under node).
//
// Output lands at the repo root (TOOLS.md), grouped by file (= domain).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = dirname(HERE);
const REPO_ROOT = join(DESKTOP_ROOT, "..", "..");
const TOOLS_DIR = join(DESKTOP_ROOT, "src", "main", "agent", "tools");
// v0.1.157 — root-level .md files moved under /docs to declutter the
// repository root. README.md stays at root; everything else lives in
// docs/ so the GitHub landing page focuses on the README.
const OUT_PATH = join(REPO_ROOT, "docs", "TOOLS.md");

const GROUP_LABEL = {
  alerts: "Meldungen / Alerts",
  companies: "Firmen",
  crm: "CRM",
  evaluations: "Bewertungen",
  freshness: "Aktualisierung (Freshness)",
  imports: "Importe",
  linkedin: "LinkedIn",
  memory: "Langzeit-Gedächtnis",
  profile: "Profil",
  settings: "Einstellungen",
  transactions: "Transaktionen",
  ui: "UI-Helfer",
  watches: "Watches",
  ollama: "Ollama (lokale LLM)",
  voice: "Spracherkennung",
  updater: "App-Updates",
  reachability: "Erreichbarkeit (externe Quellen)",
  producers: "Producer (Hintergrund-Services)",
  "chat-history": "Chat-Verlauf",
};

/**
 * Strip line + block comments from a TS/JS source. Preserves string
 * contents (so `// inside a string` is left alone). Replaces stripped
 * text with spaces of equal length so offsets stay roughly comparable
 * (not used downstream, but cheap insurance).
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  let inString = null;
  let escape = false;
  while (i < src.length) {
    const ch = src[i];
    const nx = src[i + 1];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === inString) {
        inString = null;
      }
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && nx === "/") {
      // Line comment — skip to next newline.
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && nx === "*") {
      // Block comment — skip to */.
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < src.length) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Extract `defineTool({ ... })` blocks from a TS source string.
 * Returns an array of { name, description, parameters }.
 */
export function extractTools(rawSource) {
  const source = stripComments(rawSource);
  const tools = [];
  let i = 0;
  while (i < source.length) {
    const idx = source.indexOf("defineTool({", i);
    if (idx < 0) break;
    // Find the matching closing brace.
    let depth = 0;
    let start = idx + "defineTool(".length; // points at first `{`
    let j = start;
    let inString = null; // '\'' | '"' | '`' | null
    let escape = false;
    let templateDepth = 0; // brace depth inside a `${...}`
    for (; j < source.length; j++) {
      const ch = source[j];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (inString === "`") {
          // Handle ${...} interpolation: track an inner brace depth
          // and pop back to template-string mode when it closes.
          if (templateDepth > 0) {
            if (ch === "{") templateDepth++;
            else if (ch === "}") templateDepth--;
            continue;
          }
          if (ch === "$" && source[j + 1] === "{") {
            templateDepth = 1;
            j++;
            continue;
          }
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        templateDepth = 0;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const block = source.slice(start, j); // contents incl. outer { }
    const parsed = parseToolBlock(block);
    if (parsed) tools.push(parsed);
    i = j;
  }
  return tools;
}

function parseToolBlock(block) {
  const name = matchProp(block, "name");
  if (!name) return null;
  const description = matchProp(block, "description") ?? "";
  const parameters = matchParameters(block);
  return { name, description, parameters };
}

/**
 * Match a top-level string prop assignment: `name: "value"` or
 * `name: "a" + "b"` (concatenation). Returns the concatenated string,
 * unescaped enough to read.
 */
function matchProp(block, key) {
  // Find `key:` at brace-depth 1 (the immediate object).
  const re = new RegExp(`\\b${key}\\s*:\\s*`, "g");
  let m;
  while ((m = re.exec(block)) !== null) {
    // Confirm we're at top level.
    if (!isTopLevel(block, m.index)) continue;
    const after = m.index + m[0].length;
    const value = readStringExpression(block, after);
    if (value !== null) return value;
  }
  return null;
}

function isTopLevel(block, pos) {
  let depth = 0;
  let inString = null;
  let escape = false;
  // Block starts with `{`; we're at depth 1 right after it.
  for (let k = 0; k < pos; k++) {
    const ch = block[k];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
  }
  return depth === 1;
}

/**
 * Read a string-literal expression possibly joined by `+`. Stops at
 * a comma/newline-comma. Returns the unescaped string, or null.
 */
function readStringExpression(block, start) {
  const parts = [];
  let i = start;
  while (i < block.length) {
    // Skip whitespace.
    while (i < block.length && /\s/.test(block[i])) i++;
    const ch = block[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      // Read a string literal.
      const quote = ch;
      i++;
      let buf = "";
      let escape = false;
      while (i < block.length) {
        const c = block[i];
        if (escape) {
          // Minimal escape handling.
          if (c === "n") buf += "\n";
          else if (c === "t") buf += "\t";
          else buf += c;
          escape = false;
          i++;
          continue;
        }
        if (c === "\\") {
          escape = true;
          i++;
          continue;
        }
        if (c === quote) {
          i++;
          break;
        }
        buf += c;
        i++;
      }
      parts.push(buf);
      // Skip whitespace.
      while (i < block.length && /\s/.test(block[i])) i++;
      if (block[i] === "+") {
        i++;
        continue;
      }
      break;
    } else {
      // Not a string literal — bail.
      return parts.length > 0 ? parts.join("") : null;
    }
  }
  return parts.join("");
}

/**
 * Extract the JSON-Schema `parameters` object (top-level prop). We just
 * isolate the `{ ... }` and try to JSON-parse it after normalising.
 */
function matchParameters(block) {
  const re = /\bparameters\s*:\s*\{/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (!isTopLevel(block, m.index)) continue;
    const start = m.index + m[0].length - 1; // points at `{`
    let depth = 0;
    let inString = null;
    let escape = false;
    let j = start;
    for (; j < block.length; j++) {
      const ch = block[j];
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        inString = ch;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const raw = block.slice(start, j);
    return normaliseObjectLiteral(raw);
  }
  return null;
}

/**
 * Convert a JS object-literal text (single quotes, unquoted keys, trailing
 * commas, comments, spread) into something JSON.parse can swallow.
 * Best-effort — returns null on failure.
 */
function normaliseObjectLiteral(text) {
  let s = text;
  // Strip line comments and block comments.
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/(^|[^:])\/\/.*$/gm, "$1");
  // Replace single-quoted strings with double-quoted (best-effort).
  s = s.replace(/'((?:[^'\\]|\\.)*)'/g, (_, body) => {
    return '"' + body.replace(/"/g, '\\"') + '"';
  });
  // Quote unquoted keys (identifiers).
  s = s.replace(/([{,\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*:/g, '$1"$2":');
  // Trailing commas.
  s = s.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatParam(name, schema, required) {
  const type = schema?.type ?? "any";
  const desc = schema?.description ? ` — ${schema.description}` : "";
  const enumStr = Array.isArray(schema?.enum) ? ` (enum: ${schema.enum.join(", ")})` : "";
  const def = schema?.default !== undefined ? ` (default: ${JSON.stringify(schema.default)})` : "";
  const req = required ? " (required)" : "";
  return `- \`${name}: ${type}${enumStr}\`${req}${def}${desc}`;
}

function renderTool(tool, fileBase) {
  const lines = [];
  lines.push(`### \`${tool.name}\``);
  lines.push("");
  lines.push(`_Datei:_ \`services/desktop/src/main/agent/tools/${fileBase}.ts\``);
  lines.push("");
  lines.push(tool.description.trim());
  lines.push("");
  const params = tool.parameters;
  const props = params?.properties ?? {};
  const required = new Set(Array.isArray(params?.required) ? params.required : []);
  const keys = Object.keys(props);
  if (keys.length === 0) {
    lines.push("_Parameter:_ keine.");
  } else {
    lines.push("_Parameter:_");
    for (const key of keys) {
      lines.push(formatParam(key, props[key], required.has(key)));
    }
  }
  lines.push("");
  return lines.join("\n");
}

function main() {
  const files = readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();

  const byFile = new Map();
  let total = 0;
  for (const file of files) {
    const fileBase = basename(file, ".ts");
    const path = join(TOOLS_DIR, file);
    const source = readFileSync(path, "utf8");
    const tools = extractTools(source);
    tools.sort((a, b) => a.name.localeCompare(b.name));
    if (tools.length > 0) {
      byFile.set(fileBase, tools);
      total += tools.length;
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push("# AVA Agent-Tools");
  out.push("");
  out.push("Auto-generiert von `services/desktop/scripts/generate-tools-md.mjs`.");
  out.push("NICHT direkt bearbeiten — die Quelle der Wahrheit ist `services/desktop/src/main/agent/tools/*.ts`.");
  out.push("Lauf via `pnpm -F @ava/desktop tools:doc` (oder automatisch via `build:typecheck`).");
  out.push("");
  out.push(`Stand: ${today}`);
  out.push(`Anzahl Tools: ${total}`);
  out.push("");

  // Stable grouping: known labels first in domain-friendly order; unknowns appended.
  const knownOrder = [
    "companies",
    "imports",
    "transactions",
    "evaluations",
    "alerts",
    "freshness",
    "watches",
    "profile",
    "memory",
    "settings",
    "crm",
    "linkedin",
    "ui",
  ];
  const seen = new Set();
  const ordered = [];
  for (const k of knownOrder) {
    if (byFile.has(k)) {
      ordered.push(k);
      seen.add(k);
    }
  }
  for (const k of byFile.keys()) {
    if (!seen.has(k)) ordered.push(k);
  }

  for (const fileBase of ordered) {
    const tools = byFile.get(fileBase);
    const label = GROUP_LABEL[fileBase] ?? fileBase;
    out.push(`## ${label} (${tools.length})`);
    out.push("");
    for (const tool of tools) {
      out.push(renderTool(tool, fileBase));
    }
  }

  writeFileSync(OUT_PATH, out.join("\n"), "utf8");
  console.log(`[tools:doc] wrote ${OUT_PATH} (${total} tools across ${ordered.length} files)`);
}

import { argv } from "node:process";
if (argv[1] && import.meta.url === `file://${argv[1]}`) main();
