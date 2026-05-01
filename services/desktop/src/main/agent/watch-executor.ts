import * as yup from "yup";
import type { LlmProviderManager } from "./providers";
import type { AlertsStore } from "./alerts-store";
import type { WatchStore } from "./watch-store";
import type { HeartbeatCandidate } from "./heartbeat";
import type { AgentMessage, Watch, WatchCadence } from "../../shared/types";

// WatchExecutor (Phase 8.t2).
//
// Hooked into the heartbeat tick AFTER the alert judge has run. The
// heartbeat passes the same candidate set both flows see, plus the
// current wall-clock time. The executor:
//
//   1. Filters watches to those whose cadence has elapsed since
//      `lastCheckedAt`. A weekly watch fires once per week, period.
//   2. For each due watch, scopes the candidate set down by the
//      watch's `companyIds` / `topics` filters (cheap, in-process).
//   3. For each survivor, runs ONE LLM call with a tiny rubric-judge
//      prompt against the candidate. yup-validates the verdict.
//   4. On `matches: true`, creates an Alert tagged with the watch's id.
//      Dedup is structural: `sourceRef = watch:{id}:{candidateRef}` so
//      the same watch firing twice on the same publication yields a
//      single row.
//   5. Updates the watch's `lastCheckedAt` regardless of hit.
//
// Cadence math (`hoursOf`): cadence ≤ 0 hours never fires; we anchor
// daily=24h, weekly=168h, monthly=720h. Single-bucket model — no
// alignment, no day-of-week semantics. "weekly" means "≥ 7 days
// since last evaluated", not "every Monday morning".
//
// Failure handling: a single watch's eval throwing doesn't poison the
// rest of the loop. Provider unavailable → skip the entire executor
// for this tick (same shape the alert judge uses).

const VerdictSchema = yup
  .object({
    matches: yup.boolean().required(),
    severity: yup.string().oneOf(["info", "warn", "urgent"]).optional(),
    headline: yup.string().nullable().defined(),
    rationale: yup.string().required(),
  })
  .strict()
  .noUnknown();

interface RubricVerdict {
  matches: boolean;
  severity: "info" | "warn" | "urgent";
  headline: string;
  rationale: string;
}

export interface WatchExecutorOptions {
  watches: WatchStore;
  alerts: AlertsStore;
  providers: LlmProviderManager;
  /** Override the wall clock — test seam. */
  now?: () => Date;
}

export class WatchExecutor {
  private readonly watches: WatchStore;
  private readonly alerts: AlertsStore;
  private readonly providers: LlmProviderManager;
  private readonly now: () => Date;

  constructor(opts: WatchExecutorOptions) {
    this.watches = opts.watches;
    this.alerts = opts.alerts;
    this.providers = opts.providers;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Heartbeat post-tick hook. The heartbeat passes the same candidate
   * list its primary judge consumed — we re-use it to evaluate every
   * due watch's rubric.
   */
  async evaluate(candidates: HeartbeatCandidate[]): Promise<void> {
    if (candidates.length === 0) return;
    if (!this.providers.getStatus().ready) {
      // No LLM — defer this tick. Watches stay due; next provider-ready
      // tick picks them up.
      return;
    }
    const now = this.now();
    const due = this.watches.enabled().filter((w) => isDue(w, now));
    if (due.length === 0) return;

    for (const watch of due) {
      try {
        await this.evaluateOne(watch, candidates, now);
      } catch (err) {
        console.warn(
          `[watches] eval failed for ${watch.id} (${watch.prompt.slice(0, 40)}…):`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        // Always advance lastCheckedAt — even on error — to prevent a
        // single broken watch from blocking the loop forever. The
        // user can `watch_remove` the offender.
        this.watches.markChecked(watch.id, now);
      }
    }
  }

  // ---- Internal -----------------------------------------------------------

  private async evaluateOne(
    watch: Watch,
    candidates: HeartbeatCandidate[],
    now: Date,
  ): Promise<void> {
    // Filter to scope. Skipping eval entirely when no candidates pass
    // the scope keeps the LLM call out of the hot path.
    const companyFilter = watch.trigger.companyIds
      ? new Set(watch.trigger.companyIds)
      : null;
    const topicFilter = watch.trigger.topics
      ? new Set(watch.trigger.topics)
      : null;
    const scoped = candidates.filter((c) => {
      if (companyFilter && !companyFilter.has(c.companyId)) return false;
      if (topicFilter && !topicFilter.has(c.kind)) return false;
      return true;
    });
    if (scoped.length === 0) return;

    for (const candidate of scoped) {
      const sourceRef = `watch:${watch.id}:${candidate.sourceRef}`;
      // Dedup: if THIS watch already fired on THIS candidate, skip the
      // LLM call entirely. The candidate pool re-emits the same
      // sourceRef across ticks until a fresh ingestion bumps it.
      if (this.alerts.hasSourceRef(sourceRef)) continue;

      let verdict: RubricVerdict;
      try {
        verdict = await this.judgeRubric(watch, candidate, now);
      } catch (err) {
        console.warn(
          `[watches] judge failed for ${watch.id} × ${candidate.sourceRef}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }
      if (!verdict.matches) continue;

      const headline = verdict.headline.trim() || watch.prompt;
      const row = this.alerts.add({
        tenantId: null,
        companyId: candidate.companyId,
        companyName: candidate.companyName,
        kind: "evaluation-flag",
        severity: verdict.severity,
        headline: `Watch: ${headline}`,
        rationale: `Watch „${watch.prompt}" ausgelöst. ${verdict.rationale}`,
        sourceRef,
      });
      if (row) this.watches.recordHit(watch.id, row.id, now);
    }
  }

  private async judgeRubric(
    watch: Watch,
    candidate: HeartbeatCandidate,
    now: Date,
  ): Promise<RubricVerdict> {
    const stamp = now.getTime();
    const messages: AgentMessage[] = [
      {
        id: `watch-judge-system-${watch.id}`,
        role: "system",
        content: buildRubricSystemPrompt(watch, now),
        createdAt: stamp,
      },
      {
        id: `watch-judge-user-${watch.id}-${candidate.sourceRef}`,
        role: "user",
        content: buildRubricUserPrompt(candidate),
        createdAt: stamp,
      },
    ];
    const text = await streamToText(this.providers, messages);
    const parsed = parseJsonObject(text);
    if (!parsed) {
      return {
        matches: false,
        severity: "info",
        headline: "",
        rationale: "Antwort des Modells enthielt kein JSON-Objekt.",
      };
    }
    let validated: yup.InferType<typeof VerdictSchema>;
    try {
      validated = await VerdictSchema.validate(parsed, {
        strict: true,
        abortEarly: false,
        stripUnknown: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        matches: false,
        severity: "info",
        headline: "",
        rationale: `Schema-Verstoss: ${msg.slice(0, 200)}`,
      };
    }
    return {
      matches: validated.matches,
      severity: validated.severity ?? "info",
      headline: validated.headline ?? "",
      rationale: validated.rationale,
    };
  }
}

// ---- Cadence helpers -------------------------------------------------------

function hoursOf(cadence: WatchCadence): number {
  switch (cadence) {
    case "daily":
      return 24;
    case "weekly":
      return 24 * 7;
    case "monthly":
      return 24 * 30;
  }
}

function isDue(watch: Watch, now: Date): boolean {
  if (!watch.lastCheckedAt) return true;
  const last = new Date(watch.lastCheckedAt).getTime();
  if (!Number.isFinite(last)) return true;
  const ageHours = (now.getTime() - last) / 3_600_000;
  return ageHours >= hoursOf(watch.cadence);
}

// ---- Prompts --------------------------------------------------------------

function buildRubricSystemPrompt(watch: Watch, now: Date): string {
  const today = now.toISOString().slice(0, 10);
  return [
    "Du bewertest, ob ein Datenpunkt einer überwachten Rubrik entspricht.",
    `Heute ist ${today}.`,
    "",
    "Rubrik (vom Nutzer formuliert, NIE umformulieren oder erweitern):",
    `  ${watch.trigger.rubric}`,
    "",
    "Antworte NUR mit einem JSON-Objekt nach diesem Schema:",
    "  {",
    '    "matches": boolean,',
    '    "severity": "info" | "warn" | "urgent",',
    '    "headline": string,    // max. 100 Zeichen, Deutsch, sachlich',
    '    "rationale": string    // 1 Satz, max. 280 Zeichen, Deutsch',
    "  }",
    "",
    "Regeln:",
    "  - matches=true NUR, wenn der Datenpunkt SICHTBAR und KONKRET",
    "    der Rubrik entspricht. Keine spekulativen Treffer.",
    "  - severity wählst du nach Tragweite: info=nennenswert,",
    "    warn=beachten, urgent=sofort handeln.",
    "  - rationale begründet matches=false ebenso wie matches=true",
    "    (warum entspricht es / warum nicht).",
    "  - Keine zusätzlichen Felder, keine Markdown-Codeblöcke,",
    "    keine Begrüssung, kein Fließtext um das JSON.",
  ].join("\n");
}

function buildRubricUserPrompt(c: HeartbeatCandidate): string {
  return [
    `Datenpunkt (kind=${c.kind}):`,
    `  Firma:        ${c.companyName} (id: ${c.companyId})`,
    `  Datum:        ${c.occurredAt}`,
    `  Zusammenfassung: ${c.summary}`,
    `  Rohdaten:     ${JSON.stringify(c.payload)}`,
    "",
    "Bewerte gegen die Rubrik aus dem System-Prompt.",
  ].join("\n");
}

// ---- LLM consumption + JSON extraction (mirrors alert-judge.ts) ----------

async function streamToText(
  providers: LlmProviderManager,
  messages: AgentMessage[],
): Promise<string> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 30_000);
  let buf = "";
  try {
    const stream = providers.streamChat({ messages, signal: ctrl.signal });
    for await (const frame of stream) {
      if (frame.contentDelta) buf += frame.contentDelta;
      if (frame.done) break;
      if (frame.errorMessage) throw new Error(frame.errorMessage);
    }
  } finally {
    clearTimeout(timeout);
  }
  return buf;
}

function parseJsonObject(text: string): unknown {
  if (!text) return null;
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/i;
  const m = fenceRe.exec(text);
  const candidate = m ? m[1]! : text;
  try {
    const parsed = JSON.parse(candidate.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* fall through */
  }
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
