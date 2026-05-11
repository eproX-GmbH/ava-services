// S2 — Gate evaluator for skills' `metadata.ava.requires` block.
//
// The loader stays decoupled from the rest of main/ by accepting a
// `GateEvaluator` callback in initSkills(). main/index.ts builds the
// callback against the live CrmManager + OllamaSupervisor instances
// (Option A in the S2 brief).
//
// S3 — the evaluator now returns a structured `GateResult` so the
// loader can surface a German "Voraussetzung fehlt: …" reason in the
// Settings UI. Legacy callers that treated the evaluator as a boolean
// still work because `evaluateGateLegacy()` wraps it.

import type { LoadedSkill } from "./loader";

export interface GateResult {
  ok: boolean;
  /** German one-liner explaining a failed gate. Null when ok. */
  reason: string | null;
}

export type GateEvaluator = (skill: LoadedSkill) => GateResult;

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

function crmReason(provider: string): string {
  if (provider === "any") return "Kein CRM verbunden";
  if (provider === "hubspot") return "HubSpot ist nicht verbunden";
  if (provider === "salesforce") return "Salesforce ist nicht verbunden";
  if (provider === "dynamics")
    return "Microsoft Dynamics ist nicht verbunden";
  return `CRM-Provider '${provider}' ist nicht verbunden`;
}

/**
 * Build a real evaluator from the desktop's live managers. The string
 * keys it handles mirror SKILLS.md.
 *
 * TODO(S2-followup): tier-based gating once we have a tier system.
 */
export function buildGateEvaluator(deps: GateDeps): GateEvaluator {
  return (skill: LoadedSkill): GateResult => {
    const req = skill.metadata?.ava?.requires;
    if (!req) return { ok: true, reason: null };

    for (const [key, valueRaw] of Object.entries(req)) {
      if (!valueRaw) continue;
      const value = String(valueRaw).toLowerCase();
      switch (key) {
        case "crm": {
          if (!deps.isCrmConnected(value)) {
            return { ok: false, reason: crmReason(value) };
          }
          break;
        }
        case "ollama": {
          const st = deps.ollamaState();
          if (value === "running") {
            if (!st.running) {
              return { ok: false, reason: "Ollama läuft nicht" };
            }
          } else {
            // "installed" or unknown sub-value → require installed.
            if (!st.installed) {
              return { ok: false, reason: "Ollama ist nicht installiert" };
            }
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
    return { ok: true, reason: null };
  };
}

/** Default evaluator: any requires block → reject with a generic
 *  reason. Used when no deps are wired (test scripts, future
 *  tier-less builds). Mirrors S1 behaviour of "any requires block →
 *  skip", but now surfaces a reason instead of silently failing. */
export const denyAllGates: GateEvaluator = (skill) => {
  const req = skill.metadata?.ava?.requires;
  if (!req) return { ok: true, reason: null };
  for (const v of Object.values(req)) {
    if (v) {
      return {
        ok: false,
        reason: "Voraussetzungen werden in dieser Umgebung nicht ausgewertet",
      };
    }
  }
  return { ok: true, reason: null };
};
