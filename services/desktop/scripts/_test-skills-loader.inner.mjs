// Inner runner — imported through the tsx loader so it can pull in
// `.ts` source from src/main/skills/ without a build step.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { initSkills } from "../src/main/skills/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, "..", "src", "main", "skills", "__fixtures__");

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

console.log(`[test:skills] Fixtures-Verzeichnis: ${fixturesDir}`);

const store = await initSkills(null, {
  userDir: fixturesDir,
  workspaceDir: null,
  watch: false,
});

const skills = store.list();
const names = skills.map((s) => s.name).sort();
const errors = store.getErrors();

console.log(`[test:skills] geladen: ${names.join(", ") || "(keine)"}`);
console.log(`[test:skills] Fehler: ${errors.length}`);

assert(skills.length === 2, `genau 2 Skills geladen (war: ${skills.length})`);
assert(
  names.includes("outreach-draft"),
  "outreach-draft (valid-outreach) wurde geladen",
);
assert(
  names.includes("qualifying-deep"),
  "qualifying-deep (valid-full) wurde geladen",
);
assert(
  !names.includes("missing-scope"),
  "missing-scope wurde NICHT geladen",
);
assert(!names.includes("bad-scope"), "bad-scope wurde NICHT geladen");
assert(
  !names.includes("broken-yaml"),
  "broken-yaml wurde NICHT geladen",
);
assert(
  !names.includes("hubspot-enrich"),
  "hubspot-enrich (gated) wurde NICHT geladen",
);

const outreach = store.get("outreach-draft");
assert(outreach !== undefined, "store.get('outreach-draft') liefert Record");
if (outreach) {
  assert(outreach.b2bScope === "outreach", "outreach.b2bScope === 'outreach'");
  assert(outreach.language === "de", "outreach.language default 'de'");
  assert(
    outreach.allowedTools.length === 0,
    "outreach.allowedTools default []",
  );
  assert(
    outreach.requiresUserConfirm === true,
    "outreach.requiresUserConfirm default true",
  );
  assert(
    typeof outreach.hash === "string" && outreach.hash.length === 64,
    "outreach.hash ist sha256-hex (64 Zeichen)",
  );
  assert(outreach.scope === "user", "outreach.scope === 'user'");
  assert(
    outreach.body.startsWith("# Outreach Draft"),
    "outreach.body beginnt mit Markdown-H1",
  );
}

const qualifying = store.get("qualifying-deep");
if (qualifying) {
  assert(
    qualifying.allowedTools.length === 3,
    "qualifying.allowedTools hat 3 Einträge",
  );
  assert(
    qualifying.arguments.length === 2,
    "qualifying.arguments hat 2 Einträge",
  );
  assert(
    qualifying.arguments[0]?.required === true,
    "qualifying.arguments[0].required === true",
  );
  assert(
    qualifying.requiresUserConfirm === false,
    "qualifying.requiresUserConfirm === false",
  );
}

// At least 3 of the 4 invalid fixtures should be in errors[] (gated
// skill is skipped via gate-log path, not validation, so it doesn't
// land in errors[] — check separately).
assert(
  errors.length >= 3,
  `mindestens 3 Validierungsfehler protokolliert (war: ${errors.length})`,
);
const errorPaths = errors.map((e) => e.path).join("\n");
for (const expected of [
  "invalid-missing-scope",
  "invalid-bad-scope",
  "invalid-yaml",
]) {
  assert(
    errorPaths.includes(expected),
    `Fehler erwähnt Fixture '${expected}'`,
  );
}

store.stop();

if (failures.length > 0) {
  console.error(`\n[test:skills] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills] Alle Asserts grün.`);
}
