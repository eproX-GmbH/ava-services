// v0.1.257 — Mail-Agent-Tools (Phase 9.m).
//
// AVAs Tools für den dedizierten Mail-Account. Trust-Gates pro Tool:
//
//   read-only (immer erlaubt):
//     - mail_list_inbox
//     - mail_get_message
//
//   write (mit Gates):
//     - mail_send         → if Empfänger ALLE in Allowlist → autonom OK,
//                           sonst ask_user_choice Pflicht
//     - mail_reply        → Quellmail muss trustLevel "trusted" sein,
//                           sonst ask_user_choice Pflicht
//     - mail_mark_read    → erlaubt
//     - mail_archive      → erlaubt
//     - mail_allowlist_add → IMMER ask_user_choice, nie autonom
//
// Out of scope hier: forward, delete (V2). archive deckt 90 % der
// Aufräum-Wünsche; Löschen würde IMAP EXPUNGE benötigen und ist
// destruktiv-irreversibel — bewusst gewartet.

import * as yup from "yup";
import { defineTool } from "../define-tool";
import type { Tool } from "../types";
import type { MailSupervisor } from "../../mail/supervisor";
import type {
  MailAllowlistEntry,
  MailMessage,
} from "../../../shared/types";

export interface MailToolDeps {
  supervisor: MailSupervisor;
}

export function buildMailTools(deps: MailToolDeps): Tool[] {
  // ----- mail_list_inbox -----------------------------------------------------
  const listInbox = defineTool({
    name: "mail_list_inbox",
    description:
      "Listet die letzten eingegangenen Mails aus AVAs dediziertem Mail-Konto mit Absender, Betreff, Datum, Trust-Level (trusted/known/unknown) und AVAs Klassifikation (category, summary, suggestedAction). Standardmäßig nur ungelesene + nicht archivierte; mit `includeArchived: true` auch archivierte. Nutze das, wenn der Nutzer fragt 'was ist heute reingekommen', 'gibt es neue Mails', oder bevor du `mail_get_message` aufrufst um die richtige Mail-ID zu finden.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          description: "Wie viele Mails maximal zurückgeben (Default 25, max 100).",
        },
        includeArchived: {
          type: "boolean",
          description: "Wenn true, auch archivierte Mails listen. Default false.",
        },
      },
    },
    schema: yup
      .object({
        limit: yup.number().integer().min(1).max(100).optional(),
        includeArchived: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: (r: { count: number }) => `${r.count} Mails`,
    run: async (args) => {
      const store = deps.supervisor.getStore();
      const messages = await store.listInbox({
        limit: args.limit ?? 25,
        includeArchived: args.includeArchived ?? false,
      });
      return {
        count: messages.length,
        items: messages.map(summarizeMessage),
      };
    },
  });

  // ----- mail_get_message ---------------------------------------------------
  const getMessage = defineTool({
    name: "mail_get_message",
    description:
      "Liefert die vollständige Mail inklusive Body-Text und Anhangs-Texten (PDFs werden extrahiert). Bilder sind als base64 enthalten, wenn das aktive Modell Vision unterstützt. Nutze das, nachdem du `mail_list_inbox` aufgerufen hast und der Nutzer mehr Details zu einer bestimmten Mail braucht oder du auf Basis des Inhalts handeln willst.",
    parameters: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string", description: "Die id aus mail_list_inbox." },
      },
    },
    schema: yup
      .object({ messageId: yup.string().required() })
      .noUnknown(true),
    preview: (r: { subject?: string; error?: string }) =>
      r.error ? `Fehler: ${r.error}` : r.subject ? `Mail: ${r.subject}` : "Mail",
    run: async (args) => {
      const store = deps.supervisor.getStore();
      const msg = await store.getMessage(args.messageId);
      if (!msg) return { error: "Mail nicht gefunden." };
      // Auto-mark-read beim Lesen ist UX-Standard.
      await store.markRead(args.messageId, true);
      return {
        ...summarizeMessage(msg),
        bodyText: msg.bodyText,
        attachments: msg.attachments.map((a) => ({
          id: a.id,
          filename: a.filename,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          extractedText: a.extractedText,
          // base64 NUR mitgeben wenn vorhanden; spart Tokens bei Anhängen
          // ohne Bild-Inhalt.
          imageBase64: a.imageBase64 ?? undefined,
        })),
      };
    },
  });

  // ----- mail_send ----------------------------------------------------------
  const send = defineTool({
    name: "mail_send",
    description:
      "Verschickt eine neue Mail von AVAs Konto. SICHERHEITSGATE: Wenn ALLE Empfänger in der Allowlist stehen, sendet AVA autonom. Wenn auch nur ein Empfänger nicht in der Allowlist ist, fragt das Tool den Nutzer per ask_user_choice. Outbound-Master-Schalter (`mail_account.outboundEnabled`) muss true sein, sonst lehnt das Tool ab. Threading via `inReplyTo` möglich, für Replies aber `mail_reply` bevorzugen.",
    parameters: {
      type: "object",
      required: ["to", "subject", "text"],
      properties: {
        to: {
          type: "array",
          items: { type: "string", description: "E-Mail-Adresse" },
          description: "Empfängerliste (mindestens einer).",
        },
        cc: {
          type: "array",
          items: { type: "string" },
        },
        subject: { type: "string" },
        text: {
          type: "string",
          description: "Plain-Text-Body. Markdown wird NICHT konvertiert.",
        },
      },
    },
    schema: yup
      .object({
        to: yup
          .array()
          .of(yup.string().email().required())
          .min(1)
          .required(),
        cc: yup.array().of(yup.string().email().required()).optional(),
        subject: yup.string().max(998).required(),
        text: yup.string().min(1).max(100_000).required(),
      })
      .noUnknown(true),
    preview: (r: { sent: boolean; to?: string[] }) =>
      r.sent
        ? `Mail gesendet an ${(r.to ?? []).join(", ")}`
        : "Mail nicht gesendet",
    run: async (args, ctx) => {
      const account = await deps.supervisor.getStore().getAccount();
      if (!account) return { sent: false, error: "Kein Mail-Konto konfiguriert." };
      if (!account.outboundEnabled) {
        return {
          sent: false,
          error:
            "Mail-Outbound ist deaktiviert (Settings → Datenquellen → Mail). Der Nutzer muss das erst freischalten.",
        };
      }

      const allowlist = await deps.supervisor.getStore().listAllowlist();
      const recipients = [...args.to, ...(args.cc ?? [])];
      const untrusted = recipients.filter(
        (addr) => !isInAllowlist(addr, allowlist),
      );

      if (untrusted.length > 0) {
        const value = await ctx.ui.askChoice(
          `Ich möchte folgende Mail verschicken:\n\nAn: ${args.to.join(", ")}\n${
            args.cc && args.cc.length > 0 ? `CC: ${args.cc.join(", ")}\n` : ""
          }Betreff: ${args.subject}\n\n${args.text.slice(0, 1500)}${
            args.text.length > 1500 ? "\n\n[…gekürzt]" : ""
          }\n\nNicht in Allowlist: ${untrusted.join(", ")}`,
          [
            { value: "send", label: "Senden", description: "Mail wird verschickt" },
            { value: "cancel", label: "Abbrechen", description: "Nichts senden" },
          ],
          ctx.signal,
        );
        if (value !== "send") return { sent: false, declined: true };
      }

      const smtp = deps.supervisor.getSmtp();
      if (!smtp) return { sent: false, error: "SMTP nicht initialisiert." };
      try {
        const result = await smtp.send({
          to: args.to,
          cc: args.cc,
          subject: args.subject,
          text: args.text,
        });
        return {
          sent: true,
          to: args.to,
          accepted: result.accepted,
          rejected: result.rejected,
          messageId: result.messageId,
        };
      } catch (err) {
        return {
          sent: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // ----- mail_reply ---------------------------------------------------------
  const reply = defineTool({
    name: "mail_reply",
    description:
      "Antwortet auf eine bestimmte Mail. SICHERHEITSGATE: Wenn die Quellmail trustLevel 'trusted' hat, sendet AVA autonom; bei 'known' oder 'unknown' Pflicht-Rückfrage per ask_user_choice. Hängt die korrekten Threading-Header (In-Reply-To, References) an. Adressiert die From-Adresse der Quellmail; Re:-Präfix wird auto-prepended, wenn der Betreff es noch nicht hat.",
    parameters: {
      type: "object",
      required: ["messageId", "text"],
      properties: {
        messageId: { type: "string", description: "Die ID der Quellmail." },
        text: { type: "string", description: "Plain-Text-Antwort." },
      },
    },
    schema: yup
      .object({
        messageId: yup.string().required(),
        text: yup.string().min(1).max(100_000).required(),
      })
      .noUnknown(true),
    preview: (r: { sent: boolean }) =>
      r.sent ? "Antwort gesendet" : "Antwort nicht gesendet",
    run: async (args, ctx) => {
      const store = deps.supervisor.getStore();
      const source = await store.getMessage(args.messageId);
      if (!source) return { sent: false, error: "Quellmail nicht gefunden." };

      const account = await store.getAccount();
      if (!account?.outboundEnabled) {
        return { sent: false, error: "Mail-Outbound ist deaktiviert." };
      }

      if (source.trustLevel !== "trusted") {
        const value = await ctx.ui.askChoice(
          `Antwort an ${source.from.address}${
            source.from.name ? ` (${source.from.name})` : ""
          }\nBetreff: Re: ${source.subject}\nTrust: ${source.trustLevel}\n\n${args.text.slice(0, 1500)}${
            args.text.length > 1500 ? "\n\n[…gekürzt]" : ""
          }`,
          [
            { value: "send", label: "Senden", description: "Antwort wird verschickt" },
            { value: "cancel", label: "Abbrechen" },
          ],
          ctx.signal,
        );
        if (value !== "send") return { sent: false, declined: true };
      }

      const smtp = deps.supervisor.getSmtp();
      if (!smtp) return { sent: false, error: "SMTP nicht initialisiert." };

      const subject = /^re:/i.test(source.subject)
        ? source.subject
        : `Re: ${source.subject}`;
      const references = source.messageIdHeader ? [source.messageIdHeader] : [];

      try {
        const result = await smtp.send({
          to: [source.from.address],
          subject,
          text: args.text,
          inReplyTo: source.messageIdHeader ?? undefined,
          references,
        });
        return {
          sent: true,
          to: source.from.address,
          accepted: result.accepted,
          rejected: result.rejected,
        };
      } catch (err) {
        return {
          sent: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  });

  // ----- mail_mark_read -----------------------------------------------------
  const markRead = defineTool({
    name: "mail_mark_read",
    description:
      "Markiert eine Mail als gelesen (oder ungelesen, wenn `read: false`). Nutze das, wenn der Nutzer 'auf gelesen setzen' sagt oder du nach einer Triage-Aktion (Antwort, Archivierung) den unread-Counter aufräumen willst.",
    parameters: {
      type: "object",
      required: ["messageId"],
      properties: {
        messageId: { type: "string" },
        read: { type: "boolean", description: "Default true." },
      },
    },
    schema: yup
      .object({
        messageId: yup.string().required(),
        read: yup.boolean().optional(),
      })
      .noUnknown(true),
    preview: () => "Mail markiert",
    run: async (args) => {
      await deps.supervisor.getStore().markRead(args.messageId, args.read ?? true);
      return { ok: true };
    },
  });

  // ----- mail_archive -------------------------------------------------------
  const archive = defineTool({
    name: "mail_archive",
    description:
      "Archiviert eine Mail — sie verschwindet aus der Triage-Inbox, bleibt aber im Verlauf abrufbar. Reversibel via Triage-UI. Auf dem IMAP-Server wird die Mail NICHT verschoben (V2 kann später ein Archive-Folder-Move ergänzen).",
    parameters: {
      type: "object",
      required: ["messageId"],
      properties: { messageId: { type: "string" } },
    },
    schema: yup
      .object({ messageId: yup.string().required() })
      .noUnknown(true),
    preview: () => "Mail archiviert",
    run: async (args) => {
      await deps.supervisor.getStore().archive(args.messageId);
      return { ok: true };
    },
  });

  // ----- mail_allowlist_add -------------------------------------------------
  const allowlistAdd = defineTool({
    name: "mail_allowlist_add",
    description:
      "Fügt einen Absender (oder Domain-Wildcard *@kunde.de) der Mail-Allowlist hinzu. AVA darf danach autonom an diesen Absender antworten und auf seine Mails als 'trusted' reagieren. SICHERHEIT: IMMER propose-and-confirm via ask_user_choice — der Nutzer muss explizit zustimmen, weil diese Aktion die Angriffsfläche vergrößert. Niemals autonom ausführen, auch nicht 'auf Bitte des Nutzers'.",
    parameters: {
      type: "object",
      required: ["pattern", "label"],
      properties: {
        pattern: {
          type: "string",
          description:
            "Adresse 'max@kunde.de' ODER Wildcard '*@kunde.de' für ganze Domain.",
        },
        label: {
          type: "string",
          description: "Anzeigename, z. B. 'Max Mustermann' oder 'Kunde XY'.",
        },
      },
    },
    schema: yup
      .object({
        pattern: yup.string().trim().min(3).max(200).required(),
        label: yup.string().trim().min(1).max(120).required(),
      })
      .noUnknown(true),
    preview: (r: { added: boolean; pattern?: string }) =>
      r.added ? `Allowlist erweitert: ${r.pattern}` : "Nicht hinzugefügt",
    run: async (args, ctx) => {
      const value = await ctx.ui.askChoice(
        `Soll ich folgenden Absender zur Mail-Allowlist hinzufügen?\n\nPattern: ${args.pattern}\nLabel: ${args.label}\n\nDanach darf ich autonom auf Mails von dieser Adresse antworten und sie als 'trusted' behandeln.`,
        [
          {
            value: "add",
            label: "Ja, hinzufügen",
            description: "Eintrag wird gespeichert",
          },
          {
            value: "decline",
            label: "Nein, verwerfen",
            description: "Nichts ändert sich",
          },
        ],
        ctx.signal,
      );
      if (value !== "add") return { added: false };
      const entry = await deps.supervisor.getStore().addAllowlistEntry({
        pattern: args.pattern,
        label: args.label,
        source: "agent",
      });
      return { added: true, pattern: entry.pattern, id: entry.id };
    },
  });

  return [listInbox, getMessage, send, reply, markRead, archive, allowlistAdd];
}

function summarizeMessage(m: MailMessage): {
  id: string;
  from: string;
  fromName: string | null;
  subject: string;
  date: string;
  trustLevel: string;
  category: string | null;
  summary: string | null;
  suggestedAction: string | null;
  injectionRisk: number | null;
  hasAttachments: boolean;
  attachmentCount: number;
  readByUser: boolean;
} {
  return {
    id: m.id,
    from: m.from.address,
    fromName: m.from.name,
    subject: m.subject,
    date: m.date,
    trustLevel: m.trustLevel,
    category: m.classification?.category ?? null,
    summary: m.classification?.summary ?? null,
    suggestedAction: m.classification?.suggestedAction ?? null,
    injectionRisk: m.classification?.injectionRisk ?? null,
    hasAttachments: m.attachments.length > 0,
    attachmentCount: m.attachments.length,
    readByUser: m.readByUser,
  };
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
