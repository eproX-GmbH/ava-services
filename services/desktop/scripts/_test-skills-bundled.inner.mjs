// S6 — Inner runner for the bundled-skills smoke test.
//
// Points the loader at `services/desktop/resources/skills/` directly
// and asserts all three starter skills validate cleanly. Catches
// frontmatter regressions when someone edits a bundled SKILL.md.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initSkills } from "../src/main/skills/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bundledDir = join(here, "..", "resources", "skills");

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

console.log(`[test:skills:bundled] Quelle: ${bundledDir}`);

const store = await initSkills(null, {
  userDir: bundledDir,
  workspaceDir: null,
  watch: false,
  // Permissive gate evaluator: bundled skills declare no `requires`
  // today, but if any get added later we don't want a smoke-test
  // false-negative just because CRM/Ollama aren't running on CI.
  evaluateGate: () => true,
});

const skills = store.list();
const names = skills.map((s) => s.name).sort();
const errors = store.getErrors();

console.log(`[test:skills:bundled] geladen: ${names.join(", ") || "(keine)"}`);
console.log(`[test:skills:bundled] Fehler: ${errors.length}`);

const expected = [
  "outreach-draft-de",
  "qualifying-fragebogen",
  "wettbewerber-uebersicht",
];

assert(
  errors.length === 0,
  `keine Validierungsfehler (war: ${errors.length})`,
);
assert(
  skills.length === expected.length,
  `genau ${expected.length} Skills geladen (war: ${skills.length})`,
);
for (const name of expected) {
  assert(names.includes(name), `Starter-Skill '${name}' geladen`);
}

const outreach = store.get("outreach-draft-de");
if (outreach) {
  assert(outreach.b2bScope === "outreach", "outreach-draft-de.b2bScope === 'outreach'");
  assert(
    outreach.requiresUserConfirm === true,
    "outreach-draft-de.requiresUserConfirm === true",
  );
  assert(
    outreach.allowedTools.length > 0 &&
      outreach.allowedTools.every((t) => !/send|write|post|create/i.test(t)),
    "outreach-draft-de.allowedTools enthält nur Read-Tools",
  );
}

const qual = store.get("qualifying-fragebogen");
if (qual) {
  assert(qual.b2bScope === "qualifying", "qualifying-fragebogen.b2bScope === 'qualifying'");
  assert(
    qual.requiresUserConfirm === false,
    "qualifying-fragebogen.requiresUserConfirm === false",
  );
}

const wett = store.get("wettbewerber-uebersicht");
if (wett) {
  assert(wett.b2bScope === "competitive", "wettbewerber-uebersicht.b2bScope === 'competitive'");
  assert(
    wett.requiresUserConfirm === false,
    "wettbewerber-uebersicht.requiresUserConfirm === false",
  );
}

store.stop();

if (failures.length > 0) {
  console.error(`\n[test:skills:bundled] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:bundled] Alle Asserts grün.`);
}
