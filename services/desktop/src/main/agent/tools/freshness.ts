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
  "companyEvaluation",
];

export interface FreshnessToolDeps {
  scheduler: FreshnessScheduler;
  prefs: FreshnessPrefsStore;
  /** Called after every prefs mutation so the Settings panel re-syncs
   *  via the IPC `freshness:prefs-changed` push. */
  onPrefsChanged: () => void;
}

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

  const getPrefs = defineTool({
    name: "freshness_get_prefs",
    description:
      "Read the current freshness scheduler preferences (master toggle, per-stage cadences in days, throttle ceilings, pinned companies). Call before `freshness_set_prefs` if you're unsure of the current state.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { enabled: boolean; pinned: number }) =>
      `freshness ${r.enabled ? "on" : "off"} · ${r.pinned} pinned`,
    run: async () => {
      const p = deps.prefs.get();
      return {
        enabled: p.enabled,
        cadenceDays: p.cadenceDays,
        throttle: p.throttle,
        topKPerTick: p.topKPerTick,
        pinned: p.pinned.length,
        pinnedCompanies: p.pinned,
      };
    },
  });

  const setPrefs = defineTool({
    name: "freshness_set_prefs",
    description:
      "Patch freshness scheduler preferences. Only fields you set are changed. Use for things like 'auto-Aktualisierung aus' (`enabled: false`), 'profil alle 3 Tage' (`cadenceDays: { companyProfile: 3 }`), 'maximal 5 Retries pro Stunde' (`throttle: { globalPerHour: 5 }`). Cadence days are integers; 0 = stage opt-out (manual retries still work). To manage pinned companies use `freshness_pin_company` / `freshness_unpin_company` instead — those are atomic add/remove and don't require resending the whole list.",
    parameters: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Master toggle. False pauses the scheduler entirely.",
        },
        cadenceDays: {
          type: "object",
          description:
            "Per-stage cadence in days. Each key is optional; only set the stages you want to change.",
          properties: {
            structuredContent: { type: "integer", minimum: 0 },
            companyPublication: { type: "integer", minimum: 0 },
            website: { type: "integer", minimum: 0 },
            companyProfile: { type: "integer", minimum: 0 },
            companyContact: { type: "integer", minimum: 0 },
            companyEvaluation: { type: "integer", minimum: 0 },
          },
        },
        throttle: {
          type: "object",
          properties: {
            perStagePerHour: { type: "integer", minimum: 0 },
            globalPerHour: { type: "integer", minimum: 0 },
          },
        },
        topKPerTick: {
          type: "integer",
          minimum: 0,
          description:
            "Max retries dispatched per scheduler tick. Soft cap on top of the hourly throttle.",
        },
      },
    },
    schema: yup
      .object({
        enabled: yup.boolean().optional(),
        cadenceDays: yup
          .object({
            structuredContent: yup.number().integer().min(0).optional(),
            companyPublication: yup.number().integer().min(0).optional(),
            website: yup.number().integer().min(0).optional(),
            companyProfile: yup.number().integer().min(0).optional(),
            companyContact: yup.number().integer().min(0).optional(),
            companyEvaluation: yup.number().integer().min(0).optional(),
          })
          .optional()
          .noUnknown(true),
        throttle: yup
          .object({
            perStagePerHour: yup.number().integer().min(0).optional(),
            globalPerHour: yup.number().integer().min(0).optional(),
          })
          .optional()
          .noUnknown(true),
        topKPerTick: yup.number().integer().min(0).optional(),
      })
      .noUnknown(true),
    preview: (r: { enabled: boolean }) =>
      `freshness prefs updated · ${r.enabled ? "on" : "off"}`,
    run: async (args) => {
      // yup widens types past the strict shapes on `FreshnessPrefs`;
      // narrow at the boundary the same way `alerts_set_prefs` does.
      // Filter out `cadenceDays` keys with `undefined` values so we
      // don't overwrite stages with NaN when the user only mentioned
      // one.
      type CadenceMap = import("../../../shared/types").FreshnessPrefs["cadenceDays"];
      const cadenceClean: Partial<CadenceMap> = {};
      if (args.cadenceDays) {
        for (const stage of ALL_STAGES) {
          const v = (args.cadenceDays as Record<string, unknown>)[stage];
          if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
            cadenceClean[stage] = Math.round(v);
          }
        }
      }
      const next = deps.prefs.set({
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(Object.keys(cadenceClean).length > 0
          ? { cadenceDays: cadenceClean as CadenceMap }
          : {}),
        ...(args.throttle
          ? {
              throttle: args.throttle as {
                perStagePerHour: number;
                globalPerHour: number;
              },
            }
          : {}),
        ...(args.topKPerTick !== undefined
          ? { topKPerTick: args.topKPerTick }
          : {}),
      });
      deps.onPrefsChanged();
      return {
        enabled: next.enabled,
        cadenceDays: next.cadenceDays,
        throttle: next.throttle,
        topKPerTick: next.topKPerTick,
        pinned: next.pinned.length,
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

  return [scan, runNow, getPrefs, setPrefs, pin, unpin];
}
