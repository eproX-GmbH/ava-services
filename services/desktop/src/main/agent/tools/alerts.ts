import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { AlertsStore } from "../alerts-store";
import type { AlertPrefsStore } from "../alert-prefs-store";
import type { Heartbeat } from "../heartbeat";
import type {
  AlertCadenceMinutes,
  AlertSeverity,
} from "../../../shared/types";

// Alert / heartbeat self-service tools (Phase 8.f5).
//
// The Settings panel exposes the same knobs as IPC, but the user often
// wants to drive these from chat — "lösche alle Meldungen", "stell den
// heartbeat auf stündlich", "schau jetzt nach". One tool per intent so
// small models pick the right one from name + description alone, no
// "action: 'list'|'set'|'clear'" mega-tool.
//
// All tools mutate the same in-memory state the renderer + heartbeat
// see; the AlertsStore broadcasts changes via the IPC `alerts:changed`
// channel main-side, so the bell + /alerts route refresh live without
// the agent having to call a separate UI tool.

const CADENCE_VALUES: readonly AlertCadenceMinutes[] = [0, 5, 15, 30, 60];
const SEVERITY_VALUES: readonly AlertSeverity[] = ["info", "warn", "urgent"];

export interface AlertsToolDeps {
  alerts: AlertsStore;
  prefs: AlertPrefsStore;
  heartbeat: Heartbeat;
  /** Called after every mutation so the renderer's bell + list refresh
   *  without polling. Mirrors the IPC `alerts:changed` push that
   *  main/index.ts already wires; we route through this callback so the
   *  tool layer doesn't depend on Electron. */
  onChanged: () => void;
}

export function buildAlertsTools(deps: AlertsToolDeps): Tool[] {
  const list = defineTool({
    name: "alerts_list",
    description:
      "List current heartbeat alerts (newest first). Use when the user asks 'welche Meldungen gibt es', 'was ist neu', 'zeig mir die letzten Alarme'. Optional `unreadOnly` filters to entries the user hasn't seen; `limit` defaults to 20.",
    parameters: {
      type: "object",
      properties: {
        unreadOnly: {
          type: "boolean",
          description: "When true, only return entries with seenAt=null.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max entries to return. Default 20.",
        },
      },
    },
    schema: yup
      .object({
        unreadOnly: yup.boolean().optional(),
        limit: yup.number().integer().min(1).max(200).optional(),
      })
      .noUnknown(true),
    preview: (r: { count: number; unreadOnly: boolean }) =>
      `${r.count} ${r.unreadOnly ? "unread alert" : "alert"}${r.count === 1 ? "" : "s"}`,
    run: async (args) => {
      const limit = args.limit ?? 20;
      const all = deps.alerts.list();
      const filtered = args.unreadOnly
        ? all.filter((a) => a.seenAt === null)
        : all;
      return {
        count: filtered.length,
        unreadOnly: args.unreadOnly === true,
        items: filtered.slice(0, limit).map((a) => ({
          id: a.id,
          companyId: a.companyId,
          companyName: a.companyName,
          severity: a.severity,
          kind: a.kind,
          headline: a.headline,
          rationale: a.rationale,
          createdAt: a.createdAt,
          unread: a.seenAt === null,
        })),
      };
    },
  });

  const dismissOne = defineTool({
    name: "alerts_dismiss",
    description:
      "Dismiss (delete from view) a single alert by id. The id comes from `alerts_list`. The row stays on disk for audit but is never shown again. Use when the user names a specific alert.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "Alert id from `alerts_list[].id`.",
        },
      },
    },
    schema: yup
      .object({ id: yup.string().required().min(1) })
      .noUnknown(true),
    preview: (r: { ok: boolean; id: string }) =>
      r.ok ? `dismissed ${r.id.slice(0, 8)}…` : "alert not found",
    run: async (args) => {
      const ok = deps.alerts.dismiss(args.id);
      if (ok) deps.onChanged();
      return { ok, id: args.id };
    },
  });

  const dismissAll = defineTool({
    name: "alerts_dismiss_all",
    description:
      "Dismiss EVERY currently-visible alert in one shot. Use when the user says 'lösche alle Meldungen', 'clear all alerts', 'verwerfe alles'. Returns the number of rows touched. Irreversible from the user's perspective; the rows remain on disk for audit.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { dismissed: number }) =>
      `dismissed ${r.dismissed} alert${r.dismissed === 1 ? "" : "s"}`,
    run: async () => {
      const dismissed = deps.alerts.dismissAll();
      if (dismissed > 0) deps.onChanged();
      return { dismissed };
    },
  });

  const triggerHeartbeat = defineTool({
    name: "alerts_trigger_heartbeat",
    description:
      "Force a heartbeat tick NOW, regardless of cadence. Returns the per-candidate decision log (alerted / duplicate / not-worth / judge-error) plus counters. Use when the user says 'check jetzt', 'run heartbeat', 'prüfe nach neuen Meldungen'. Same effect as the 'Jetzt auslösen' button in Settings.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { skipped: boolean; alertsCreated: number; candidatesSeen: number }) =>
      r.skipped
        ? "heartbeat skipped"
        : `heartbeat: ${r.candidatesSeen} candidate(s) → ${r.alertsCreated} new alert(s)`,
    run: async () => {
      const info = await deps.heartbeat.triggerNow();
      return {
        startedAt: info.startedAt,
        finishedAt: info.finishedAt,
        candidatesSeen: info.candidatesSeen,
        alertsCreated: info.alertsCreated,
        duplicates: info.duplicates,
        skipped: info.skipped,
        ...(info.reason ? { reason: info.reason } : {}),
        decisions: info.decisions.map((d) => ({
          companyName: d.companyName,
          kind: d.kind,
          outcome: d.outcome,
          rationale: d.rationale,
          ...(d.severity ? { severity: d.severity } : {}),
        })),
      };
    },
  });

  const getPrefs = defineTool({
    name: "alerts_get_prefs",
    description:
      "Read the current heartbeat / push preferences (cadence, push toggle, severity threshold, quiet hours). Call this before `alerts_set_prefs` if you're unsure of the current state.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { cadenceMinutes: number; pushEnabled: boolean }) =>
      `cadence ${r.cadenceMinutes} min · push ${r.pushEnabled ? "on" : "off"}`,
    run: async () => deps.prefs.get(),
  });

  const setPrefs = defineTool({
    name: "alerts_set_prefs",
    description:
      "Patch heartbeat / push preferences. Only fields you set are changed; everything else stays. Use when the user says things like 'heartbeat alle 30 Minuten', 'push aus', 'nur dringende Meldungen pushen', 'ruhezeiten von 20 bis 8 Uhr', 'keine Push am Wochenende'. For ruhezeiten pass `quietHours.startMinute` / `endMinute` as minutes-since-midnight in local time (e.g. 19:00 = 1140, 7:00 = 420).",
    parameters: {
      type: "object",
      properties: {
        cadenceMinutes: {
          type: "integer",
          enum: [0, 5, 15, 30, 60],
          description:
            "Heartbeat cadence in minutes. 0 disables the timer (manual triggers still work).",
        },
        pushEnabled: {
          type: "boolean",
          description: "Toggle native OS notifications.",
        },
        pushSeverityThreshold: {
          type: "string",
          enum: ["info", "warn", "urgent"],
          description:
            "Minimum severity that fires a native push. Lower-severity alerts still land in the bell.",
        },
        quietHours: {
          type: "object",
          properties: {
            enabled: { type: "boolean" },
            startMinute: { type: "integer", minimum: 0, maximum: 1439 },
            endMinute: { type: "integer", minimum: 0, maximum: 1439 },
            silenceWeekends: { type: "boolean" },
          },
          description:
            "Window during which native push is silenced. Wrap-around (e.g. 19:00→07:00) is supported.",
        },
      },
    },
    schema: yup
      .object({
        cadenceMinutes: yup.number().oneOf(CADENCE_VALUES).optional(),
        pushEnabled: yup.boolean().optional(),
        pushSeverityThreshold: yup
          .string()
          .oneOf(SEVERITY_VALUES)
          .optional(),
        quietHours: yup
          .object({
            enabled: yup.boolean().optional(),
            startMinute: yup.number().integer().min(0).max(1439).optional(),
            endMinute: yup.number().integer().min(0).max(1439).optional(),
            silenceWeekends: yup.boolean().optional(),
          })
          .optional()
          .noUnknown(true),
      })
      .noUnknown(true),
    preview: (r: { cadenceMinutes: number; pushEnabled: boolean }) =>
      `prefs updated: cadence ${r.cadenceMinutes} min · push ${r.pushEnabled ? "on" : "off"}`,
    run: async (args) => {
      // yup's `oneOf` widens to `number` / `string` rather than the
      // narrowed enum unions on `AlertPrefs`. Cast here at the boundary;
      // the runtime values are guaranteed valid by the same `oneOf` check.
      const next = deps.prefs.set(args as Partial<import("../../../shared/types").AlertPrefs>);
      return next;
    },
  });

  const purge = defineTool({
    name: "alerts_purge",
    description:
      "Hard-delete heartbeat alerts from disk so the dedup index forgets them and the next heartbeat tick can re-evaluate the same candidates from scratch. Use when the user says things like 'lösche endgültig', 'wirklich löschen', 'retrigger alle Meldungen', 'frische Bewertung', 'wipe alerts', 'reset', or when `alerts_dismiss_all` returned `dismissed: 0` because everything is already soft-dismissed and the user expected an actual reset. Pass `dismissedOnly: true` to only purge already-dismissed rows and keep currently-visible ones; default removes EVERYTHING. Irreversible.",
    parameters: {
      type: "object",
      properties: {
        dismissedOnly: {
          type: "boolean",
          description:
            "When true, only purge rows the user already dismissed; keeps active (still-visible) alerts. Default false (purge all).",
        },
      },
    },
    schema: yup
      .object({ dismissedOnly: yup.boolean().optional() })
      .noUnknown(true),
    preview: (r: { removed: number; dismissedOnly: boolean }) =>
      `purged ${r.removed} ${r.dismissedOnly ? "dismissed alert" : "alert"}${r.removed === 1 ? "" : "s"}`,
    run: async (args) => {
      const result = deps.alerts.purge({ dismissedOnly: args.dismissedOnly });
      if (result.removed > 0) deps.onChanged();
      return {
        removed: result.removed,
        dismissedOnly: args.dismissedOnly === true,
      };
    },
  });

  return [
    list,
    dismissOne,
    dismissAll,
    purge,
    triggerHeartbeat,
    getPrefs,
    setPrefs,
  ];
}
