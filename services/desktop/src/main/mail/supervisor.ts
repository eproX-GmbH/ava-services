// v0.1.257 — Mail-Supervisor.
//
// Orchestriert IMAP-Client + Store + Trust-Engine + Classifier. Eine
// Instanz pro App-Run. Boot-Sequenz:
//
//   1. Store.start() — PGlite öffnen
//   2. Account aus Store laden. Wenn keiner konfiguriert → idle, raus.
//   3. Credentials aus safeStorage laden. Wenn nicht da → idle, raus.
//   4. ImapClient mit Account + Password starten.
//   5. Bei jeder neu eingehenden Mail:
//        a. Store.recordMessage  (trustLevel: "unknown" initial)
//        b. TrustEngine.evaluate → updateTrustLevel
//        c. classifyMail (async, non-blocking für nächste Mail) → updateClassification
//
// IPC-Events an Renderer kommen über die mit-attached EventEmitter.
//
// Re-Config (User ändert Account in Settings): stop() → setAccount → start()

import { EventEmitter } from "node:events";
import { hasVision } from "@ava/ai-provider";
import type { LlmProviderManager } from "../agent/providers";
import type { ProviderConfigStore } from "../agent/providers/store";
import type {
  MailAccount,
  MailCredentialsPayload,
  MailMessage,
  MailSnapshot,
} from "../../shared/types";
import { MailStore } from "./store";
import { MailCredentialsManager } from "./credentials";
import { ImapClient, type ImapConnectionState } from "./imap-client";
import { SmtpClient, type SmtpSendInput, type SmtpSendResult } from "./smtp-client";
import { TrustEngine } from "./trust-engine";
import { classifyMail, attachClassifierProviders } from "./classifier";

interface SupervisorOptions {
  providers: LlmProviderManager;
  providerStore: ProviderConfigStore;
}

export interface MailSupervisorEvents {
  state: (state: ImapConnectionState) => void;
  snapshot: (snapshot: MailSnapshot) => void;
  /** Eine neue inbound Mail wurde klassifiziert und im Store finalisiert. */
  messageFinalized: (message: MailMessage) => void;
}

export declare interface MailSupervisor {
  on<K extends keyof MailSupervisorEvents>(
    event: K,
    listener: MailSupervisorEvents[K],
  ): this;
  emit<K extends keyof MailSupervisorEvents>(
    event: K,
    ...args: Parameters<MailSupervisorEvents[K]>
  ): boolean;
}

export class MailSupervisor extends EventEmitter {
  private store: MailStore;
  private creds: MailCredentialsManager;
  private imap: ImapClient | null = null;
  private smtp: SmtpClient | null = null;
  private trust: TrustEngine;
  private state: ImapConnectionState = "disconnected";
  private starting = false;

  constructor(private readonly opts: SupervisorOptions) {
    super();
    this.store = new MailStore();
    this.creds = new MailCredentialsManager();
    this.trust = new TrustEngine(this.store);
    attachClassifierProviders({
      providers: opts.providers,
      store: opts.providerStore,
    });

    // Snapshot-Broadcasts bei jeder relevanten Store-Änderung
    const broadcast = (): void => void this.broadcastSnapshot();
    this.store.on("messageReceived", broadcast);
    this.store.on("messageUpdated", broadcast);
    this.store.on("allowlistChanged", broadcast);
    this.store.on("accountChanged", broadcast);
  }

  /** Vom main/index.ts beim Boot aufgerufen. Lädt persistierten
   *  Account + Creds. Wenn beides da, startet IMAP. */
  async start(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    try {
      await this.store.start();
      const account = await this.store.getAccount();
      if (!account) {
        this.setState("disconnected");
        return;
      }
      const creds = await this.creds.load();
      if (!creds) {
        this.setState("disconnected");
        return;
      }
      await this.startImap(account, creds);
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.imap) {
      await this.imap.stop();
      this.imap = null;
    }
    if (this.smtp) {
      await this.smtp.close();
      this.smtp = null;
    }
    await this.store.stop();
    this.setState("disconnected");
  }

  /** Settings → User konfiguriert oder ändert das Konto. */
  async configureAccount(
    account: MailAccount,
    creds: MailCredentialsPayload,
  ): Promise<void> {
    // Alten Connect beenden
    if (this.imap) {
      await this.imap.stop();
      this.imap = null;
    }
    if (this.smtp) {
      await this.smtp.close();
      this.smtp = null;
    }
    await this.store.setAccount(account);
    await this.creds.save(creds);
    await this.startImap(account, creds);
  }

  /** Settings → Test-Connection-Button. Verifiziert IMAP + SMTP ohne
   *  bestehende Verbindung zu stören. Wirft mit menschenlesbarer
   *  Fehlermeldung wenn etwas nicht geht. */
  async testConnection(
    account: MailAccount,
    creds: MailCredentialsPayload,
  ): Promise<{ imap: boolean; smtp: boolean }> {
    const visionEnabled = this.currentVisionEnabled();
    const probeImap = new ImapClient({
      account,
      password: creds.imapPassword,
      fallbackPollIntervalMs: account.pollIntervalMinutes * 60_000,
      visionEnabled,
    });
    // Wir nutzen die start-Methode nicht (die zieht zu viel hoch).
    // Stattdessen ein minimaler Connect-Versuch.
    // Hack: Wir bauen einen direkten ImapFlow-Probe statt ImapClient.start().
    let imapOk = false;
    try {
      const { ImapFlow } = (await import("imapflow")) as {
        ImapFlow: new (opts: Record<string, unknown>) => {
          connect: () => Promise<void>;
          logout: () => Promise<void>;
        };
      };
      const probe = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.secure,
        auth: { user: account.imap.user, pass: creds.imapPassword },
        logger: false,
        emitLogs: false,
      });
      await probe.connect();
      await probe.logout();
      imapOk = true;
    } catch (err) {
      throw new Error(
        `IMAP-Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // Probe-Client wird in finally aufgegeben — nichts persistent.
      void probeImap;
    }

    let smtpOk = false;
    const probeSmtp = new SmtpClient({ account, password: creds.smtpPassword });
    try {
      await probeSmtp.verify();
      smtpOk = true;
    } catch (err) {
      throw new Error(
        `SMTP-Verbindung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      await probeSmtp.close();
    }
    return { imap: imapOk, smtp: smtpOk };
  }

  async deleteAccount(): Promise<void> {
    if (this.imap) {
      await this.imap.stop();
      this.imap = null;
    }
    if (this.smtp) {
      await this.smtp.close();
      this.smtp = null;
    }
    await this.store.deleteAccount();
    await this.creds.clear();
  }

  // ---- Public store-passthrough für IPC ----

  async snapshot(): Promise<MailSnapshot> {
    const snap = await this.store.snapshot();
    snap.connectionState = this.state;
    return snap;
  }

  getStore(): MailStore {
    return this.store;
  }

  getSmtp(): SmtpClient | null {
    return this.smtp;
  }

  /** v0.1.260 — Wrapper für SMTP-send, der direkt anschließend per
   *  IMAP APPEND die Sent-Mail in den Sent-Folder spiegelt. Caller in
   *  den Mail-Tools nutzen ausschließlich diese Methode statt
   *  smtp.send direkt, damit die Sent-Folder-Spiegelung garantiert
   *  ist. Sync-Fehler sind nicht-fatal — Mail ist gesendet. */
  async sendAndSync(input: SmtpSendInput): Promise<SmtpSendResult> {
    if (!this.smtp) throw new Error("SMTP nicht initialisiert.");
    const result = await this.smtp.send(input);
    if (this.imap) {
      // Best-effort: RFC822 bauen + an Sent appenden. Fehler werden
      // im ImapClient als Event emittiert, brechen den Send nicht.
      try {
        const raw = await this.smtp.buildRaw(input);
        await this.imap.appendToSent(raw);
      } catch (err) {
        console.warn(
          "[mail/supervisor] Sent-Sync fehlgeschlagen:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return result;
  }

  /** v0.1.260 — Archiviert eine Mail: zuerst IMAP-Move in den
   *  Archive-Folder versuchen, dann (egal ob Move klappte) das
   *  archived_at-Flag im Store setzen. So bleibt die Triage-UI auch
   *  konsistent, wenn der Server keinen Archive-Folder hat. */
  async archiveMessage(messageId: string): Promise<{ moved: boolean }> {
    const msg = await this.store.getMessage(messageId);
    let moved = false;
    if (msg && this.imap && msg.imapUid != null && msg.folder === "INBOX") {
      moved = await this.imap.moveToArchive(msg.imapUid);
    }
    await this.store.archive(messageId);
    return { moved };
  }

  // ---- intern ----

  private async startImap(
    account: MailAccount,
    creds: MailCredentialsPayload,
  ): Promise<void> {
    const visionEnabled = this.currentVisionEnabled();
    const imap = new ImapClient({
      account,
      password: creds.imapPassword,
      fallbackPollIntervalMs: account.pollIntervalMinutes * 60_000,
      visionEnabled,
    });
    imap.on("state", (s) => this.setState(s));
    imap.on("error", (err) => {
      void this.store.updateAccountSyncState({
        lastErrorAt: new Date().toISOString(),
        lastErrorMessage: err.message,
      });
    });
    imap.on("message", (raw) => void this.handleIncoming(raw));
    this.imap = imap;
    await imap.start();

    this.smtp = new SmtpClient({ account, password: creds.smtpPassword });
  }

  private async handleIncoming(raw: MailMessage): Promise<void> {
    // 1. Speichern (mit trustLevel "unknown")
    const stored = await this.store.recordMessage(raw);

    // 2. Trust-Verdict
    try {
      const verdict = await this.trust.evaluate(stored);
      await this.store.updateTrustLevel(stored.id, verdict.level);
    } catch (err) {
      console.warn(
        "[mail/supervisor] Trust-Eval fehlgeschlagen:",
        err instanceof Error ? err.message : String(err),
      );
    }

    // 3. Klassifikation (async, non-blocking — Pipeline geht weiter)
    void (async () => {
      try {
        const classification = await classifyMail(stored);
        if (classification) {
          // Phishing-Override: hohe Injection-Risk degradiert auf "unknown"
          // auch bei Allowlist-Match.
          if (classification.injectionRisk >= 0.7) {
            await this.store.updateTrustLevel(stored.id, "unknown");
          }
          const final = await this.store.updateClassification(
            stored.id,
            classification,
          );
          if (final) this.emit("messageFinalized", final);
        }
      } catch (err) {
        console.warn(
          "[mail/supervisor] Classify fehlgeschlagen:",
          err instanceof Error ? err.message : String(err),
        );
      }
    })();

    await this.store.updateAccountSyncState({
      lastSyncAt: new Date().toISOString(),
      lastErrorAt: null,
      lastErrorMessage: null,
    });
  }

  private currentVisionEnabled(): boolean {
    const status = this.opts.providers.getStatus();
    if (!status.ready || !status.model) return false;
    return hasVision(status.kind, status.model);
  }

  private setState(state: ImapConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
    void this.broadcastSnapshot();
  }

  private async broadcastSnapshot(): Promise<void> {
    try {
      const snap = await this.snapshot();
      this.emit("snapshot", snap);
    } catch {
      /* store nicht ready */
    }
  }
}
