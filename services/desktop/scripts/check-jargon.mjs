#!/usr/bin/env node
// Jargon-Pruefung fuer die Einstellungen (docs/PLAN_EINSTELLUNGEN_UI.md §5 + E6).
//
// Die Einstellungen richten sich an Vertriebler. Begriffe aus dem Glossar in §5
// duerfen in sichtbaren Texten unter routes/settings, Settings.tsx, SettingsSkills.tsx
// und den drei Einstellungs-Komponenten (Storage, Diagnose, DangerZone) nicht mehr
// vorkommen. Erlaubt bleiben sie nur innerhalb von <details> (dort sitzt
// "Technische Details") und in `technik={...}`-Props der EinstellungsKarte.
//
// Gleiche Mechanik wie check-german.mjs: JSX-Textknoten und die sichtbaren
// Attribute (placeholder, title, aria-label, alt, label) werden per Regex gelesen.
// Kommentare, Imports und <details>-Bloecke werden vorher entfernt.
//
// Aufruf: node scripts/check-jargon.mjs            → Fehlerliste, Exit 1 bei Treffern
//         node scripts/check-jargon.mjs --zaehlen  → nur Zusammenfassung je Begriff

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN = [
  "src/renderer/src/routes/settings",
  "src/renderer/src/routes/Settings.tsx",
  "src/renderer/src/routes/SettingsSkills.tsx",
  "src/renderer/src/components/StorageSection.tsx",
  "src/renderer/src/components/DiagnoseSection.tsx",
  "src/renderer/src/components/DangerZoneSection.tsx",
  // Fehlertexte, die die Einstellungen anzeigen.
  "src/renderer/src/lib/updater-error.ts",
  "src/renderer/src/lib/producer-error.ts",
];

// Begriffe aus §5, Spalte "Heute im Text". Jeder Eintrag ist ein Regex-Fragment,
// gematcht ohne Beachtung der Gross-/Kleinschreibung an Wortgrenzen. Zusammengesetzte
// Woerter ("Pipeline-Stufe", "Heartbeat-Lauf") zaehlen mit, deshalb sind Bindestriche
// links und rechts erlaubt.
const JARGON = [
  "Pipeline", "Producer", "Stage", "Zelle",
  "Heartbeat", "Sweep", "Tick", "Loop",
  "Cadence",
  "Rubric", "Judge", "Topics", "Kandidat(?:en)?",
  "Tokens?", "Input", "Output", "Cache[- ]?Read", "Cache",
  "Tier", "Stufe [CBAS]\\b",
  "API[- ]?Key", "API[- ]Schl[üu]ssel",
  "Endpoint", "Port", "PID", "Queue", "in flight",
  "AMQP", "Gateway", "Broker",
  "IMAP", "SMTP", "TLS", "Host",
  "Allowlist", "Kill[- ]?Switch", "Auto[- ]?Triage", "Triage", "trusted",
  "RCPT", "Catch[- ]?all", "Baseline",
  "OAuth",
  "MCP", "Instanz(?:en)?",
  "Ollama[- ]Laufzeit", "Whisper", "Binary", "Deployment",
  "Vektorsuche", "Prompt[- ]?Caching", "Entity[- ]?Resolution", "Prompt",
  "Scan(?:nen|s)?",
  "Seats?",
  "Audit[- ]?Trail", "Events?",
  "Push",
  "LLM", "Embedding", "Worker", "Cron", "Payload", "Backend", "Frontend", "Debug",
  "Realtime", "Relay",
];

// Erlaubte Fundstellen: Begriffe, die der Anbieter selbst so nennt, oder die als
// Produktname gelten. Steht einer dieser Teilstrings im Text, wird der Text nicht
// gemeldet.
const ERLAUBT = [
  "BotFather",             // Telegram nennt es so
  "Continue with ChatGPT", // OpenAI-Pflichttext
  "Ollama",                // Produktname allein ist ok, nur "Ollama-Laufzeit" nicht
  "SKILL.md",
  "„API Key“",             // Zitat eines fremden Feldnamens (Obsidian-Plugin)
  "imap.", "smtp.",        // Beispiel-Servernamen in Platzhaltern
];
// Feldnamen beim Einrichten (§5: "bleibt nur ... Feldnamen beim Einrichten").
const ERLAUBTE_FELDNAMEN = new Set(["Port", "Server (IMAP)", "Server (SMTP)"]);

const STRIP_LINE_COMMENT = /\/\/[^\n]*/g;
const STRIP_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRIP_IMPORT = /^\s*import[\s\S]*?from\s+["'][^"']+["'];?$/gm;
// <details>…</details> ohne Verschachtelung; "Technische Details" liegen hier.
const STRIP_DETAILS = /<details\b[\s\S]*?<\/details>/g;
// technik={...} der EinstellungsKarte: ein JSX-Prop mit geschweiften Klammern.
// Wir schneiden ab "technik={" bis zur passenden schliessenden Klammer.
function stripTechnikProps(src) {
  let out = "";
  let i = 0;
  for (;;) {
    const at = src.indexOf("technik={", i);
    if (at < 0) { out += src.slice(i); break; }
    out += src.slice(i, at);
    let depth = 0;
    let j = at + "technik=".length;
    for (; j < src.length; j++) {
      const c = src[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
    }
    i = j;
  }
  return out;
}

// JSX-Text zwischen > und <; eingestreute {" "} zaehlen zum Text.
const JSX_TEXT_RE = />((?:[^<>{}]|\{"\s*"\})*?)</g;
const ATTR_RE = /\b(placeholder|title|aria-label|alt|label)\s*=\s*["']([^"']*)["']/g;
// String-Literale in JSX-Ausdruecken, z. B. {cond ? "Pipeline laeuft" : "…"} oder
// title={"…"}: wir lesen auch doppelt/einfach gequotete Literale innerhalb von
// JSX-Kindern, die direkt in {…} stehen.
const JSX_EXPR_STRING_RE = /\{\s*(?:[^{}]*?\?\s*)?["']([^"'\n]{6,})["']/g;
// Laengere String-Literale mit Leerzeichen (Hinweistexte, Fehlertexte, Konstanten):
// Code-Strings sind kurz oder ohne Leerzeichen, Nutzertexte nicht.
const LONG_STRING_RE = /["']([^"'\n]{30,})["']/g;

const patterns = JARGON.map((frag) => ({
  frag,
  re: new RegExp(`(?:^|[^A-Za-zÄÖÜäöüß])(?:[A-Za-zÄÖÜäöüß]+-)?${frag}(?:-[A-Za-zÄÖÜäöüß]+)?(?=$|[^A-Za-zÄÖÜäöüß])`, "i"),
}));

function treffer(text) {
  if (ERLAUBT.some((e) => text.includes(e))) return [];
  if (ERLAUBTE_FELDNAMEN.has(text)) return [];
  return patterns.filter((p) => p.re.test(text)).map((p) => p.frag);
}

function scanFile(absPath) {
  const raw = readFileSync(absPath, "utf8");
  const src = stripTechnikProps(
    raw
      .replace(STRIP_BLOCK_COMMENT, " ")
      .replace(STRIP_LINE_COMMENT, " ")
      .replace(STRIP_IMPORT, " ")
      .replace(STRIP_DETAILS, " "),
  );
  const findings = [];
  for (const re of [JSX_TEXT_RE, ATTR_RE, JSX_EXPR_STRING_RE, LONG_STRING_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const literal = (re === ATTR_RE ? m[2] : m[1]) ?? "";
      const text = literal.trim();
      if (text.length < 4) continue;
      if (re === JSX_TEXT_RE && /[=(){};]/.test(text)) continue;
      // className-Werte und Pfade sind kein Text.
      if (re !== JSX_TEXT_RE && re !== ATTR_RE && /^[a-z0-9_:./-]+$/i.test(text)) continue;
      // className-Listen ("muted small heartbeat-tick__detail") und Code-Fragmente.
      if (re !== JSX_TEXT_RE && /^[a-z0-9_ -]+$/.test(text) && /[_-]/.test(text)) continue;
      if (re === LONG_STRING_RE && /[={}()[\]]/.test(text)) continue;
      // Objekt-Literale in Template-Strings: "port: 993, secure: true".
      if (re === LONG_STRING_RE && /\b\w+: (?:\d|true|false)/.test(text)) continue;
      // Lange Literale nur, wenn sie wie ein Satz aussehen (mindestens drei Woerter).
      if (re === LONG_STRING_RE && text.split(/\s+/).length < 3) continue;
      const hits = treffer(text);
      if (hits.length === 0) continue;
      const line = src.slice(0, m.index).split("\n").length;
      findings.push({ line, text, hits });
    }
  }
  return findings;
}

function* walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const name of readdirSync(p)) yield* walk(join(p, name));
  } else if (p.endsWith(".tsx") || p.endsWith(".ts")) {
    yield p;
  }
}

const nurZaehlen = process.argv.includes("--zaehlen");
const report = [];
const jeBegriff = new Map();
let total = 0;
for (const rel of SCAN) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const findings = scanFile(file);
    if (findings.length === 0) continue;
    report.push({ file: relative(ROOT, file), findings });
    total += findings.length;
    for (const f of findings) for (const h of f.hits) jeBegriff.set(h, (jeBegriff.get(h) ?? 0) + 1);
  }
}

if (total === 0) {
  console.log("[lint:jargon] OK — kein Fachjargon in sichtbaren Einstellungs-Texten.");
  process.exit(0);
}

if (nurZaehlen) {
  console.log(`[lint:jargon] ${total} Fundstelle(n) in ${report.length} Datei(en):`);
  for (const [b, n] of [...jeBegriff.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${b}`);
  for (const r of report) console.log(`  ${String(r.findings.length).padStart(3)}  ${r.file}`);
  process.exit(1);
}

console.error(`[lint:jargon] ${total} Fundstelle(n) mit Fachjargon in sichtbaren Texten:`);
for (const { file, findings } of report) {
  console.error(`\n  ${file}`);
  for (const { line, text, hits } of findings) {
    const kurz = text.length > 110 ? text.slice(0, 107) + "…" : text;
    console.error(`    L${line} [${hits.join(", ")}]: ${JSON.stringify(kurz)}`);
  }
}
console.error(
  "\n  Begriff durch die Fassung aus docs/PLAN_EINSTELLUNGEN_UI.md §5 ersetzen oder den Text unter <details> (Technische Details) legen.",
);
process.exit(1);
