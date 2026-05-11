// S4 — Save-module smoke test.
//
// Pure round-trip: build a payload → buildSkillFile → parse + validate
// the resulting bytes → assert frontmatter equals the input. Then run
// saveSkillToDisk against a tmpdir and confirm initSkills picks the
// skill up.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  buildSkillFile,
  saveSkillToDisk,
} from "../src/main/skills/save.ts";
import { parseSkillFile } from "../src/main/skills/parser.ts";
import { frontmatterSchema } from "../src/main/skills/schema.ts";
import {
  initSkills,
  SkillsTrustStore,
} from "../src/main/skills/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const failures = [];
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

const payload = {
  frontmatter: {
    name: "test-skill",
    description:
      "Testet das Speichern eines selbst geschriebenen Skills im Editor.",
    language: "de",
    "b2b-scope": "internal",
    "allowed-tools": ["company_get", "company_profile"],
    "requires-user-confirm": true,
    "disable-model-invocation": false,
    "user-invocable": true,
    arguments: [
      { name: "company-id", description: "AVA companyId", required: true },
    ],
  },
  body: "# Test Skill\n\nProsa mit `${company-id}`.",
};

// --- 1. buildSkillFile round-trip (pure) ---
console.log("[test:skills:save] buildSkillFile Round-Trip");
const built = buildSkillFile(payload);
assert(built.dirName === "test-skill", "dirName entspricht frontmatter.name");
assert(
  built.contents.startsWith("---\n"),
  "contents beginnt mit YAML-Delimiter",
);

const parsed = parseSkillFile(built.contents);
const validated = await frontmatterSchema.validate(parsed.frontmatter, {
  abortEarly: true,
});
assert(validated.name === payload.frontmatter.name, "name round-trips");
assert(
  validated.description === payload.frontmatter.description,
  "description round-trips",
);
assert(
  validated["b2b-scope"] === payload.frontmatter["b2b-scope"],
  "b2b-scope round-trips",
);
assert(
  Array.isArray(validated["allowed-tools"]) &&
    validated["allowed-tools"].length === 2,
  "allowed-tools round-trip (Länge 2)",
);
assert(
  validated["requires-user-confirm"] === true,
  "requires-user-confirm round-trips",
);
assert(
  validated.arguments?.length === 1 &&
    validated.arguments[0].name === "company-id",
  "Argumente round-trippen",
);
assert(
  parsed.body.includes("Test Skill") && parsed.body.includes("${company-id}"),
  "Body bleibt erhalten",
);

// --- 2. saveSkillToDisk + Loader sieht den neuen Skill ---
console.log("[test:skills:save] saveSkillToDisk + initSkills");
const tmp = mkdtempSync(join(tmpdir(), "ava-skills-save-"));
try {
  const userDir = join(tmp, "skills");
  const res = await saveSkillToDisk(userDir, payload);
  assert(res.ok === true, "saveSkillToDisk erfolgreich");
  assert(res.name === "test-skill", "ergebnis.name === payload.frontmatter.name");
  assert(
    res.path?.endsWith(join("test-skill", "SKILL.md")),
    "Pfad zeigt auf <userDir>/test-skill/SKILL.md",
  );
  const written = readFileSync(res.path, "utf8");
  assert(
    written === built.contents,
    "Datei-Inhalt === buildSkillFile-Output",
  );

  const trust = new SkillsTrustStore(join(tmp, "trust.json"));
  const store = await initSkills(null, {
    userDir,
    workspaceDir: null,
    watch: false,
    trustStore: trust,
    bundledDir: null,
  });
  const got = store.get("test-skill");
  assert(got !== undefined, "Loader findet das gespeicherte Skill");
  assert(
    got?.allowedTools.includes("company_get"),
    "allowed-tools landen unverändert beim Loader",
  );
  assert(
    got?.trust === "untrusted",
    "Frisch geschriebenes Skill ist initial untrusted (Trust setzt der IPC-Handler)",
  );
  store.stop();

  // --- 3. Server-side Validierung: ungültiger Name wird abgewiesen ---
  const bad = await saveSkillToDisk(userDir, {
    frontmatter: { ...payload.frontmatter, name: "Bad Name!" },
    body: payload.body,
  });
  assert(bad.ok === false, "Ungültiger Name → ok: false");
  assert(
    typeof bad.error === "string" && bad.error.length > 0,
    "Fehlermeldung gesetzt",
  );
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

if (failures.length > 0) {
  console.error(`\n[test:skills:save] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:save] Alle Asserts grün.`);
}
