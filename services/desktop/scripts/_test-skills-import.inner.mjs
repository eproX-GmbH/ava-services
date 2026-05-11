// S5 — Import/export smoke test.
//
// Covers:
//  1. Export → re-import round trip (single skill): assert hash matches.
//  2. Import zip with two skills (one valid, one malformed YAML):
//     one staged, one in conflicts.
//  3. Import overwrite that ADDS an allowed-tool: assert
//     previousAllowedTools populated, action = overwrite-trusted,
//     diff shows the new tool.
//  4. Import a SKILL.md body directly: one staged.
//  5. Commit step: write to tmp userData dir, assert files on disk.
//  6. Commit with "deferred" trust REVOKES a prior trust entry (the
//     re-confirm-on-change loophole-closer).

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import {
  exportSkillToZipFile,
  exportAllSkillsToZipFile,
  stageImportZip,
  stageImportMarkdown,
  commitImport,
} from "../src/main/skills/import-export.ts";
import { SkillsTrustStore } from "../src/main/skills/trust-store.ts";

const failures = [];
function assert(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const SAMPLE_BODY = `---
name: outreach-sample
description: Beispielskill für Outreach im Round-Trip-Test.
language: de
b2b-scope: outreach
allowed-tools:
  - company_get
  - company_profile
requires-user-confirm: true
disable-model-invocation: false
user-invocable: true
---

# Outreach Sample

Body-Inhalt.
`;

const MALFORMED_BODY = `---
name: broken
description: ohne korrekten b2b-scope
language: de
b2b-scope: nichtErlaubt
---

# Broken
`;

const tmpRoot = mkdtempSync(join(tmpdir(), "ava-skills-impexp-"));
try {
  // --- 1. Single-skill export round trip ---
  console.log("[test:skills:import] Single-Skill Export-Round-Trip");
  const userSkillsDir = join(tmpRoot, "user-skills");
  mkdirSync(join(userSkillsDir, "outreach-sample"), { recursive: true });
  const srcPath = join(userSkillsDir, "outreach-sample", "SKILL.md");
  writeFileSync(srcPath, SAMPLE_BODY, "utf8");
  const srcHash = sha256(readFileSync(srcPath, "utf8"));

  const fakeLoaded = {
    name: "outreach-sample",
    sourcePath: srcPath,
    hash: srcHash,
    b2bScope: "outreach",
    scope: "user",
  };
  const exportPath = join(tmpRoot, "outreach-sample.zip");
  const exportRes = exportSkillToZipFile(fakeLoaded, exportPath);
  assert(exportRes.ok === true, "Export erfolgreich");
  assert(existsSync(exportPath), "Zip-Datei wurde geschrieben");

  // Verify zip contents.
  const zip = new AdmZip(exportPath);
  const entries = zip.getEntries();
  assert(
    entries.length === 1 && entries[0].entryName === "SKILL.md",
    "Zip enthält genau eine Datei 'SKILL.md'",
  );
  const exportedBytes = entries[0].getData().toString("utf8");
  assert(
    sha256(exportedBytes) === srcHash,
    "Hash der exportierten Bytes matcht Originaldatei",
  );

  // --- 2. Re-import the exported zip into a fresh staging area ---
  console.log("[test:skills:import] Re-Import Round-Trip");
  const reimportUserDir = join(tmpRoot, "reimport-user-skills");
  mkdirSync(reimportUserDir, { recursive: true });
  const reimportTrust = new SkillsTrustStore(
    join(tmpRoot, "reimport-trust.json"),
  );
  const reimport = await stageImportZip(exportPath, {
    userSkillsDir: reimportUserDir,
    trustStore: reimportTrust,
    stagingRoot: tmpRoot,
  });
  assert(reimport.ok === true, "Re-Import staging ok");
  if (reimport.ok) {
    assert(reimport.staged.length === 1, "Genau ein Skill gestaged");
    assert(reimport.conflicts.length === 0, "Keine Konflikte");
    assert(
      reimport.staged[0].name === "outreach-sample",
      "Skill-Name aus Frontmatter übernommen",
    );
    assert(
      reimport.staged[0].action === "create",
      "Action ist 'create' (Ziel existiert noch nicht)",
    );
    assert(
      reimport.staged[0].hash === srcHash,
      "Staging-Hash matcht Originalhash",
    );
  }

  // --- 3. Import zip with one valid + one malformed skill ---
  console.log("[test:skills:import] Zip mit valid + malformed");
  const mixedZipPath = join(tmpRoot, "mixed.zip");
  const mixedZip = new AdmZip();
  mixedZip.addFile("good/SKILL.md", Buffer.from(SAMPLE_BODY, "utf8"));
  mixedZip.addFile("bad/SKILL.md", Buffer.from(MALFORMED_BODY, "utf8"));
  mixedZip.writeZip(mixedZipPath);

  const mixedUserDir = join(tmpRoot, "mixed-user-skills");
  mkdirSync(mixedUserDir, { recursive: true });
  const mixedTrust = new SkillsTrustStore(join(tmpRoot, "mixed-trust.json"));
  const mixedRes = await stageImportZip(mixedZipPath, {
    userSkillsDir: mixedUserDir,
    trustStore: mixedTrust,
    stagingRoot: tmpRoot,
  });
  assert(mixedRes.ok === true, "Mixed-Zip staging ok");
  if (mixedRes.ok) {
    assert(
      mixedRes.staged.length === 1,
      "Genau ein gültiges Skill gestaged (mixed)",
    );
    assert(
      mixedRes.conflicts.length === 1,
      "Genau ein Konflikt (mixed)",
    );
  }

  // --- 4. Overwrite that adds an allowed-tool ---
  console.log("[test:skills:import] Overwrite mit neuem allowed-tool");
  const ovUserDir = join(tmpRoot, "overwrite-user-skills");
  mkdirSync(join(ovUserDir, "outreach-sample"), { recursive: true });
  writeFileSync(
    join(ovUserDir, "outreach-sample", "SKILL.md"),
    SAMPLE_BODY,
    "utf8",
  );
  const ovTrust = new SkillsTrustStore(join(tmpRoot, "overwrite-trust.json"));
  // Pre-trust the existing on-disk file with only one tool.
  ovTrust.trust(
    "outreach-sample",
    sha256(SAMPLE_BODY),
    ["company_get"],
  );

  // New body adds `company_contacts` to allowed-tools.
  const newBody = SAMPLE_BODY.replace(
    "  - company_profile",
    "  - company_profile\n  - company_contacts",
  );
  const ovZipPath = join(tmpRoot, "overwrite.zip");
  const ovZip = new AdmZip();
  ovZip.addFile("SKILL.md", Buffer.from(newBody, "utf8"));
  ovZip.writeZip(ovZipPath);

  const ovRes = await stageImportZip(ovZipPath, {
    userSkillsDir: ovUserDir,
    trustStore: ovTrust,
    stagingRoot: tmpRoot,
  });
  assert(ovRes.ok === true, "Overwrite staging ok");
  if (ovRes.ok) {
    const entry = ovRes.staged[0];
    assert(
      entry.action === "overwrite-trusted",
      `action === overwrite-trusted (got: ${entry.action})`,
    );
    assert(
      Array.isArray(entry.previousAllowedTools) &&
        entry.previousAllowedTools.includes("company_get"),
      "previousAllowedTools enthält den bisher freigegebenen Tool",
    );
    assert(
      entry.allowedTools.includes("company_contacts"),
      "Neues allowed-tool ist im Staging-Payload",
    );
    const added = entry.allowedTools.filter(
      (t) => !(entry.previousAllowedTools ?? []).includes(t),
    );
    assert(
      added.includes("company_contacts"),
      "Diff: company_contacts ist 'neu hinzugekommen'",
    );
  }

  // --- 5. Markdown direct import ---
  console.log("[test:skills:import] importMarkdown direkt");
  const mdUserDir = join(tmpRoot, "md-user-skills");
  mkdirSync(mdUserDir, { recursive: true });
  const mdTrust = new SkillsTrustStore(join(tmpRoot, "md-trust.json"));
  const mdRes = await stageImportMarkdown(SAMPLE_BODY, {
    userSkillsDir: mdUserDir,
    trustStore: mdTrust,
    stagingRoot: tmpRoot,
  });
  assert(mdRes.ok === true, "Markdown-Import staging ok");
  if (mdRes.ok) {
    assert(mdRes.staged.length === 1, "Markdown-Import: ein Skill gestaged");
    assert(
      mdRes.staged[0].name === "outreach-sample",
      "Markdown-Import: Name aus Frontmatter",
    );
  }

  // --- 6. Commit writes files + auto-trust ---
  console.log("[test:skills:import] commitImport schreibt + auto-trust");
  if (mdRes.ok) {
    const commitRes = commitImport(
      {
        stagingId: mdRes.stagingId,
        staged: [{ name: "outreach-sample", trust: "auto" }],
      },
      {
        userSkillsDir: mdUserDir,
        trustStore: mdTrust,
        stagingRoot: tmpRoot,
      },
    );
    assert(commitRes.ok === true, "Commit erfolgreich");
    if (commitRes.ok) {
      assert(
        commitRes.written.length === 1,
        "Genau eine Datei geschrieben",
      );
      const target = join(mdUserDir, "outreach-sample", "SKILL.md");
      assert(existsSync(target), "Zieldatei existiert");
      const onDisk = readFileSync(target, "utf8");
      assert(
        mdTrust.isTrusted("outreach-sample", sha256(onDisk)),
        "Auto-Trust wirksam mit on-disk Hash",
      );
    }
  }

  // --- 7. Deferred commit REVOKES prior trust (re-confirm closure) ---
  console.log("[test:skills:import] deferred commit revoked prior trust");
  const defUserDir = join(tmpRoot, "deferred-user-skills");
  mkdirSync(join(defUserDir, "outreach-sample"), { recursive: true });
  writeFileSync(
    join(defUserDir, "outreach-sample", "SKILL.md"),
    SAMPLE_BODY,
    "utf8",
  );
  const defTrust = new SkillsTrustStore(join(tmpRoot, "deferred-trust.json"));
  defTrust.trust("outreach-sample", sha256(SAMPLE_BODY), ["company_get"]);
  assert(
    defTrust.isTrusted("outreach-sample", sha256(SAMPLE_BODY)),
    "Pre-state: prior trust entry vorhanden",
  );

  const defZipPath = join(tmpRoot, "deferred.zip");
  const defZip = new AdmZip();
  // Same body — but committed with trust=deferred should still revoke.
  defZip.addFile("SKILL.md", Buffer.from(SAMPLE_BODY, "utf8"));
  defZip.writeZip(defZipPath);

  const defStage = await stageImportZip(defZipPath, {
    userSkillsDir: defUserDir,
    trustStore: defTrust,
    stagingRoot: tmpRoot,
  });
  assert(defStage.ok === true, "Deferred staging ok");
  if (defStage.ok) {
    const defCommit = commitImport(
      {
        stagingId: defStage.stagingId,
        staged: [{ name: "outreach-sample", trust: "deferred" }],
      },
      {
        userSkillsDir: defUserDir,
        trustStore: defTrust,
        stagingRoot: tmpRoot,
      },
    );
    assert(defCommit.ok === true, "Deferred commit erfolgreich");
    assert(
      defTrust.getEntry("outreach-sample") === null,
      "Deferred commit hat den prior trust entry revoked",
    );
  }

  // --- 8. exportAllSkillsToZipFile builds MANIFEST.json ---
  console.log("[test:skills:import] exportAll Manifest");
  const allDir = join(tmpRoot, "all-user-skills");
  mkdirSync(join(allDir, "a"), { recursive: true });
  mkdirSync(join(allDir, "b"), { recursive: true });
  const sampleA = SAMPLE_BODY.replace("name: outreach-sample", "name: a");
  const sampleB = SAMPLE_BODY.replace("name: outreach-sample", "name: b");
  writeFileSync(join(allDir, "a", "SKILL.md"), sampleA);
  writeFileSync(join(allDir, "b", "SKILL.md"), sampleB);
  const all = [
    { name: "a", sourcePath: join(allDir, "a", "SKILL.md"), hash: sha256(sampleA), b2bScope: "outreach", scope: "user" },
    { name: "b", sourcePath: join(allDir, "b", "SKILL.md"), hash: sha256(sampleB), b2bScope: "outreach", scope: "user" },
  ];
  const allOut = join(tmpRoot, "ava-skills-all.zip");
  const allRes = exportAllSkillsToZipFile(all, allOut);
  assert(allRes.ok === true, "exportAll ok");
  if (allRes.ok) {
    assert(allRes.count === 2, "exportAll count === 2");
    const z = new AdmZip(allOut);
    const names = z.getEntries().map((e) => e.entryName).sort();
    assert(names.includes("a/SKILL.md"), "Zip enthält a/SKILL.md");
    assert(names.includes("b/SKILL.md"), "Zip enthält b/SKILL.md");
    assert(names.includes("MANIFEST.json"), "Zip enthält MANIFEST.json");
    const manifest = JSON.parse(
      z.getEntry("MANIFEST.json").getData().toString("utf8"),
    );
    assert(
      Array.isArray(manifest.skills) && manifest.skills.length === 2,
      "MANIFEST listet zwei Skills",
    );
    assert(
      typeof manifest.exportedAt === "string",
      "MANIFEST hat exportedAt",
    );
  }
} finally {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
}

if (failures.length > 0) {
  console.error(`\n[test:skills:import] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:import] Alle Asserts grün.`);
}
