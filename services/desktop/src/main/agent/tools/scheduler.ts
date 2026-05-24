// v0.1.267 — Scheduler-Tools (Phase S).
//
// AVA-facing Tools für wiederkehrende Aktionen. Aktuell genau ein
// Job-Kind: mail-send. Weitere Kinds (z. B. "task-completion-reminder"
// oder "watch-trigger") können later durch Registrieren eines weiteren
// Executors + Schwester-Tool ergänzt werden.
//
// Sicherheits-Constraints:
//   - Min Intervall: 1 min
//   - Max Lifetime: 7 Tage, Default 24h
//   - Runs-Cap: 1000
//   - Active-Job-Cap: 10 (enforced im Store)
//   - Mail-Empfänger MÜSSEN alle in der Mail-Allowlist sein
//     (sonst hätten wir einen Spam-Loop-Vektor)
//
// Confirm-Pflicht: schedule_mail_loop fragt IMMER via ask_user_choice
// nach. Cancel ist trivial reversibel (wieder erstellen), also kein
// Confirm dort.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { ScheduledJobsSupervisor } from "../../scheduler/supervisor";
import {
  ACTIVE_JOB_CAP,
  DEFAULT_LIFETIME_MS,
  MAX_LIFETIME_MS,
  MAX_RUNS_CAP,
  MIN_INTERVAL_MINUTES,
} from "../../scheduler/store";
import type { MailSupervisor } from "../../mail/supervisor";
import type { MailAllowlistEntry } from "../../../shared/types";

export interface SchedulerToolDeps {
  getSupervisor: () => ScheduledJobsSupervisor | null;
  /** Wird gebraucht damit schedule_mail_loop die Allowlist-Prüfung
   *  beim Anlegen machen kann (zusätzlich zur Runtime-Prüfung in jedem
   *  fire()). Lazy weil MailSupervisor erst nach Boot-Sequenz da ist. */
  getMailSupervisor: () => MailSupervisor | null;
}

function requireSched(
  deps: SchedulerToolDeps,
): ScheduledJobsSupervisor | { error: string } {
  const s = deps.getSupervisor();
  if (!s) return { error: "Scheduler ist noch nicht bereit." };
  return s;
}

export function buildSchedulerTools(deps: SchedulerToolDeps): Tool[] {
  const listTool = defineTool({
    name: "schedule_list",
    description:
      "Listet alle wiederkehrenden Jobs, die AVA aktuell für den Nutzer geplant hat (active, paused, expired, completed, cancelled). Zeigt pro Job: id, label, kind, intervalMinutes, nextRunAt, expiresAt, runsCompleted, runsCap, status, lastError. Nutze das, wenn der Nutzer fragt 'was hast du gerade alles laufen' oder bevor du `schedule_cancel` aufrufst, um die richtige id zu finden.",
    parameters: { type: "object", properties: {} },
    schema: yup.object({}).noUnknown(true),
    preview: (r: { activeCount: number; cap: number; error?: string }) =>
      r.error ? `Fehler: ${r.error}` : `${r.activeCount} / ${r.cap} aktive Jobs`,
    run: async () => {
      const supOrErr = requireSched(deps);
      if ("error" in supOrErr) return { activeCount: 0, cap: ACTIVE_JOB_CAP, jobs: [], error: supOrErr.error };
      const jobs = await supOrErr.store.list();
      const activeCount = jobs.filter((j) => j.status === "active").length;
      return { activeCount, cap: ACTIVE_JOB_CAP, jobs };
    },
  });

  const cancelTool = defineTool({
    name: "schedule_cancel",
    description:
      "Stoppt einen wiederkehrenden Job sofort. Idempotent — ein bereits gestoppter Job bleibt gestoppt. Kein Confirm-Gate, weil trivial reversibel (Job kann neu erstellt werden). Nutze `schedule_list` zuerst, wenn du die id nicht hast.",
    parameters: {
      type: "object",
      required: ["jobId"],
      properties: { jobId: { type: "string" } },
    },
    schema: yup
      .object({ jobId: yup.string().trim().min(1).required() })
      .noUnknown(true),
    preview: (r: { ok: boolean }) =>
      r.ok ? "Job gestoppt" : "Job konnte nicht gestoppt werden",
    run: async (args) => {
      const supOrErr = requireSched(deps);
      if ("error" in supOrErr) return { ok: false, error: supOrErr.error };
      await supOrErr.cancel(args.jobId);
      return { ok: true };
    },
  });

  const mailLoopTool = defineTool({
    name: "schedule_mail_loop",
    description:
      `Plant eine wiederkehrende Mail an einen oder mehrere Empfänger. Tool fragt SELBST via ask_user_choice nach Bestätigung. Sicherheits-Regeln:\n` +
      `- Min Intervall ${MIN_INTERVAL_MINUTES} min\n` +
      `- Max Laufzeit ${MAX_LIFETIME_MS / 1000 / 60 / 60 / 24} Tage (Default 24h)\n` +
      `- Max ${MAX_RUNS_CAP} Runs pro Job\n` +
      `- Max ${ACTIVE_JOB_CAP} parallele Jobs\n` +
      `- ALLE Empfänger müssen in der Mail-Allowlist stehen (sonst hätten wir einen Spam-Loop-Vektor)\n` +
      `- outboundEnabled-Master-Schalter im Mail-Konto muss true sein\n\n` +
      `Wenn die erste Mail SOFORT raus soll: \`firstRunImmediately: true\`. Sonst läuft der erste Send nach \`intervalMinutes\`. Per Default expiriert der Job nach 24h — der User kann via \`expiresInHours\` (max 168 = 7 Tage) verlängern.\n\n` +
      `Stoppen: \`schedule_cancel\` mit der id aus diesem Tool oder via \`schedule_list\`. Bei "stopp"/"stop"/"abbrechen"/"hör auf" vom User SOFORT cancel aufrufen.`,
    parameters: {
      type: "object",
      required: ["label", "to", "subject", "text", "intervalMinutes"],
      properties: {
        label: {
          type: "string",
          description: "Kurze Beschreibung was der Job tut — wird in Listings angezeigt.",
        },
        to: {
          type: "array",
          items: { type: "string" },
          description: "Empfänger (mind. 1). Müssen in der Mail-Allowlist stehen.",
        },
        cc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        intervalMinutes: {
          type: "integer",
          description: `Intervall in Minuten. Minimum ${MIN_INTERVAL_MINUTES}.`,
        },
        firstRunImmediately: {
          type: "boolean",
          description:
            "true = erste Mail sofort, dann nach Intervall weiter. Default false (erst nach Intervall).",
        },
        expiresInHours: {
          type: "integer",
          description: `Auto-Stop nach N Stunden. Default 24, max ${MAX_LIFETIME_MS / 1000 / 60 / 60} (7 Tage).`,
        },
        runsCap: {
          type: "integer",
          description: `Max Anzahl Runs. Default ${MAX_RUNS_CAP}.`,
        },
      },
    },
    schema: yup
      .object({
        label: yup.string().trim().min(1).max(200).required(),
        to: yup
          .array()
          .of(yup.string().email().required())
          .min(1)
          .required(),
        cc: yup.array().of(yup.string().email().required()).optional(),
        subject: yup.string().trim().min(1).max(998).required(),
        text: yup.string().trim().min(1).max(50_000).required(),
        intervalMinutes: yup
          .number()
          .integer()
          .min(MIN_INTERVAL_MINUTES)
          .required(),
        firstRunImmediately: yup.boolean().optional(),
        expiresInHours: yup
          .number()
          .integer()
          .min(1)
          .max(MAX_LIFETIME_MS / 1000 / 60 / 60)
          .optional(),
        runsCap: yup.number().integer().min(1).max(MAX_RUNS_CAP).optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; jobId?: string; error?: string }) =>
      r.applied
        ? `Job geplant (${r.jobId})`
        : r.error
          ? `Fehler: ${r.error}`
          : "Nicht geplant",
    run: async (args, ctx) => {
      const supOrErr = requireSched(deps);
      if ("error" in supOrErr) return { applied: false, error: supOrErr.error };
      const sup = supOrErr;
      const mailSup = deps.getMailSupervisor();
      if (!mailSup) {
        return {
          applied: false,
          error: "Mail-Supervisor ist nicht bereit — Mail-Konto in Einstellungen konfigurieren.",
        };
      }
      const account = await mailSup.getStore().getAccount();
      if (!account) {
        return { applied: false, error: "Kein Mail-Konto konfiguriert." };
      }
      if (!account.outboundEnabled) {
        return {
          applied: false,
          error:
            "Mail-Outbound ist deaktiviert (Settings → Datenquellen → Mail). Bitte erst freischalten.",
        };
      }

      // Allowlist-Pflichtprüfung — alle Empfänger.
      const allowlist = await mailSup.getStore().listAllowlist();
      const recipients = [...args.to, ...(args.cc ?? [])];
      const untrusted = recipients.filter((r) => !isInAllowlist(r, allowlist));
      if (untrusted.length > 0) {
        return {
          applied: false,
          error: `Geplante Mails dürfen nur an Allowlist-Empfänger gehen — nicht in Allowlist: ${untrusted.join(", ")}. Bitte erst via mail_allowlist_add hinzufügen.`,
        };
      }

      const expiresInHours = args.expiresInHours ?? Math.round(DEFAULT_LIFETIME_MS / 1000 / 60 / 60);
      const expiresAt = new Date(
        Date.now() + expiresInHours * 60 * 60 * 1000,
      ).toISOString();

      const draft =
        `Ich möchte folgenden wiederkehrenden Job einrichten:\n\n` +
        `Label: ${args.label}\n` +
        `An: ${args.to.join(", ")}${args.cc && args.cc.length > 0 ? `\nCC: ${args.cc.join(", ")}` : ""}\n` +
        `Betreff: ${args.subject}\n` +
        `Intervall: alle ${args.intervalMinutes} Minute(n)\n` +
        `${args.firstRunImmediately ? "Erste Mail: sofort" : `Erste Mail: in ${args.intervalMinutes} Minute(n)`}\n` +
        `Auto-Stop: nach ${expiresInHours} Stunde(n) (${expiresAt})\n` +
        `${args.runsCap ? `Max Runs: ${args.runsCap}\n` : ""}\n` +
        `Inhalt:\n${args.text.slice(0, 1000)}${args.text.length > 1000 ? "\n[…]" : ""}`;

      const value = await ctx.ui.askChoice(
        draft,
        [
          { value: "create", label: "Job starten", description: "Job wird aktiv" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };

      try {
        const job = await sup.createMailLoop({
          label: args.label,
          payload: {
            to: args.to,
            ...(args.cc && args.cc.length > 0 ? { cc: args.cc } : {}),
            subject: args.subject,
            text: args.text,
          },
          intervalMinutes: args.intervalMinutes,
          firstRunImmediately: args.firstRunImmediately ?? false,
          expiresAt,
          runsCap: args.runsCap,
          source: "agent",
        });
        return {
          applied: true,
          jobId: job.id,
          nextRunAt: job.nextRunAt,
          expiresAt: job.expiresAt,
        };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // v0.1.305 — Reminder-Tool. Anders als schedule_mail_loop ist das
  // ein One-Shot per Default (runsCap=1) und braucht keinen Mail-
  // Account. Triggert bei Fälligkeit einen Alert unter „Meldungen"
  // + OS-Notification.
  const reminderTool = defineTool({
    name: "schedule_reminder",
    description:
      `Erinnerung zu einer bestimmten Uhrzeit (Datum + Zeit). Bei Fälligkeit erstellt AVA eine Meldung unter "Meldungen" mit Headline=label und Body=prompt, plus eine OS-Notification. Use-Case: "Erinnere mich am 28. Mai 14:00, Sascha Kluck anzurufen, Tel +49 174 ...". Standard ist einmalig (runsCap=1). Wenn der User explizit "jeden Montag", "wöchentlich", "täglich" sagt → recurring via intervalMinutes + runsCap >1.\n\n` +
      `WICHTIG: prompt ist die KOMPLETTE Reminder-Botschaft die der User später sehen wird — inkl. Kontext (Name, Telefon, Hintergrund) den der User dir gerade gegeben hat. Schreib sie so, dass der User in 2 Wochen ohne dich nochmal kontaktieren zu müssen alles weiß. Maximal 500 Zeichen.\n\n` +
      `dueAt: ISO-8601-Datetime in Lokalzeit (z. B. "2026-05-28T14:00:00"). Muss in der Zukunft liegen, max 1 Jahr voraus. ` +
      `Tool fragt SELBST via ask_user_choice nach Bestätigung. Cancel via schedule_cancel.`,
    parameters: {
      type: "object",
      required: ["label", "dueAt", "prompt"],
      properties: {
        label: {
          type: "string",
          description:
            "Kurztitel für die Meldungs-Liste (≤120 Zeichen). Beispiel: 'Anruf Sascha Kluck'.",
        },
        dueAt: {
          type: "string",
          description:
            "ISO-8601-Datetime, lokale Zeit. Beispiel: '2026-05-28T14:00:00'. Muss in der Zukunft liegen, max 365 Tage voraus.",
        },
        prompt: {
          type: "string",
          description:
            "Vollständige Reminder-Botschaft. Schreib alles rein was der User dann braucht: Name, Telefonnummer, Anlass, eventuell Kontext. ≤500 Zeichen.",
        },
        intervalMinutes: {
          type: "integer",
          description:
            "OPTIONAL für recurring. Min 1, sonst leer. Beispiel: 10080 = wöchentlich.",
        },
        runsCap: {
          type: "integer",
          description:
            "OPTIONAL. Max Anzahl Auslösungen. Default 1 (einmaliger Reminder). Bei recurring auf z. B. 12 setzen.",
        },
        companyId: {
          type: "string",
          description:
            "OPTIONAL — wenn die Erinnerung an eine konkrete Firma hängt (für Deep-Link in der Meldungs-Liste).",
        },
        companyName: {
          type: "string",
          description:
            "OPTIONAL — Firmenname für die Meldungs-Anzeige.",
        },
      },
    },
    schema: yup
      .object({
        label: yup.string().trim().min(1).max(120).required(),
        dueAt: yup.string().trim().required(),
        prompt: yup.string().trim().min(1).max(500).required(),
        intervalMinutes: yup.number().integer().min(1).optional(),
        runsCap: yup.number().integer().min(1).max(MAX_RUNS_CAP).optional(),
        companyId: yup.string().trim().optional(),
        companyName: yup.string().trim().optional(),
      })
      .noUnknown(true),
    preview: (r: { applied: boolean; jobId?: string; error?: string }) =>
      r.applied
        ? `Reminder geplant (${r.jobId})`
        : r.error
          ? `Fehler: ${r.error}`
          : "Reminder nicht geplant",
    run: async (args, ctx) => {
      const supOrErr = requireSched(deps);
      if ("error" in supOrErr) return { applied: false, error: supOrErr.error };
      const sup = supOrErr;

      const dueMs = Date.parse(args.dueAt);
      if (!Number.isFinite(dueMs)) {
        return {
          applied: false,
          error: `dueAt "${args.dueAt}" konnte nicht als ISO-Datum geparst werden.`,
        };
      }
      const now = Date.now();
      if (dueMs <= now + 30_000) {
        return {
          applied: false,
          error: `dueAt liegt in der Vergangenheit oder unter 30s in der Zukunft.`,
        };
      }
      const maxFutureMs = 365 * 24 * 60 * 60 * 1000;
      if (dueMs > now + maxFutureMs) {
        return {
          applied: false,
          error: `dueAt liegt mehr als 1 Jahr in der Zukunft — bitte näher planen.`,
        };
      }

      const recurring = (args.runsCap ?? 1) > 1;
      const intervalMinutes = recurring ? args.intervalMinutes ?? 0 : 0;
      if (recurring && intervalMinutes < 1) {
        return {
          applied: false,
          error: `runsCap > 1 verlangt intervalMinutes >= 1 (recurring).`,
        };
      }
      const runsCap = args.runsCap ?? 1;

      const dueDate = new Date(dueMs);
      const formatted = dueDate.toLocaleString("de-DE", {
        weekday: "short",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      const draft =
        `Reminder anlegen?\n\n` +
        `Label: ${args.label}\n` +
        `Wann: ${formatted}\n` +
        `${recurring ? `Wiederholung: alle ${intervalMinutes} min, max ${runsCap}× total\n` : `Einmalig (one-shot)\n`}` +
        `${args.companyName ? `Firma: ${args.companyName}\n` : ""}` +
        `\nBotschaft:\n${args.prompt}`;

      const value = await ctx.ui.askChoice(
        draft,
        [
          { value: "create", label: "Reminder anlegen" },
          { value: "cancel", label: "Verwerfen" },
        ],
        ctx.signal,
      );
      if (value !== "create") return { applied: false };

      // expiresAt: bei recurring 1y voraus, bei one-shot 1d nach dueAt
      const expiresAt = recurring
        ? new Date(now + maxFutureMs).toISOString()
        : new Date(dueMs + 24 * 60 * 60 * 1000).toISOString();

      try {
        const job = await sup.createReminder({
          label: args.label,
          payload: {
            prompt: args.prompt,
            ...(args.companyId ? { companyId: args.companyId } : {}),
            ...(args.companyName ? { companyName: args.companyName } : {}),
          },
          firstRunAt: dueDate.toISOString(),
          intervalMinutes,
          expiresAt,
          runsCap,
          source: "agent",
        });
        return {
          applied: true,
          jobId: job.id,
          dueAt: job.nextRunAt,
          recurring,
        };
      } catch (err) {
        return {
          applied: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  return [listTool, mailLoopTool, cancelTool, reminderTool];
}

function isInAllowlist(
  address: string,
  allowlist: MailAllowlistEntry[],
): boolean {
  const addr = address.toLowerCase().trim();
  if (!addr.includes("@")) return false;
  const [, domain] = addr.split("@");
  for (const entry of allowlist) {
    const pattern = entry.pattern.toLowerCase().trim();
    if (pattern === addr) return true;
    if (pattern.startsWith("*@")) {
      const patternDomain = pattern.slice(2);
      if (patternDomain.startsWith("*.")) {
        const root = patternDomain.slice(2);
        if (domain === root || domain?.endsWith(`.${root}`)) return true;
      } else if (domain === patternDomain) {
        return true;
      }
    }
  }
  return false;
}
