import type { LoadedSkill } from "../skills";
import type { OllamaToolSpec } from "./types";
import type { ToolRegistry } from "./tool-registry";
import { ALWAYS_ON_CORE_TOOL_NAMES } from "./tools/meta";

// Tool selection for a given chat turn.
//
// History:
// - Until v0.1.185: every registered tool's full JSON-Schema (~12k
//   tokens) traveled with every request.
// - v0.1.186: curated DEFAULT_RESEARCH_TOOLS slimmed that to ~40 tools
//   but the descriptions kept growing; one complex Notion-update with
//   GPT-5.4-mini still ran ~30¢.
// - v0.1.240 (this file): lazy tool-loading. Each conversation sees
//   only ALWAYS_ON_CORE_TOOL_NAMES by default — everything else gets
//   discovered via `tool_search` + pulled in via `tool_load`, which
//   stores the chosen names in `Conversation.loadedToolNames`. Skills
//   still auto-load their `allowed-tools` so the existing skill UX
//   keeps working without a discovery roundtrip.
//
// Selection precedence for a given turn:
//   1. ALWAYS_ON_CORE_TOOL_NAMES — the meta + UI primitives.
//   2. conversation.loadedToolNames — accumulated through tool_load
//      and skill activations.
//   3. activeSkill.allowedTools — current skill's allow-list. (Skills
//      also push their tools into loadedToolNames on activation so
//      they persist for the rest of the conversation; we still union
//      here so a brand-new activation is reflected in the SAME turn.)
//   4. extraToolNames — slash-palette escape hatch.

export interface SelectToolsOpts {
  registry: ToolRegistry;
  activeSkill: LoadedSkill | null;
  loadedToolNames?: ReadonlySet<string>;
  extraToolNames?: ReadonlyArray<string>;
}

export function selectToolsForTurn(
  opts: SelectToolsOpts,
): OllamaToolSpec[] | undefined {
  const { registry, activeSkill, loadedToolNames, extraToolNames } = opts;

  const allowed = new Set<string>(ALWAYS_ON_CORE_TOOL_NAMES);
  if (loadedToolNames) {
    for (const name of loadedToolNames) allowed.add(name);
  }
  if (activeSkill) {
    for (const name of activeSkill.allowedTools) allowed.add(name);
  }
  if (extraToolNames) {
    for (const name of extraToolNames) allowed.add(name);
  }

  const all = registry.toOllamaTools();
  const filtered = all.filter((t) => allowed.has(t.function.name));
  return filtered.length > 0 ? filtered : undefined;
}

/** Exposed for tests / diagnostics. Don't mutate. */
export { ALWAYS_ON_CORE_TOOL_NAMES };
