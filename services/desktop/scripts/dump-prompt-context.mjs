#!/usr/bin/env node
// Dump des Chat-Agent-Kontexts (System-Prompt + Tool-Schemas) in eine
// Markdown-Datei zur Review/Token-Analyse.
//
// Hintergrund: ein Nutzer mit Claude-Pro-Abo (kleines 5h-Fenster) läuft bei
// werkzeugintensiven Chats schnell ins Abo-Limit. Das pro Runde gesendete
// Payload = System-Prompt + Tool-Schemas (der „teure" Teil). Dieses Skript
// macht beides sichtbar inkl. grober Token-Schätzung, damit man sieht, wo
// die Tokens hingehen.
//
// Quelle der Wahrheit:
//   - System-Prompt: src/main/agent/prompts.ts (buildSystemPrompt) — wird
//     hier per esbuild gebündelt und mit ALLEN Tool-Namen ausgeführt (also
//     der Worst-Case „alle Tools geladen").
//   - Tool-Schemas: src/main/agent/tools/*.ts — via extractTools() aus
//     generate-tools-md.mjs (gleiche Extraktion wie TOOLS.md).
//
// Lauf: node scripts/dump-prompt-context.mjs  → docs/PROMPT-CONTEXT.md

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { extractTools } from "./generate-tools-md.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = dirname(HERE);
const REPO_ROOT = join(DESKTOP_ROOT, "..", "..");
const TOOLS_DIR = join(DESKTOP_ROOT, "src", "main", "agent", "tools");
const PROMPTS_TS = join(DESKTOP_ROOT, "src", "main", "agent", "prompts.ts");
const OUT_PATH = join(REPO_ROOT, "docs", "PROMPT-CONTEXT.md");

/** Grobe Token-Schätzung. GPT/Claude-BPE liegt für gemischtes DE/EN bei
 *  ~3.8–4.2 Zeichen/Token; wir nehmen 4 als handliche Faustzahl. */
function estTokens(s) {
  return Math.round(s.length / 4);
}
function fmt(n) {
  return n.toLocaleString("de-DE");
}

// ---- 1. System-Prompt via echtem buildSystemPrompt() --------------------

function bundleAndLoadPrompts() {
  const esbuild = join(REPO_ROOT, "node_modules", ".bin", "esbuild");
  const tmp = join(mkdtempSync(join(tmpdir(), "ava-prompt-")), "prompts.mjs");
  const r = spawnSync(
    esbuild,
    [
      PROMPTS_TS,
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--outfile=${tmp}`,
      "--log-level=error",
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
  if (r.status !== 0) {
    throw new Error("esbuild bundling of prompts.ts failed");
  }
  return tmp;
}

// ---- 2. Tool-Schemas aus den tools/*.ts ---------------------------------

function collectTools() {
  const files = readdirSync(TOOLS_DIR).filter(
    (f) => f.endsWith(".ts") && f !== "index.ts",
  );
  const all = [];
  for (const f of files) {
    const src = readFileSync(join(TOOLS_DIR, f), "utf8");
    let tools;
    try {
      tools = extractTools(src);
    } catch {
      tools = [];
    }
    for (const t of tools) all.push({ ...t, file: f });
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return all;
}

// ---- 3. Markdown zusammenbauen ------------------------------------------

async function main() {
  const tools = collectTools();

  const bundlePath = bundleAndLoadPrompts();
  const mod = await import(`file://${bundlePath}`);
  const buildSystemPrompt = mod.buildSystemPrompt;
  if (typeof buildSystemPrompt !== "function") {
    throw new Error("buildSystemPrompt nicht exportiert/gefunden");
  }
  // Zwei Varianten:
  //  - BASE: leeres Registry → nur Persona + Instruktionen (der fixe
  //    Boden, der JEDE Runde gesendet wird, unabhängig von geladenen Tools).
  //  - FULL: alle Tools „verfügbar" → der „Verfügbare Tools"-Namen-Block
  //    ist maximal lang (Worst-Case).
  const systemPrompt = buildSystemPrompt({ list: () => [] }, null, null);
  const systemPromptFull = buildSystemPrompt(
    { list: () => tools.map((t) => ({ name: t.name, description: t.description })) },
    null,
    null,
  );
  const toolListChars = systemPromptFull.length - systemPrompt.length;

  // Tool-Schemas als JSON serialisieren + Tokens schätzen. Der Agent
  // sendet pro Tool im Wesentlichen { name, description, input_schema }.
  let toolSchemaTotalChars = 0;
  const toolBlocks = [];
  for (const t of tools) {
    const payload = {
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? {},
    };
    const json = JSON.stringify(payload, null, 2);
    toolSchemaTotalChars += json.length;
    toolBlocks.push({ name: t.name, file: t.file, json, chars: json.length });
  }

  const sysChars = systemPrompt.length;
  const sysTokens = estTokens(systemPrompt);
  const toolsTokens = estTokens("x".repeat(toolSchemaTotalChars));
  const grandTokens = sysTokens + toolsTokens;

  const out = [];
  out.push("# AVA Chat-Agent — System-Prompt + Tool-Schemas");
  out.push("");
  out.push(
    "Auto-generiert von `services/desktop/scripts/dump-prompt-context.mjs`.",
  );
  out.push(
    `Stand: ${new Date().toISOString().slice(0, 10)} · Tools: ${tools.length}`,
  );
  out.push("");
  out.push("## Token-Überblick (grobe Schätzung, ~4 Zeichen/Token)");
  out.push("");
  out.push("| Block | Zeichen | ~Tokens |");
  out.push("| --- | ---: | ---: |");
  out.push(
    `| System-Prompt Grundgerüst (Persona + Instruktionen, IMMER gesendet) | ${fmt(sysChars)} | ${fmt(sysTokens)} |`,
  );
  out.push(
    `| „Verfügbare Tools\"-Block, wenn ALLE ${tools.length} Tools geladen | ${fmt(toolListChars)} | ${fmt(estTokens("x".repeat(toolListChars)))} |`,
  );
  out.push(
    `| Tool-Schemas, wenn ALLE ${tools.length} Tools geladen | ${fmt(toolSchemaTotalChars)} | ${fmt(toolsTokens)} |`,
  );
  out.push(
    `| **Theoretischer Worst-Case (alle Tools)** | | **~${fmt(grandTokens + estTokens("x".repeat(toolListChars)))}** |`,
  );
  out.push("");
  out.push(
    "> **Wichtig:** Tools werden *lazy* geladen — pro Aufgabe ist typisch nur " +
      "ein Bundle von ~5–10 Tools aktiv, nicht alle 160. Das **Grundgerüst** " +
      "oben (~" +
      fmt(sysTokens) +
      " Tokens) ist der fixe Boden jeder Runde; pro geladenem Tool kommen " +
      "dessen Schema (~siehe unten) + 1 Zeile im „Verfügbare Tools\"-Block dazu. " +
      "Mit Prompt-Caching kostet ein stabiles Präfix in Folge-Runden nur ~10 %. " +
      "Den Realwert (wie viel wirklich gecacht wird) siehst du in " +
      "Einstellungen → Verbrauch (Cache-Read).",
  );
  out.push("");
  out.push("---");
  out.push("");
  out.push("## 1. System-Prompt — Grundgerüst (ohne Tool-Liste)");
  out.push("");
  out.push(
    `_${fmt(sysChars)} Zeichen · ~${fmt(sysTokens)} Tokens · wird JEDE Runde gesendet._ ` +
      `Der dynamische „Verfügbare Tools\"-Block (1 Zeile je geladenem Tool) ` +
      `hängt unten an diesem Text.`,
  );
  out.push("");
  out.push("```text");
  out.push(systemPrompt);
  out.push("```");
  out.push("");
  out.push("---");
  out.push("");
  out.push(`## 2. Tool-Schemas (${tools.length})`);
  out.push("");
  out.push(
    "Pro Tool das exakte, was der Agent als Tool-Definition sendet " +
      "(`name` + `description` + `input_schema`). Absteigend nach Größe wäre " +
      "es einfacher zu optimieren — hier alphabetisch, mit Zeichen/Token je Tool.",
  );
  out.push("");
  // Größte zuerst auflisten für die Optimierungs-Sicht.
  const bySize = [...toolBlocks].sort((a, b) => b.chars - a.chars);
  out.push("### Größte Tool-Schemas (Top 20)");
  out.push("");
  out.push("| Tool | Datei | Zeichen | ~Tokens |");
  out.push("| --- | --- | ---: | ---: |");
  for (const b of bySize.slice(0, 20)) {
    out.push(
      `| \`${b.name}\` | ${b.file} | ${fmt(b.chars)} | ${fmt(estTokens("x".repeat(b.chars)))} |`,
    );
  }
  out.push("");
  out.push("### Alle Tool-Schemas (alphabetisch)");
  out.push("");
  for (const b of toolBlocks) {
    out.push(`#### \`${b.name}\`  ·  _${b.file}_  ·  ~${fmt(estTokens("x".repeat(b.chars)))} Tokens`);
    out.push("");
    out.push("```json");
    out.push(b.json);
    out.push("```");
    out.push("");
  }

  writeFileSync(OUT_PATH, out.join("\n"), "utf8");
  console.log(
    `[dump-prompt-context] wrote ${OUT_PATH}\n` +
      `  System-Prompt: ${fmt(sysChars)} Zeichen (~${fmt(sysTokens)} Tokens)\n` +
      `  Tool-Schemas:  ${tools.length} Tools, ${fmt(toolSchemaTotalChars)} Zeichen (~${fmt(toolsTokens)} Tokens)\n` +
      `  Summe Worst-Case: ~${fmt(grandTokens)} Tokens/Runde`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
