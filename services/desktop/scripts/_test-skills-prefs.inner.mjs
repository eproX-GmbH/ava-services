// S3 — Inner runner for the prefs-store + getBody smoke test.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { SkillsPrefsStore } from "../src/main/skills/skills-prefs-store.ts";
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

// --- 1. SkillsPrefsStore round-trips ---

console.log("[test:skills:prefs] PrefsStore round-trip");
const tmp = mkdtempSync(join(tmpdir(), "ava-skills-prefs-"));
const prefsPath = join(tmp, "skills-prefs.json");
try {
  const store = new SkillsPrefsStore(prefsPath);
  assert(store.isEnabled("outreach-draft-de"), "Default: skill enabled");
  assert(
    store.get().disabled.length === 0,
    "Default: keine deaktivierten Skills",
  );

  let lastEvent = null;
  store.on("changed", (prefs) => {
    lastEvent = prefs;
  });

  store.setEnabled("outreach-draft-de", false);
  assert(
    !store.isEnabled("outreach-draft-de"),
    "Nach setEnabled(false): isEnabled === false",
  );
  assert(
    lastEvent !== null &&
      Array.isArray(lastEvent.disabled) &&
      lastEvent.disabled.includes("outreach-draft-de"),
    "'changed'-Event feuert mit aktualisierten Prefs",
  );
  assert(existsSync(prefsPath), "Datei wurde geschrieben");
  const raw = JSON.parse(readFileSync(prefsPath, "utf8"));
  assert(
    Array.isArray(raw.disabled) && raw.disabled.includes("outreach-draft-de"),
    "Datei enthält disabled-Liste",
  );

  // Re-open and verify persistence
  const store2 = new SkillsPrefsStore(prefsPath);
  assert(
    !store2.isEnabled("outreach-draft-de"),
    "Nach Neuöffnen: disabled bleibt persistent",
  );
  assert(
    store2.isEnabled("qualifying-fragebogen"),
    "Andere Skills bleiben enabled",
  );

  store2.setEnabled("outreach-draft-de", true);
  assert(
    store2.isEnabled("outreach-draft-de"),
    "setEnabled(true) entfernt aus disabled-Liste",
  );
  assert(
    store2.get().disabled.length === 0,
    "Liste leer nach Wieder-Aktivieren",
  );
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

// --- 2. SkillStore — body access + gate-failing surfaces ---

console.log("[test:skills:prefs] SkillStore body access");
const skillStore = await initSkills(null, {
  userDir: fixturesDir,
  workspaceDir: null,
  watch: false,
});

const outreach = skillStore.get("outreach-draft");
assert(outreach !== undefined, "get('outreach-draft') liefert Record");
assert(
  typeof outreach?.body === "string" && outreach.body.length > 0,
  "outreach.body ist nicht leer",
);
assert(
  outreach?.body.startsWith("# Outreach Draft"),
  "outreach.body beginnt mit Markdown-H1",
);
assert(
  outreach?.gateSatisfied === true,
  "outreach.gateSatisfied === true (kein requires-Block)",
);

const hubspot = skillStore.get("hubspot-enrich");
assert(hubspot !== undefined, "hubspot-enrich (gated) bleibt sichtbar");
assert(
  hubspot?.gateSatisfied === false,
  "hubspot-enrich.gateSatisfied === false",
);
assert(
  typeof hubspot?.gateReason === "string" && hubspot.gateReason.length > 0,
  "hubspot-enrich.gateReason ist gesetzt",
);

const missing = skillStore.get("does-not-exist");
assert(missing === undefined, "get() für unbekanntes Skill -> undefined");

skillStore.stop();

if (failures.length > 0) {
  console.error(`\n[test:skills:prefs] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:prefs] Alle Asserts grün.`);
}
