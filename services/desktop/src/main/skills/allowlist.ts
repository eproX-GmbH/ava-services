// S2 — Pure helpers for skill activation + tool-allowlist enforcement.
//
// Kept dependency-free so the test script can import them directly
// from the TypeScript source via tsx, without wiring the entire
// orchestrator + provider stack.
//
// Three concerns live here:
//   1. parseSlashInvocation — detect `/skill-name [args]` on the first
//      line of a user message and yield the name + raw argument string.
//   2. renderSkillBody — substitute $ARGUMENTS and ${named} args into a
//      skill body. Simple string replace, no expression engine.
//   3. checkSkillAllowlist — given the active skill and an attempted
//      tool name, return either { ok: true } or { ok: false, message }
//      with a German user-facing refusal.
//   4. autoActivateSkill — crude description-keyword match. Returns the
//      LoadedSkill that should activate for the current turn, or null
//      if no skill matches.

import type { LoadedSkill } from "./loader";
import type { SkillArgument } from "./schema";

export interface SlashInvocation {
  name: string;
  rawArgs: string;
}

export function parseSlashInvocation(message: string): SlashInvocation | null {
  if (!message) return null;
  // Operate on the FIRST line only — a message that opens with `/foo`
  // and then has prose is still a skill invocation; later slashes in
  // the middle of a paragraph are ignored.
  const firstLine = message.split(/\r?\n/, 1)[0] ?? "";
  const m = /^\/([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(firstLine);
  if (!m) return null;
  return { name: m[1]!, rawArgs: (m[2] ?? "").trim() };
}

/**
 * Substitute `$ARGUMENTS` and `${argname}` placeholders inside the
 * skill body. Named args are split from `rawArgs` by whitespace and
 * paired positionally with the skill's declared `arguments` list — that
 * matches Anthropic's convention well enough for a v1 implementation,
 * and we explicitly document the limitation in SKILLS.md.
 */
export function renderSkillBody(
  skill: LoadedSkill,
  rawArgs: string,
): string {
  let body = skill.body;
  body = body.replaceAll("$ARGUMENTS", rawArgs);
  const positional = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
  const args: SkillArgument[] = skill.arguments;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a) continue;
    const value = positional[i] ?? "";
    body = body.replaceAll(`\${${a.name}}`, value);
  }
  return body;
}

export type AllowlistCheck =
  | { ok: true }
  | { ok: false; message: string };

/** v0.1.261 — Tools, die NIE durch die Skill-Allowlist blockiert
 *  werden dürfen. Zwei Kategorien:
 *
 *  (a) Meta/Bootstrap: ohne die kann AVA bei aktivem Skill nicht mal
 *      andere Tools entdecken oder nachfragen.
 *
 *  (b) Cross-cutting Utilities (v0.1.272+): Operationen, die der Nutzer
 *      parallel zur Skill-Hauptaktion auslösen kann ("schreib mir die
 *      Mail UND merk dir meine Adresse"). Der aktive Skill weiß nicht
 *      vorher, welche Side-Asks der Nutzer einstreut — also lassen wir
 *      sie generell durch.
 *
 *  Spiegelt ALWAYS_ON_CORE_TOOL_NAMES + Memory-Tools aus tools/. Bewusst
 *  hier hardcoded statt importiert, weil allowlist.ts dependency-free
 *  bleiben soll (Test-Imports via tsx).
 */
const SKILL_ALLOWLIST_BYPASS = new Set<string>([
  // (a) Bootstrap
  "tool_search",
  "tool_load",
  "skill_search",
  "skill_get",
  "ask_user_choice",
  "ask_user_text",
  // (b) Cross-cutting Utilities — Memory
  "remember",
  "recall_memory",
]);

export function checkSkillAllowlist(
  skill: LoadedSkill | null,
  toolName: string,
): AllowlistCheck {
  if (!skill) return { ok: true };
  // Bootstrap-Meta-Tools dürfen IMMER durch — ohne sie kann AVA bei
  // aktivem Skill weder andere Tools laden noch nachfragen.
  if (SKILL_ALLOWLIST_BYPASS.has(toolName)) return { ok: true };
  if (skill.allowedTools.length === 0) {
    return {
      ok: false,
      message: `Skill '${skill.name}' erlaubt keine Tool-Aufrufe (reines Prosa-Skill).`,
    };
  }
  if (!skill.allowedTools.includes(toolName)) {
    return {
      ok: false,
      message: `Tool '${toolName}' ist im aktiven Skill '${skill.name}' nicht erlaubt (allowed-tools: [${skill.allowedTools.join(", ")}]).`,
    };
  }
  return { ok: true };
}

// Stopwords for the crude description-match heuristic. Intentionally
// short — a real semantic match lands later.
// TODO(S2-followup): semantic match (embedding similarity or
// LLM-pick) replacing this keyword overlap.
const STOPWORDS = new Set([
  "der",
  "die",
  "das",
  "und",
  "oder",
  "mit",
  "für",
  "über",
  "ein",
  "eine",
  "wenn",
  "beim",
  "aktiviere",
  "schreibt",
  "bittet",
  // v0.1.143 — generic B2B-research terms that ALL skills share in
  // their descriptions. Allowing them as keywords caused
  // `wettbewerber-uebersicht` to auto-activate on the generic prompt
  // "generelle Übersicht über meine Firmen" (übersicht + firmen = 2
  // hits → threshold met), which then blocked transactions_list via
  // the skill's allowed-tools list. Removing them keeps the skill's
  // discriminating terms ("wettbewerber", "konkurrenz", "vergleich",
  // "marktumfeld", "mitbewerber" …) doing the actual matching.
  "übersicht",
  "firma",
  "firmen",
  "unternehmen",
  "unternehmens",
  "company",
  "companies",
  "anfragen",
  "anfrage",
  "liste",
]);

function keywordsOf(description: string): string[] {
  return description
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

/**
 * Pick the skill whose description has the most keyword hits in the
 * most-recent user message. Looks at the last 3 user messages but only
 * counts hits in the LAST one — older messages establish recency but
 * don't sway the score (a one-shot keyword from 3 turns ago shouldn't
 * pin a skill).
 *
 * Skills with `disableModelInvocation: true` are excluded; those can
 * only fire via explicit `/name`.
 */
export function autoActivateSkill(
  skills: LoadedSkill[],
  lastUserMessage: string,
): LoadedSkill | null {
  if (!lastUserMessage || skills.length === 0) return null;
  const haystack = lastUserMessage.toLowerCase();
  let best: { skill: LoadedSkill; hits: number } | null = null;
  for (const s of skills) {
    if (s.disableModelInvocation) continue;
    const kws = keywordsOf(s.description);
    const seen = new Set<string>();
    for (const kw of kws) {
      if (haystack.includes(kw)) seen.add(kw);
    }
    if (seen.size < 2) continue;
    if (!best || seen.size > best.hits) {
      best = { skill: s, hits: seen.size };
    }
  }
  return best?.skill ?? null;
}
