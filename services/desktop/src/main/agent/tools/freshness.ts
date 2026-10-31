import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { FreshnessScheduler } from "../freshness-scheduler";
import type { FreshnessPrefsStore } from "../freshness-prefs-store";
import type { FreshnessStage } from "../../../shared/types";

// Freshness scheduler self-service tools (Phase 8.r3).
//
// Same pattern as the alerts_* family (8.f5): each Settings knob is
// reachable from chat too, so a user can say "stell den Heartbeat auf
// 60 Tage für Publikationen" or "aktualisiere ACME jetzt" without
// leaving the conversation. Five small tools, one intent each — small
// models pick the right one from name + description alone.

const ALL_STAGES: readonly FreshnessStage[] = [
  "structuredContent",
  "companyPublication",
  "website",
  "companyProfile",
  "companyContact",
];

export interface FreshnessToolDeps {
  scheduler: FreshnessScheduler;
  prefs: FreshnessPrefsStore;
  /** Called after every prefs mutation so the Settings panel re-syncs
   *  via the IPC `freshness:prefs-changed` push. */
  onPrefsChanged: () => void;
}

// Seit 2026-10-31 ohne freshness_get_prefs/freshness_set_prefs: Rhythmus und
// Drosselung steuert der Betreiber (er bezahlt die Verarbeitung), nicht der Nutzer.
export function buildFreshnessTools(deps: FreshnessToolDeps): Tool[] {
  const scan = defineTool({
    name: "freshness_scan",
    description:
      "Read-only: trigger a freshness scan now and return the top stale (companyId, stage) rows the scheduler would consider. Use when the user asks 'welche Firmen sind veraltet', 'was steht zur Aktualisierung an', 'wann lief contact für ACME zuletzt'. Does NOT dispatch retries; pair with `freshness_run_now` for the action.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { staleFound: number; cellsInspected: number }) =>
      `${r.staleFound} stale of ${r.cellsInspected} cells`,
    run: async () => {
      const info = await deps.scheduler.triggerNow();
      // The scheduler triggered a real tick (which under 8.r2 may have
      // dispatched up to topK), but we surface only the candidate /
      // diagnostic info here — the action surface lives in
      // `freshness_run_now` (where the agent's intent is "do it now").
      return {
        startedAt: info.startedAt,
        cellsInspected: info.cellsInspected,
        staleFound: info.staleFound,
        skipped: info.skipped,
        ...(info.reason ? { reason: info.reason } : {}),
        candidates: info.candidates.map((c) => ({
          companyId: c.companyId,
          companyName: c.companyName,
          stage: c.stage,
          daysSinceLastRun: Math.round(c.daysSinceLastRun),
          cadenceDays: c.cadenceDays,
          score: Number(c.score.toFixed(2)),
          pinned: c.pinned,
        })),
        dispatched: info.dispatched,
      };
    },
  });

  const runNow = defineTool({
    name: "freshness_run_now",
    description:
      "Force a freshness tick NOW, regardless of the 30-min cadence. The scheduler scores every (companyId, stage) cell and dispatches up to `topKPerTick` retries (default 5), respecting the per-stage and global hourly throttle. Use when the user says 'aktualisiere jetzt', 'starte Refresh', 'check freshness'. Returns the rows that actually got dispatched + the throttle-skipped ones.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { dispatchedCount: number; staleFound: number }) =>
      `dispatched ${r.dispatchedCount}/${r.staleFound} stale cells`,
    run: async () => {
      const info = await deps.scheduler.triggerNow();
      return {
        startedAt: info.startedAt,
        finishedAt: info.finishedAt,
        skipped: info.skipped,
        ...(info.reason ? { reason: info.reason } : {}),
        cellsInspected: info.cellsInspected,
        staleFound: info.staleFound,
        dispatchedCount: info.dispatched.length,
        dispatched: info.dispatched,
        candidates: info.candidates.map((c) => ({
          companyId: c.companyId,
          companyName: c.companyName,
          stage: c.stage,
          daysSinceLastRun: Math.round(c.daysSinceLastRun),
          score: Number(c.score.toFixed(2)),
        })),
      };
    },
  });

  const pin = defineTool({
    name: "freshness_pin_company",
    description:
      "Pin a company so its stale cells always sort to the top of the freshness queue (10× score boost). Use when the user says 'priorisiere ACME', 'ACME zuerst', 'pin Foo GmbH'. Idempotent: pinning an already-pinned company is a no-op.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: {
          type: "string",
          description: "Company id to pin.",
        },
      },
    },
    schema: yup
      .object({ companyId: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { pinnedCount: number }) => `pinned (${r.pinnedCount} total)`,
    run: async (args) => {
      const current = deps.prefs.get();
      if (current.pinned.includes(args.companyId)) {
        return { pinnedCount: current.pinned.length, alreadyPinned: true };
      }
      const next = deps.prefs.set({
        pinned: [...current.pinned, args.companyId],
      });
      deps.onPrefsChanged();
      return { pinnedCount: next.pinned.length, alreadyPinned: false };
    },
  });

  const unpin = defineTool({
    name: "freshness_unpin_company",
    description:
      "Remove a company from the freshness pin list. Use when the user says 'unpin ACME', 'ACME normal sortieren', 'ACME nicht mehr priorisieren'. Idempotent.",
    parameters: {
      type: "object",
      required: ["companyId"],
      properties: {
        companyId: {
          type: "string",
          description: "Company id to unpin.",
        },
      },
    },
    schema: yup
      .object({ companyId: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { pinnedCount: number }) =>
      `unpinned (${r.pinnedCount} remaining)`,
    run: async (args) => {
      const current = deps.prefs.get();
      const filtered = current.pinned.filter((id) => id !== args.companyId);
      if (filtered.length === current.pinned.length) {
        return { pinnedCount: current.pinned.length, wasPinned: false };
      }
      const next = deps.prefs.set({ pinned: filtered });
      deps.onPrefsChanged();
      return { pinnedCount: next.pinned.length, wasPinned: true };
    },
  });

  return [scan, runNow, pin, unpin];
}
