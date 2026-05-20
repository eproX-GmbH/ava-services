// v0.1.257 — SMTP-Client.
//
// Wrapper um `nodemailer`. Eine Transport-Instanz pro Account, wird
// bei jedem Send wiederverwendet (nodemailer pooling). Erzeugt
// Message-ID + In-Reply-To für Threading bei Reply.

import type { Transporter, SendMailOptions } from "nodemailer";
import type { MailAccount } from "../../shared/types";

interface SmtpClientOptions {
  account: MailAccount;
  password: string;
}

export interface SmtpSendInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  /** Für Threading: In-Reply-To-Header und References. */
  inReplyTo?: string;
  references?: string[];
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

export interface SmtpSendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
}

export class SmtpClient {
  private transporter: Transporter | null = null;

  constructor(private readonly opts: SmtpClientOptions) {}

  private async getTransporter(): Promise<Transporter> {
    if (this.transporter) return this.transporter;
    const nm = (await import("nodemailer")) as unknown as {
      createTransport: (opts: Record<string, unknown>) => Transporter;
    };
    this.transporter = nm.createTransport({
      host: this.opts.account.smtp.host,
      port: this.opts.account.smtp.port,
      secure: this.opts.account.smtp.secure,
      auth: {
        user: this.opts.account.smtp.user,
        pass: this.opts.password,
      },
      pool: true,
      maxConnections: 2,
    });
    return this.transporter;
  }

  /** Verbindung testen (Settings → Test-Connection-Button). */
  async verify(): Promise<void> {
    const t = await this.getTransporter();
    await t.verify();
  }

  async send(input: SmtpSendInput): Promise<SmtpSendResult> {
    const t = await this.getTransporter();
    const from = this.opts.account.displayName
      ? `"${this.opts.account.displayName}" <${this.opts.account.address}>`
      : this.opts.account.address;
    const mail: SendMailOptions = {
      from,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.text,
      html: input.html,
      inReplyTo: input.inReplyTo,
      references: input.references,
      attachments: input.attachments,
    };
    const info = await t.sendMail(mail);
    return {
      messageId: info.messageId ?? "",
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }

  async close(): Promise<void> {
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
  }
}
