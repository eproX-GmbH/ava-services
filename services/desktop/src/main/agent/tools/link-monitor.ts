import * as yup from "yup";
import { defineTool, userDeclined } from "../define-tool";
import type { Tool } from "../types";
import type { LinkMonitorSupervisor } from "../../link-monitor/supervisor";
import {
  LINK_MONITOR_ACTIVE_CAP,
  LINK_MONITOR_MAX_INTERVAL_MINUTES,
  LINK_MONITOR_MIN_INTERVAL_MINUTES,
  type LinkMonitor,
  type LinkMonitorFrequencyPreset,
} from "../../../shared/types";

// LM6 — Agent-Tools für die Link-Überwachung.
//
// Sieben Tools, ein Schema: register / list / update / remove / pause /
// resume / run_now. `register` ist das einzige mit Propose-and-Confirm:
// es zeigt eine Frequenz-Auswahl via ask_user_choice (genau die UX aus
// dem Brief: „Soll ich überwachen? Alle 5 Min / Stündlich / Täglich /
// Wöchentlich") und legt erst auf Bestätigung an. Die übrigen sind
// direkte Reads / explizite Operationen.
//
// Frei wählbare Frequenzen (z. B. „alle 90 Minuten") gibt der Agent über
// `intervalMinutes` an; die ask_user_choice-Presets decken die
// Standardfälle ab.

const PRESET_VALUES: readonly LinkMonitorFrequencyPreset[] = [
  "5min",
  "15min",
  "hourly",
  "daily",
  "weekly",
  "custom",
];

export interface LinkMonitorToolDeps {
  getSupervisor: () => LinkMonitorSupervisor | null;
}

function presetLabel(p: LinkMonitorFrequencyPreset): string {
  switch (p) {
    case "5min":
      return "alle 5 Minuten";
    case "15min":
      return "alle 15 Minuten";
    case "hourly":
      return "stündlich";
    case "daily":
      return "täglich";
    case "weekly":
      return "wöchentlich";
    case "custom":
      return "benutzerdefiniert";
  }
}

function intervalLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `alle ${minutes / (24 * 60)} Tage`;
  if (minutes % 60 === 0) return `alle ${minutes / 60} Stunden`;
  return `alle ${minutes} Minuten`;
}

export function buildLinkMonitorTools(deps: LinkMonitorToolDeps): Tool[] {
  const requireSup = (): LinkMonitorSupervisor => {
    const s = deps.getSupervisor();
    if (!s) throw new Error("Link-Überwachung ist noch nicht bereit.");
    return s;
  };

  const list = defineTool({
    name: "link_monitor_list",
    description:
      "Liste alle überwachten Links (neueste zuerst) mit id, url, Anweisung, Frequenz, Status (active/paused/error), letztem Lauf + letzter erkannter Änderung. Nutze dies, wenn der Nutzer fragt 'welche Links überwachst du' / 'was beobachtest du gerade'. Gibt activeCount + cap (max 5 gleichzeitig aktiv) zurück.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { activeCount: number; cap: number }) =>
      `${r.activeCount} / ${r.cap} aktive Überwachungen`,
    run: async () => {
      const sup = requireSup();
      const monitors = await sup.store.list();
      return {
        activeCount: monitors.filter((m) => m.status === "active").length,
        cap: LINK_MONITOR_ACTIVE_CAP,
        items: monitors.map(toToolView),
      };
    },
  });

  const register = defineTool({
    name: "link_monitor_register",
    description:
      "Richte eine neue Link-Überwachung ein. Nutze dies, wenn der Nutzer einen Link überwachen lassen will ('beobachte diese Seite', 'sag mir wenn sich hier was ändert', 'gib mir alle X Minuten ein Update') ODER wenn er einen Link kommentarlos schickt (dann zuerst nachfragen, ob überwacht werden soll). Übergib `instructions`, worauf zu achten ist (z. B. 'gehe die Pagination durch, achte auf neue Produkte'). Frequenz: gib entweder `frequencyPreset` ODER `intervalMinutes` (5–10080) an; ohne Angabe fragt das Tool die Frequenz interaktiv ab und nutzt sonst täglich. LinkedIn-Links nutzen automatisch die hinterlegte Anmeldung. Maximal 5 gleichzeitig aktiv — überzählige werden pausiert angelegt.",
    parameters: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Die zu überwachende URL (mit oder ohne https://).",
        },
        instructions: {
          type: "string",
          description:
            "Optional. Worauf soll geachtet werden? Steuert auch, ob Pagination versucht wird (z. B. 'alle Seiten durchgehen, neue Produkte').",
        },
        frequencyPreset: {
          type: "string",
          enum: ["5min", "15min", "hourly", "daily", "weekly"],
          description:
            "Optional. Vordefinierte Frequenz. Alternativ intervalMinutes.",
        },
        intervalMinutes: {
          type: "number",
          description:
            "Optional. Frei wählbares Intervall in Minuten (5–10080). Hat Vorrang vor frequencyPreset.",
        },
        label: {
          type: "string",
          description: "Optional. Anzeigename; Standard ist der Host der URL.",
        },
      },
    },
    schema: yup
      .object({
        url: yup.string().trim().min(3).max(2000).required(),
        instructions: yup.string().trim().max(2000).optional(),
        frequencyPreset: yup
          .string()
          .oneOf(PRESET_VALUES as unknown as string[])
          .optional(),
        intervalMinutes: yup
          .number()
          .min(LINK_MONITOR_MIN_INTERVAL_MINUTES)
          .max(LINK_MONITOR_MAX_INTERVAL_MINUTES)
          .optional(),
        label: yup.string().trim().max(200).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; status?: string }) =>
      r.applied ? `Überwachung eingerichtet (${r.status})` : "Abgelehnt",
    run: async (args, ctx) => {
      const sup = requireSup();

      let preset = args.frequencyPreset as
        | LinkMonitorFrequencyPreset
        | undefined;
      let minutes = args.intervalMinutes;

      if (!preset && minutes === undefined) {
        // Brief-UX: Frequenz interaktiv abfragen.
        const choice = await ctx.ui.askChoice(
          `Soll ich diesen Link für dich überwachen?\n\n  ${args.url.trim()}\n\nWenn ja: in welcher Regelmäßigkeit?`,
          [
            { value: "5min", label: "Alle 5 Minuten", description: "Sehr häufig" },
            { value: "hourly", label: "Stündlich", description: "" },
            {
              value: "daily",
              label: "Täglich (empfohlen)",
              description: "Standard",
            },
            { value: "weekly", label: "Wöchentlich", description: "" },
            { value: "decline", label: "Nicht überwachen", description: "" },
          ],
          ctx.signal,
        );
        if (choice === "decline") return userDeclined();
        preset = choice as LinkMonitorFrequencyPreset;
      } else {
        const label =
          minutes !== undefined
            ? intervalLabel(minutes)
            : presetLabel(preset ?? "daily");
        const ok = await ctx.ui.askChoice(
          `Link überwachen (${label})?\n\n  ${args.url.trim()}`,
          [
            { value: "accept", label: "Ja, einrichten", description: "" },
            { value: "decline", label: "Abbrechen", description: "" },
          ],
          ctx.signal,
        );
        if (ok !== "accept") return userDeclined();
      }

      try {
        const monitor = await sup.createMonitor(
          {
            url: args.url,
            instructions: args.instructions,
            frequencyPreset: preset,
            intervalMinutes: minutes,
            label: args.label,
          },
          "agent",
        );
        const note =
          monitor.status === "paused"
            ? ` (max ${LINK_MONITOR_ACTIVE_CAP} gleichzeitig aktiv erreicht — pausiert angelegt; pausiere eine andere Überwachung, um sie zu aktivieren)`
            : "";
        return {
          applied: true,
          monitorId: monitor.id,
          status: monitor.status,
          isLinkedIn: monitor.isLinkedIn,
          intervalMinutes: monitor.intervalMinutes,
          message: `Überwache „${monitor.label}" ${intervalLabel(monitor.intervalMinutes)}${note}.`,
        };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const update = defineTool({
    name: "link_monitor_update",
    description:
      "Aktualisiere eine bestehende Überwachung (url, Anweisung, Frequenz oder Label). id zuvor via link_monitor_list holen. Nur die übergebenen Felder werden geändert.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        instructions: { type: "string" },
        frequencyPreset: {
          type: "string",
          enum: ["5min", "15min", "hourly", "daily", "weekly"],
        },
        intervalMinutes: { type: "number" },
        label: { type: "string" },
      },
    },
    schema: yup
      .object({
        id: yup.string().required().min(1),
        url: yup.string().trim().min(3).max(2000).optional(),
        instructions: yup.string().trim().max(2000).optional(),
        frequencyPreset: yup
          .string()
          .oneOf(PRESET_VALUES as unknown as string[])
          .optional(),
        intervalMinutes: yup
          .number()
          .min(LINK_MONITOR_MIN_INTERVAL_MINUTES)
          .max(LINK_MONITOR_MAX_INTERVAL_MINUTES)
          .optional(),
        label: yup.string().trim().max(200).optional(),
      })
      .noUnknown(true),
    preview: (r: { ok: boolean }) => (r.ok ? "aktualisiert" : "nicht gefunden"),
    run: async (args) => {
      const sup = requireSup();
      const next = await sup.update(args.id, {
        url: args.url,
        instructions: args.instructions,
        frequencyPreset: args.frequencyPreset as
          | LinkMonitorFrequencyPreset
          | undefined,
        intervalMinutes: args.intervalMinutes,
        label: args.label,
      });
      return next ? { ok: true, monitor: toToolView(next) } : { ok: false };
    },
  });

  const remove = defineTool({
    name: "link_monitor_remove",
    description:
      "Lösche eine Überwachung samt Verlauf (idempotent). id via link_monitor_list holen. Nutze dies bei 'überwache X nicht mehr' / 'lösche die Überwachung'.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup.object({ id: yup.string().required().min(1) }).noUnknown(true),
    preview: () => "entfernt",
    run: async (args) => {
      const sup = requireSup();
      await sup.remove(args.id);
      return { ok: true };
    },
  });

  const pause = defineTool({
    name: "link_monitor_pause",
    description:
      "Pausiere eine Überwachung, ohne sie zu löschen (zählt dann nicht mehr gegen das 5-aktiv-Limit). Resume via link_monitor_resume.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup.object({ id: yup.string().required().min(1) }).noUnknown(true),
    preview: () => "pausiert",
    run: async (args) => {
      const sup = requireSup();
      await sup.pause(args.id);
      return { ok: true };
    },
  });

  const resume = defineTool({
    name: "link_monitor_resume",
    description:
      "Setze eine pausierte Überwachung fort. Schlägt mit klarer Meldung fehl, wenn bereits 5 aktiv sind (zuerst eine andere pausieren).",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup.object({ id: yup.string().required().min(1) }).noUnknown(true),
    preview: (r: { ok: boolean }) => (r.ok ? "fortgesetzt" : "nicht fortgesetzt"),
    run: async (args) => {
      const sup = requireSup();
      try {
        await sup.resume(args.id);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  const runNow = defineTool({
    name: "link_monitor_run_now",
    description:
      "Führe für eine Überwachung sofort einen Durchlauf aus (statt auf den nächsten Timer zu warten). Nützlich zum Testen oder bei 'prüf jetzt mal'.",
    parameters: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
    schema: yup.object({ id: yup.string().required().min(1) }).noUnknown(true),
    preview: () => "Durchlauf gestartet",
    run: async (args) => {
      const sup = requireSup();
      void sup.runNow(args.id);
      return { ok: true, message: "Durchlauf gestartet." };
    },
  });

  return [list, register, update, remove, pause, resume, runNow];
}

function toToolView(m: LinkMonitor): {
  id: string;
  url: string;
  label: string;
  instructions: string;
  intervalMinutes: number;
  status: string;
  isLinkedIn: boolean;
  lastCheckedAt: string | null;
  lastOutcome: string | null;
  lastChangedAt: string | null;
  lastChangeSummary: string | null;
} {
  return {
    id: m.id,
    url: m.url,
    label: m.label,
    instructions: m.instructions,
    intervalMinutes: m.intervalMinutes,
    status: m.status,
    isLinkedIn: m.isLinkedIn,
    lastCheckedAt: m.lastCheckedAt,
    lastOutcome: m.lastOutcome,
    lastChangedAt: m.lastChangedAt,
    lastChangeSummary: m.lastChangeSummary,
  };
}
