// S4 — Trust store + bundled auto-trust smoke test.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { SkillsTrustStore } from "../src/main/skills/trust-store.ts";
import {
  initSkills,
  vendorBundledSkills,
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

// --- 1. TrustStore round-trip ---
console.log("[test:skills:trust] TrustStore round-trip");
const tmp = mkdtempSync(join(tmpdir(), "ava-skills-trust-"));
const trustPath = join(tmp, "skills-trust.json");
try {
  const store = new SkillsTrustStore(trustPath);
  assert(!store.isTrusted("foo", "abc"), "Default: nichts ist getrusted");
  assert(store.getEntry("foo") === null, "Default: getEntry() === null");

  store.trust("foo", "deadbeef", ["company_get", "company_profile"]);
  assert(store.isTrusted("foo", "deadbeef"), "Nach trust: name+hash matchen");
  assert(
    !store.isTrusted("foo", "other-hash"),
    "Anderer Hash → nicht getrusted (no silent updates)",
  );

  const entry = store.getEntry("foo");
  assert(entry !== null, "getEntry liefert Eintrag");
  assert(
    Array.isArray(entry?.allowedTools) &&
      entry.allowedTools.includes("company_get"),
    "allowedTools werden mit gespeichert",
  );

  // Persist + re-open
  const reopened = new SkillsTrustStore(trustPath);
  assert(
    reopened.isTrusted("foo", "deadbeef"),
    "Nach Reopen: trust bleibt persistent",
  );

  reopened.revoke("foo");
  assert(!reopened.isTrusted("foo", "deadbeef"), "Nach revoke: nicht getrusted");
  assert(reopened.getEntry("foo") === null, "Nach revoke: getEntry === null");
  assert(existsSync(trustPath), "Datei existiert nach allen Schreibvorgängen");

  // Schema-Tolerance: v1-Eintrag ohne allowedTools darf nicht crashen
  writeFileSync(
    trustPath,
    JSON.stringify({
      version: 1,
      trusted: { legacy: { hash: "h", trustedAt: 1 } },
    }),
  );
  const tolerant = new SkillsTrustStore(trustPath);
  assert(tolerant.isTrusted("legacy", "h"), "v1-Eintrag wird gelesen");
  assert(
    Array.isArray(tolerant.getEntry("legacy")?.allowedTools),
    "v1-Eintrag → allowedTools=[] (forward-compat)",
  );
} finally {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

// --- 2. Bundled-skills auto-trust on vendor ---
console.log("[test:skills:trust] vendorBundledSkills auto-trust");
const tmp2 = mkdtempSync(join(tmpdir(), "ava-skills-vendor-"));
try {
  // Build a fake "bundled" dir with a starter skill.
  const bundled = join(tmp2, "bundled");
  const userDir = join(tmp2, "user");
  mkdirSync(join(bundled, "demo-skill"), { recursive: true });
  const skillBody = `---
name: demo-skill
description: Demo-Skill für den Auto-Trust-Test.
language: de
b2b-scope: internal
allowed-tools:
  - company_get
---

# Demo
Hallo Welt.
`;
  writeFileSync(join(bundled, "demo-skill", "SKILL.md"), skillBody);

  const trust = new SkillsTrustStore(join(tmp2, "trust.json"));
  vendorBundledSkills(bundled, userDir, trust);

  const target = join(userDir, "demo-skill", "SKILL.md");
  assert(existsSync(target), "Skill wurde vendoriert");

  const written = readFileSync(target, "utf8");
  const hash = createHash("sha256").update(written, "utf8").digest("hex");
  assert(
    trust.isTrusted("demo-skill", hash),
    "Vendored skill ist auto-getrusted mit seinem on-disk Hash",
  );
  const entry = trust.getEntry("demo-skill");
  assert(
    entry?.allowedTools?.includes("company_get"),
    "Auto-Trust übernimmt allowed-tools aus Frontmatter",
  );
} finally {
  try {
    rmSync(tmp2, { recursive: true, force: true });
  } catch {}
}

// --- 3. End-to-end: loader sieht trust state nach initSkills ---
console.log("[test:skills:trust] initSkills + Loader-Integration");
const tmp3 = mkdtempSync(join(tmpdir(), "ava-skills-init-"));
try {
  const userDir = join(tmp3, "user");
  mkdirSync(join(userDir, "untrusted-one"), { recursive: true });
  const u = `---
name: untrusted-one
description: Ein noch nicht freigegebenes Skill.
language: de
b2b-scope: internal
---

# Body
`;
  writeFileSync(join(userDir, "untrusted-one", "SKILL.md"), u);

  const trust = new SkillsTrustStore(join(tmp3, "trust.json"));
  const store = await initSkills(null, {
    userDir,
    workspaceDir: null,
    watch: false,
    trustStore: trust,
    bundledDir: null,
  });
  const got = store.get("untrusted-one");
  assert(got !== undefined, "Skill wurde geladen");
  assert(got?.trust === "untrusted", "Status: untrusted (kein trust-Eintrag)");

  // Trust it
  trust.trust("untrusted-one", got.hash, got.allowedTools);
  await store.reload();
  const got2 = store.get("untrusted-one");
  assert(got2?.trust === "trusted", "Nach trust(): Status flippt auf trusted");

  // Modify the file → modified
  writeFileSync(
    join(userDir, "untrusted-one", "SKILL.md"),
    u.replace("# Body", "# Body geändert"),
  );
  await store.reload();
  const got3 = store.get("untrusted-one");
  assert(got3?.trust === "modified", "Nach Edit: Status flippt auf modified");
  assert(
    Array.isArray(got3?.previouslyTrustedAllowedTools),
    "modified bringt previouslyTrustedAllowedTools mit",
  );

  store.stop();
} finally {
  try {
    rmSync(tmp3, { recursive: true, force: true });
  } catch {}
}

if (failures.length > 0) {
  console.error(`\n[test:skills:trust] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:trust] Alle Asserts grün.`);
}
