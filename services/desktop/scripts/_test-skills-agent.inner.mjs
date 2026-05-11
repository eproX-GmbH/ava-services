// S2 inner test runner. Imports the TypeScript skill helpers directly
// via the tsx ESM loader. Tests three concerns:
//   1. The allowlist enforcement (the S2 acceptance criterion).
//   2. The slash-invocation parser + body renderer.
//   3. The auto-activation heuristic.
//   4. The gate evaluator against fake CRM + Ollama deps.

import {
  checkSkillAllowlist,
  parseSlashInvocation,
  renderSkillBody,
  autoActivateSkill,
  buildGateEvaluator,
} from "../src/main/skills/index.ts";

const failures = [];
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
}

// --- Fixture skills (in-memory; no SKILL.md files needed) ---

function mkSkill(over) {
  return {
    id: `user:${over.name}`,
    name: over.name,
    description: over.description ?? "Test-Skill.",
    language: "de",
    b2bScope: "qualifying",
    allowedTools: over.allowedTools ?? [],
    requiresUserConfirm: false,
    disableModelInvocation: over.disableModelInvocation ?? false,
    userInvocable: over.userInvocable ?? true,
    arguments: over.arguments ?? [],
    metadata: over.metadata ?? {},
    body: over.body ?? "# Test\n\n",
    hash: "x".repeat(64),
    sourcePath: `/fake/${over.name}/SKILL.md`,
    scope: "user",
  };
}

const restricted = mkSkill({
  name: "restricted-readonly",
  description: "Lese-Skill, nur Stammdaten + Profil-Abfragen.",
  allowedTools: ["company_get", "company_profile"],
});
const pureProse = mkSkill({
  name: "pure-prose",
  description: "Reines Prosa-Skill ohne Tools.",
  allowedTools: [],
});
const unrestricted = mkSkill({
  name: "unrestricted",
  description: "Default leere allowed-tools.",
  // allowedTools omitted -> [] from schema default
});

// --- 1. Allowlist enforcement ---

console.log("[test:skills:agent] Allowlist");
{
  const ok = checkSkillAllowlist(restricted, "company_get");
  assert(ok.ok === true, "restricted-readonly erlaubt company_get");

  const bad = checkSkillAllowlist(restricted, "import_company");
  assert(bad.ok === false, "restricted-readonly verbietet import_company");
  if (!bad.ok) {
    assert(
      bad.message.includes("import_company") &&
        bad.message.includes("restricted-readonly") &&
        bad.message.includes("nicht erlaubt"),
      "Refusal-Nachricht nennt Tool + Skill + 'nicht erlaubt'",
    );
    assert(
      bad.message.includes("company_get") && bad.message.includes("company_profile"),
      "Refusal listet beide erlaubten Tools",
    );
  }

  const prose = checkSkillAllowlist(pureProse, "company_get");
  assert(prose.ok === false, "pure-prose verbietet jeden Tool-Aufruf");
  if (!prose.ok) {
    assert(
      prose.message.includes("reines Prosa-Skill"),
      "Pure-Prose-Refusal nennt 'reines Prosa-Skill'",
    );
  }

  const unr = checkSkillAllowlist(unrestricted, "company_get");
  assert(
    unr.ok === false,
    "unrestricted (allowed-tools omitted -> []) verhält sich wie pure-prose",
  );

  const noActive = checkSkillAllowlist(null, "import_company");
  assert(
    noActive.ok === true,
    "Ohne aktives Skill greift keine Allowlist",
  );
}

// --- 2. Slash invocation parser ---

console.log("[test:skills:agent] /slash parser");
{
  const a = parseSlashInvocation("/outreach-draft");
  assert(a?.name === "outreach-draft" && a.rawArgs === "", "/outreach-draft");

  const b = parseSlashInvocation("/outreach-draft ACME GmbH Berlin");
  assert(
    b?.name === "outreach-draft" && b.rawArgs === "ACME GmbH Berlin",
    "/outreach-draft mit Argumenten",
  );

  const c = parseSlashInvocation("Hallo /foo ist kein Trigger");
  assert(c === null, "Slash mitten im Text ist kein Trigger");

  const d = parseSlashInvocation("/qualifying-deep arg1\nzweite Zeile");
  assert(
    d?.name === "qualifying-deep" && d.rawArgs === "arg1",
    "Nur erste Zeile zählt",
  );

  const e = parseSlashInvocation("/Bad-Name");
  assert(e === null, "Großbuchstaben sind nicht kebab-case");
}

// --- 3. Body rendering ---

console.log("[test:skills:agent] Body-Rendering");
{
  const skill = mkSkill({
    name: "outreach",
    body: "Schreibe an ${companyId} ($ARGUMENTS).",
    arguments: [
      { name: "companyId", description: "id", required: true },
    ],
  });
  const out = renderSkillBody(skill, "ACME-123 Berlin");
  assert(
    out === "Schreibe an ACME-123 (ACME-123 Berlin).",
    `Body-Rendering: '${out}'`,
  );

  const out2 = renderSkillBody(skill, "");
  assert(
    out2 === "Schreibe an  ().",
    `Leere Argumente -> Leerstring eingesetzt: '${out2}'`,
  );
}

// --- 4. Auto-activation ---

console.log("[test:skills:agent] Auto-Activation");
{
  const outreach = mkSkill({
    name: "outreach-draft",
    description:
      "Schreibt einen Erstkontakt-Entwurf an Geschäftsführer einer Maschinenbau-Firma.",
  });
  const qualifying = mkSkill({
    name: "qualifying",
    description: "Qualifying-Fragebogen für Vertrieb und Leads.",
  });
  const skills = [outreach, qualifying];

  const a = autoActivateSkill(skills, "Bitte Erstkontakt an einen Geschäftsführer einer Maschinenbau-Firma");
  assert(a?.name === "outreach-draft", "Outreach-Keywords aktivieren outreach-draft");

  const b = autoActivateSkill(skills, "Hallo");
  assert(b === null, "Keine Keyword-Treffer -> keine Aktivierung");

  const c = autoActivateSkill(skills, "Bitte Qualifying-Fragebogen für meine Leads");
  assert(c?.name === "qualifying", "Qualifying-Keywords aktivieren qualifying");

  // disable-model-invocation should suppress auto-activation
  const offlimit = mkSkill({
    name: "user-only",
    description:
      "Schreibt einen Erstkontakt-Entwurf an Geschäftsführer einer Maschinenbau-Firma.",
    disableModelInvocation: true,
  });
  const d = autoActivateSkill(
    [offlimit],
    "Bitte Erstkontakt an einen Geschäftsführer einer Maschinenbau-Firma",
  );
  assert(d === null, "disable-model-invocation blockiert Auto-Activation");
}

// --- 5. Gate evaluator ---

console.log("[test:skills:agent] Gate-Evaluator");
{
  const crm = { hubspot: true, salesforce: false, dynamics: false };
  const evalGate = buildGateEvaluator({
    isCrmConnected: (p) => {
      if (p === "any") return Object.values(crm).some(Boolean);
      return crm[p] === true;
    },
    ollamaState: () => ({ installed: true, running: false }),
  });

  const noReq = mkSkill({ name: "no-req" });
  assert(evalGate(noReq) === true, "Ohne requires-Block -> erlaubt");

  const wantsHubspot = mkSkill({
    name: "needs-hs",
    metadata: { ava: { requires: { crm: "hubspot" } } },
  });
  assert(evalGate(wantsHubspot) === true, "HubSpot verbunden -> erlaubt");

  const wantsSalesforce = mkSkill({
    name: "needs-sf",
    metadata: { ava: { requires: { crm: "salesforce" } } },
  });
  assert(
    evalGate(wantsSalesforce) === false,
    "Salesforce nicht verbunden -> blockiert",
  );

  const wantsRunning = mkSkill({
    name: "needs-running",
    metadata: { ava: { requires: { ollama: "running" } } },
  });
  assert(
    evalGate(wantsRunning) === false,
    "Ollama nicht running -> blockiert",
  );

  const wantsInstalled = mkSkill({
    name: "needs-installed",
    metadata: { ava: { requires: { ollama: "installed" } } },
  });
  assert(
    evalGate(wantsInstalled) === true,
    "Ollama installiert -> erlaubt",
  );

  const wantsTier = mkSkill({
    name: "needs-tier",
    metadata: { ava: { requires: { tier: "pro" } } },
  });
  assert(evalGate(wantsTier) === true, "Tier-Gate ist (noch) immer erfüllt");
}

if (failures.length > 0) {
  console.error(`\n[test:skills:agent] ${failures.length} Fehler:`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
} else {
  console.log(`\n[test:skills:agent] Alle Asserts grün.`);
}
