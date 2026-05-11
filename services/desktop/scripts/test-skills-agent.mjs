#!/usr/bin/env node
// S2 — Smoke test for the agent-integration pure helpers:
//   - checkSkillAllowlist (the core deliverable)
//   - parseSlashInvocation
//   - renderSkillBody
//   - autoActivateSkill
//   - buildGateEvaluator
//
// Mirrors test-skills-loader.mjs's tsx-loader pattern so we can import
// the .ts source directly. No real LLM is spun up — we exercise the
// allowlist gate as a pure function, which is the same logic
// runTool() invokes.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const inner = join(here, "_test-skills-agent.inner.mjs");
const require = createRequire(import.meta.url);
try {
  require.resolve("tsx");
} catch (err) {
  console.error(
    "[test:skills:agent] 'tsx' nicht auflösbar — bitte `pnpm install` im Repo-Root ausführen",
  );
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const res = spawnSync(
  process.execPath,
  ["--import", "tsx", inner],
  { stdio: "inherit", cwd: root },
);

process.exit(res.status ?? 1);
