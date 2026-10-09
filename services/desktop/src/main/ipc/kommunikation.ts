// IPC-Handler „Telegram, Mail, geplante Aufgaben, E-Mail-Muster“, aus src/main/index.ts herausgelöst (docs/PLAN_AVA_CLOUD.md §12, R2).
// Die Handler sind unverändert; die Abhängigkeiten kommen explizit über `deps`.
// Spät gesetzte Dienste (vormals `let` in index.ts) werden als Getter übergeben.

import { ipcMain } from "electron";
import { escapeHtml as telegramEscapeHtml, getMe as telegramGetMe, getUpdates as telegramGetUpdates, sendMessage as telegramSendMessage } from "../telegram/client";
import { join } from "node:path";
import type { MailAccount, MailAllowlistEntry, MailCredentialsPayload, MailSnapshot, ScheduledJob, TelegramConfig, TelegramSnapshot } from "../../shared/types";
import type { AuditEventInput } from "../audit/audit-types";
import type { EmailMusterSupervisor } from "../contacts/email-muster/supervisor";
import type { MailSupervisor } from "../mail/supervisor";
import type { ScheduledJobsSupervisor } from "../scheduler/supervisor";
import type { TelegramStore } from "../telegram/store";

export interface KommunikationIpcDeps {
  audit: (input: AuditEventInput) => void;
  broadcastMailSnapshot: (snapshot: MailSnapshot) => void;
  emailMuster: { readonly current: EmailMusterSupervisor | null };
  mailSupervisor: { readonly current: MailSupervisor | null };
  scheduledJobsSupervisor: { readonly current: ScheduledJobsSupervisor | null };
  telegramSnapshot: () => TelegramSnapshot;
  telegramStore: TelegramStore;
}

export function registerKommunikationIpc(deps: KommunikationIpcDeps): void {
  const { audit, broadcastMailSnapshot, emailMuster, mailSupervisor, scheduledJobsSupervisor, telegramSnapshot, telegramStore } = deps;

  ipcMain.handle("emailMuster:status", () => emailMuster.current?.status() ?? null);

  ipcMain.handle("emailMuster:setConfig", (_e, patch: { enabled?: boolean; zuordnungAktiv?: boolean; ungeprueftAnzeigen?: boolean }) =>
    emailMuster.current?.setConfig({
      ...(patch.enabled !== undefined ? { enabled: patch.enabled === true } : {}),
      ...(patch.zuordnungAktiv !== undefined ? { zuordnungAktiv: patch.zuordnungAktiv === true } : {}),
      ...(patch.ungeprueftAnzeigen !== undefined ? { ungeprueftAnzeigen: patch.ungeprueftAnzeigen === true } : {}),
    }) ?? null,
  );

  ipcMain.handle("emailMuster:runNow", async () => ({ ergebnis: (await emailMuster.current?.runNow()) ?? "nicht initialisiert" }));

  ipcMain.handle("emailMuster:vorschau", (_e, companyId: string) => emailMuster.current?.vorschau(String(companyId)) ?? null);

  ipcMain.handle("emailMuster:verlauf", (_e, opts: { nur?: string; companyId?: string; limit?: number } | undefined) =>
    emailMuster.current?.verlauf({ nur: opts?.nur as never, companyId: opts?.companyId ? String(opts.companyId) : undefined, limit: typeof opts?.limit === "number" ? opts.limit : undefined }) ?? [],
  );

  ipcMain.handle("telegram:snapshot", async (): Promise<TelegramSnapshot> => {
    return telegramSnapshot();
  });

  ipcMain.handle(
    "telegram:connect",
    async (
      _e,
      token: string,
    ): Promise<{ ok: boolean; botUsername?: string; error?: string }> => {
      try {
        const info = await telegramGetMe(String(token ?? "").trim());
        await telegramStore.saveToken(String(token).trim());
        telegramStore.setConfig({ botUsername: info.username });
        audit({
          actorType: "user",
          actorId: null,
          category: "watch",
          action: "telegram.connect",
          severity: "info",
          subjectType: "credential",
          subjectId: null,
          summary: `Telegram-Bot verbunden: @${info.username}`,
          metadata: { botUsername: info.username },
        });
        return { ok: true, botUsername: info.username };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "telegram:discoverChat",
    async (): Promise<{
      ok: boolean;
      chatId?: string;
      title?: string;
      error?: string;
    }> => {
      try {
        const token = await telegramStore.getToken();
        if (!token) return { ok: false, error: "Kein Bot-Token hinterlegt." };
        const updates = await telegramGetUpdates(token);
        const last = updates[updates.length - 1];
        if (!last) {
          return {
            ok: false,
            error:
              "Noch keine Nachricht empfangen. Öffne den Bot in Telegram und schicke ihm „/start“, dann erneut versuchen.",
          };
        }
        telegramStore.setConfig({ chatId: last.chat.chatId });
        return { ok: true, chatId: last.chat.chatId, title: last.chat.title };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "telegram:sendTest",
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        const token = await telegramStore.getToken();
        const cfg = telegramStore.getConfig();
        if (!token) return { ok: false, error: "Kein Bot-Token hinterlegt." };
        if (!cfg.chatId)
          return { ok: false, error: "Keine Chat-ID hinterlegt." };
        await telegramSendMessage(
          token,
          cfg.chatId,
          `✅ <b>AVA ist verbunden.</b>\n${telegramEscapeHtml(
            "Ab jetzt bekommst du hier deine Meldungen.",
          )}`,
        );
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "telegram:setConfig",
    async (_e, patch: Partial<TelegramConfig>): Promise<TelegramSnapshot> => {
      telegramStore.setConfig(patch ?? {});
      return telegramSnapshot();
    },
  );

  ipcMain.handle("telegram:disconnect", async (): Promise<TelegramSnapshot> => {
    await telegramStore.clear();
    audit({
      actorType: "user",
      actorId: null,
      category: "watch",
      action: "telegram.disconnect",
      severity: "warning",
      subjectType: "credential",
      subjectId: null,
      summary: "Telegram-Verbindung getrennt (Token entfernt)",
      metadata: {},
    });
    return telegramSnapshot();
  });

  // ---- Mail IPC (Phase 9.m — v0.1.257) ---------------------------------
  // Renderer → main: Konto konfigurieren, Test-Connect, Allowlist-CRUD,
  // Snapshot lesen, Aktionen auf einzelne Mails (mark-read, archive).
  // main → Renderer: `mail:snapshot` push bei jeder relevanten Änderung
  // (siehe broadcastMailSnapshot oben).
  ipcMain.handle("mail:snapshot", async (): Promise<MailSnapshot> => {
    if (!mailSupervisor.current) {
      return {
        account: null,
        connectionState: "disconnected",
        unreadCount: 0,
        messages: [],
        allowlist: [],
      };
    }
    return mailSupervisor.current.snapshot();
  });

  ipcMain.handle(
    "mail:configure",
    async (
      _e,
      args: { account: MailAccount; credentials: MailCredentialsPayload },
    ): Promise<{ ok: true } | { error: string }> => {
      if (!mailSupervisor.current) return { error: "Mail-Supervisor nicht bereit." };
      try {
        await mailSupervisor.current.configureAccount(args.account, args.credentials);
        return { ok: true };
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "mail:testConnection",
    async (
      _e,
      args: { account: MailAccount; credentials: MailCredentialsPayload },
    ): Promise<{ imap: boolean; smtp: boolean } | { error: string }> => {
      if (!mailSupervisor.current) return { error: "Mail-Supervisor nicht bereit." };
      try {
        const r = await mailSupervisor.current.testConnection(
          args.account,
          args.credentials,
        );
        return r;
      } catch (err) {
        return {
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "mail:deleteAccount",
    async (): Promise<{ ok: true }> => {
      if (!mailSupervisor.current) return { ok: true };
      await mailSupervisor.current.deleteAccount();
      return { ok: true };
    },
  );

  ipcMain.handle(
    "mail:allowlist:add",
    async (
      _e,
      args: { pattern: string; label: string },
    ): Promise<MailAllowlistEntry | { error: string }> => {
      if (!mailSupervisor.current) return { error: "Mail-Supervisor nicht bereit." };
      try {
        return await mailSupervisor.current.getStore().addAllowlistEntry({
          pattern: args.pattern,
          label: args.label,
          source: "user",
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle(
    "mail:allowlist:remove",
    async (_e, id: string): Promise<{ ok: true }> => {
      if (!mailSupervisor.current) return { ok: true };
      await mailSupervisor.current.getStore().removeAllowlistEntry(id);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "mail:markRead",
    async (
      _e,
      args: { messageId: string; read?: boolean },
    ): Promise<{ ok: true }> => {
      if (!mailSupervisor.current) return { ok: true };
      await mailSupervisor.current.getStore().markRead(args.messageId, args.read ?? true);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "mail:archive",
    async (_e, messageId: string): Promise<{ ok: true; moved: boolean }> => {
      if (!mailSupervisor.current) return { ok: true, moved: false };
      const { moved } = await mailSupervisor.current.archiveMessage(messageId);
      return { ok: true, moved };
    },
  );

  // v0.1.332 — Archiv-Liste für die Triage-UI ("Archiviert"-Tab).
  ipcMain.handle("mail:listArchived", async () => {
    if (!mailSupervisor.current) return [];
    return await mailSupervisor.current.getStore().listArchived(500);
  });

  ipcMain.handle(
    "mail:getMessage",
    async (_e, messageId: string) => {
      if (!mailSupervisor.current) return null;
      return mailSupervisor.current.getStore().getMessage(messageId);
    },
  );

  // ---- Scheduler IPC (Phase S — v0.1.267) -------------------------------
  ipcMain.handle("scheduler:list", async (): Promise<ScheduledJob[]> => {
    if (!scheduledJobsSupervisor.current) return [];
    return scheduledJobsSupervisor.current.store.list();
  });

  ipcMain.handle(
    "scheduler:cancel",
    async (_e, jobId: string): Promise<{ ok: true }> => {
      if (!scheduledJobsSupervisor.current) return { ok: true };
      await scheduledJobsSupervisor.current.cancel(jobId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "scheduler:pause",
    async (_e, jobId: string): Promise<{ ok: true }> => {
      if (!scheduledJobsSupervisor.current) return { ok: true };
      await scheduledJobsSupervisor.current.pause(jobId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    "scheduler:resume",
    async (_e, jobId: string): Promise<{ ok: true }> => {
      if (!scheduledJobsSupervisor.current) return { ok: true };
      await scheduledJobsSupervisor.current.resume(jobId);
      return { ok: true };
    },
  );

  // v0.1.274 — Direkter Create-Path aus Settings-UI. Form-Submit IST der
  // Confirm; keine ask_user_choice-Schleife wie beim Agent-Tool. Selbe
  // Validierung (Allowlist, Outbound-Schalter, Limits) wird hier
  // serverseitig nochmal erzwungen.
  ipcMain.handle(
    "scheduler:createMailLoop",
    async (
      _e,
      args: {
        label: string;
        to: string[];
        cc?: string[];
        subject: string;
        text: string;
        intervalMinutes: number;
        firstRunImmediately?: boolean;
        expiresInHours?: number;
        runsCap?: number;
      },
    ): Promise<
      | { ok: true; jobId: string; nextRunAt: string; expiresAt: string }
      | { ok: false; error: string }
    > => {
      if (!scheduledJobsSupervisor.current) {
        return { ok: false, error: "Scheduler ist noch nicht bereit." };
      }
      if (!mailSupervisor.current) {
        return {
          ok: false,
          error: "Mail-Supervisor nicht bereit — Konto in Datenquellen konfigurieren.",
        };
      }
      const account = await mailSupervisor.current.getStore().getAccount();
      if (!account) return { ok: false, error: "Kein Mail-Konto konfiguriert." };
      if (!account.outboundEnabled) {
        return {
          ok: false,
          error:
            "Mail-Outbound ist deaktiviert (Datenquellen → Mail-Konto). Bitte erst freischalten.",
        };
      }
      const allowlist = await mailSupervisor.current.getStore().listAllowlist();
      const recipients = [...args.to, ...(args.cc ?? [])];
      const untrusted = recipients.filter((r) => {
        const addr = r.toLowerCase().trim();
        if (!addr.includes("@")) return true;
        const [, domain] = addr.split("@");
        for (const entry of allowlist) {
          const p = entry.pattern.toLowerCase().trim();
          if (p === addr) return false;
          if (p.startsWith("*@")) {
            const pd = p.slice(2);
            if (pd.startsWith("*.")) {
              const root = pd.slice(2);
              if (domain === root || domain?.endsWith(`.${root}`)) return false;
            } else if (domain === pd) {
              return false;
            }
          }
        }
        return true;
      });
      if (untrusted.length > 0) {
        return {
          ok: false,
          error: `Empfänger nicht in Allowlist: ${untrusted.join(", ")}. Bitte erst in Mail-Konto-Sektion freischalten.`,
        };
      }
      const expiresInHours = args.expiresInHours ?? 24;
      const expiresAt = new Date(
        Date.now() + expiresInHours * 60 * 60 * 1000,
      ).toISOString();
      try {
        const job = await scheduledJobsSupervisor.current.createMailLoop({
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
          source: "user",
        });
        return {
          ok: true,
          jobId: job.id,
          nextRunAt: job.nextRunAt,
          expiresAt: job.expiresAt,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}
