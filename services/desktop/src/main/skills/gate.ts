// S2 — Gate evaluator for skills' `metadata.ava.requires` block.
//
// The loader stays decoupled from the rest of main/ by accepting a
// `GateEvaluator` callback in initSkills(). main/index.ts builds the
// callback against the live CrmManager + OllamaSupervisor instances
// (Option A in the S2 brief).
//
// Returns true if the skill should load, false to skip. Unsatisfied
// gates are logged in German by the loader; the evaluator itself does
// not log so a test harness can drive it silently.

import type { LoadedSkill } from "./loader";

export type GateEvaluator = (skill: LoadedSkill) => boolean;

export interface GateDeps {
  /**
   * CRM connection check. The callback receives a provider name from
   * `metadata.ava.requires.crm` (lowercased) — implementations should
   * return `true` if that provider is connected. The special value
   * `"any"` asks the caller whether any provider is connected.
   */
  isCrmConnected: (provider: string) => boolean;
  /**
   * Ollama supervisor status. `installed` means the binary is present;
   * `running` means the daemon is up (state === "ready"). Anything
   * else for the level argument is treated as `installed`.
   */
  ollamaState: () => { installed: boolean; running: boolean };
}

/**
 * Build a real evaluator from the desktop's live managers. The string
 * keys it handles mirror SKILLS.md.
 *
 * TODO(S2-followup): tier-based gating once we have a tier system.
 */
export function buildGateEvaluator(deps: GateDeps): GateEvaluator {
  return (skill: LoadedSkill): boolean => {
    const req = skill.metadata?.ava?.requires;
    if (!req) return true;

    for (const [key, valueRaw] of Object.entries(req)) {
      if (!valueRaw) continue;
      const value = String(valueRaw).toLowerCase();
      switch (key) {
        case "crm": {
          if (!deps.isCrmConnected(value)) return false;
          break;
        }
        case "ollama": {
          const st = deps.ollamaState();
          if (value === "running") {
            if (!st.running) return false;
          } else {
            // "installed" or unknown sub-value → require installed.
            if (!st.installed) return false;
          }
          break;
        }
        case "tier": {
          // No tier system yet. Always satisfied.
          // TODO(S2-followup): real tier check.
          break;
        }
        default: {
          console.warn(
            `[skills] '${skill.name}' unbekannte Gate-Bedingung '${key}' — wird ignoriert.`,
          );
          break;
        }
      }
    }
    return true;
  };
}

/** Default evaluator: nothing satisfied — used when no deps are wired
 *  (test scripts, future tier-less builds). Mirrors S1 behaviour of
 *  "any requires block → skip". */
export const denyAllGates: GateEvaluator = (skill) => {
  const req = skill.metadata?.ava?.requires;
  if (!req) return true;
  for (const v of Object.values(req)) {
    if (v) return false;
  }
  return true;
};
