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
  /** Lazy-Getter weil der Supervisor erst nach buildReadOnlyRegistry()
   *  in der Boot-Sequenz instanziiert wird. Tools werden trotzdem schon
   *  zur Registry-Zeit registriert, damit der Agent sie kennt — beim
   *  ersten run() prüft jedes Tool die Verfügbarkeit. */
  getSupervisor: () => MailSupervisor | null;
}

function requireSupervisor(
  deps: MailToolDeps,
): MailSupervisor | { error: string } {
  const sup = deps.getSupervisor();
  if (!sup) {
    return {
      error:
        "Mail-Supervisor noch nicht initialisiert. Konto in Einstellungen → Datenquellen → Mail-Konto konfigurieren.",
    };
  }
  return sup;
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
    preview: (r: { count: number; error?: string }) =>
      r.error ? `Fehler: ${r.error}` : `${r.count} Mails`,
    run: async (args) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { count: 0, error: supOrErr.error };
      const sup = supOrErr;
      const store = sup.getStore();
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
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { error: supOrErr.error };
      const sup = supOrErr;
      const store = sup.getStore();
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
    preview: (r: { sent: boolean; to?: string[]; error?: string }) =>
      r.sent
        ? `Mail gesendet an ${(r.to ?? []).join(", ")}`
        : r.error
          ? `Fehler: ${r.error}`
          : "Mail nicht gesendet",
    run: async (args, ctx) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { sent: false, error: supOrErr.error };
      const sup = supOrErr;
      const account = await sup.getStore().getAccount();
      if (!account) return { sent: false, error: "Kein Mail-Konto konfiguriert." };
      if (!account.outboundEnabled) {
        return {
          sent: false,
          error:
            "Mail-Outbound ist deaktiviert (Settings → Datenquellen → Mail). Der Nutzer muss das erst freischalten.",
        };
      }

      const allowlist = await sup.getStore().listAllowlist();
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

      try {
        // v0.1.260 — sendAndSync spiegelt die Mail auch in den Sent-Folder
        const result = await sup.sendAndSync({
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
    preview: (r: { sent: boolean; error?: string }) =>
      r.sent ? "Antwort gesendet" : r.error ? `Fehler: ${r.error}` : "Antwort nicht gesendet",
    run: async (args, ctx) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { sent: false, error: supOrErr.error };
      const sup = supOrErr;
      const store = sup.getStore();
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

      const subject = /^re:/i.test(source.subject)
        ? source.subject
        : `Re: ${source.subject}`;
      const references = source.messageIdHeader ? [source.messageIdHeader] : [];

      try {
        // v0.1.260 — sendAndSync auch hier für Sent-Folder-Spiegelung
        const result = await sup.sendAndSync({
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
  // ----- mail_forward ------------------------------------------------------
  const forward = defineTool({
    name: "mail_forward",
    description:
      "Leitet eine Mail an einen anderen Empfänger weiter. Original-Mail wird als Quote im Body angehängt (englisch: 'Forwarded message'-Block). SICHERHEITSGATE: Wenn ALLE Empfänger in Allowlist sind, sendet AVA autonom; sonst Pflicht-Rückfrage via ask_user_choice. Beachtet outboundEnabled-Master-Schalter. Threading via References-Header.",
    parameters: {
      type: "object",
      required: ["messageId", "to"],
      properties: {
        messageId: { type: "string", description: "ID der weiterzuleitenden Mail." },
        to: {
          type: "array",
          items: { type: "string", description: "Empfänger-E-Mail." },
          description: "Empfängerliste (mindestens einer).",
        },
        text: {
          type: "string",
          description:
            "Optionaler Begleittext, wird vor dem Forward-Quote eingefügt.",
        },
      },
    },
    schema: yup
      .object({
        messageId: yup.string().required(),
        to: yup
          .array()
          .of(yup.string().email().required())
          .min(1)
          .required(),
        text: yup.string().max(50_000).optional(),
      })
      .noUnknown(true),
    preview: (r: { sent: boolean; to?: string[]; error?: string }) =>
      r.sent
        ? `Mail weitergeleitet an ${(r.to ?? []).join(", ")}`
        : r.error
          ? `Fehler: ${r.error}`
          : "Weiterleitung nicht versendet",
    run: async (args, ctx) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { sent: false, error: supOrErr.error };
      const sup = supOrErr;
      const store = sup.getStore();
      const source = await store.getMessage(args.messageId);
      if (!source) return { sent: false, error: "Quellmail nicht gefunden." };

      const account = await store.getAccount();
      if (!account?.outboundEnabled) {
        return {
          sent: false,
          error: "Mail-Outbound ist deaktiviert (Settings → Datenquellen → Mail).",
        };
      }

      const allowlist = await store.listAllowlist();
      const untrusted = args.to.filter((addr) => !isInAllowlist(addr, allowlist));
      if (untrusted.length > 0) {
        const value = await ctx.ui.askChoice(
          `Soll ich folgende Mail weiterleiten?\n\nAn: ${args.to.join(", ")}\nNicht in Allowlist: ${untrusted.join(", ")}\n\nOriginal: ${source.from.address} · ${source.subject}\n${(args.text ?? "").slice(0, 800)}`,
          [
            { value: "send", label: "Weiterleiten", description: "Mail wird verschickt" },
            { value: "cancel", label: "Abbrechen" },
          ],
          ctx.signal,
        );
        if (value !== "send") return { sent: false, declined: true };
      }

      const subject = /^fwd:|^wg:/i.test(source.subject)
        ? source.subject
        : `Fwd: ${source.subject}`;

      // Forward-Body: optionaler Begleittext + Quote-Block
      const quote = buildForwardQuote(source);
      const body = args.text ? `${args.text}\n\n${quote}` : quote;
      const references = source.messageIdHeader ? [source.messageIdHeader] : [];

      try {
        const result = await sup.sendAndSync({
          to: args.to,
          subject,
          text: body,
          references,
        });
        return {
          sent: true,
          to: args.to,
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
    preview: (r: { ok: boolean; error?: string }) =>
      r.ok ? "Mail markiert" : `Fehler: ${r.error ?? "unbekannt"}`,
    run: async (args) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { ok: false, error: supOrErr.error };
      const sup = supOrErr;
      await sup.getStore().markRead(args.messageId, args.read ?? true);
      return { ok: true };
    },
  });

  // ----- mail_archive -------------------------------------------------------
  const archive = defineTool({
    name: "mail_archive",
    description:
      "Archiviert eine Mail. Verschiebt die Mail physisch in den Archive-Folder des IMAP-Servers (RFC-6154 \\Archive oder Heuristik: Archive/Archiv/All Mail) UND setzt das interne archived_at-Flag. Wenn der Server keinen Archive-Folder hat, bleibt es bei der Flag-only-Archivierung (Mail verschwindet trotzdem aus der Triage-Inbox).",
    parameters: {
      type: "object",
      required: ["messageId"],
      properties: { messageId: { type: "string" } },
    },
    schema: yup
      .object({ messageId: yup.string().required() })
      .noUnknown(true),
    preview: (r: { ok: boolean; moved?: boolean; error?: string }) =>
      !r.ok
        ? `Fehler: ${r.error ?? "unbekannt"}`
        : r.moved
          ? "Mail in Archive-Folder verschoben"
          : "Mail archiviert (intern)",
    run: async (args) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { ok: false, error: supOrErr.error };
      const sup = supOrErr;
      const { moved } = await sup.archiveMessage(args.messageId);
      return { ok: true, moved };
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
    preview: (r: { added: boolean; pattern?: string; error?: string }) =>
      r.added
        ? `Allowlist erweitert: ${r.pattern}`
        : r.error
          ? `Fehler: ${r.error}`
          : "Nicht hinzugefügt",
    run: async (args, ctx) => {
      const supOrErr = requireSupervisor(deps);
      if ("error" in supOrErr) return { added: false, error: supOrErr.error };
      const sup = supOrErr;
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
      const entry = await sup.getStore().addAllowlistEntry({
        pattern: args.pattern,
        label: args.label,
        source: "agent",
      });
      return { added: true, pattern: entry.pattern, id: entry.id };
    },
  });

  return [
    listInbox,
    getMessage,
    send,
    reply,
    forward,
    markRead,
    archive,
    allowlistAdd,
  ];
}

/** v0.1.260 — baut den Forward-Quote-Block. Bewusst englischsprachiges
 *  Header-Format ("Forwarded message"), weil Mail-Clients (Outlook,
 *  Apple Mail, Thunderbird) das Pattern erkennen und schöner darstellen. */
function buildForwardQuote(source: import("../../../shared/types").MailMessage): string {
  const fromLine = source.from.name
    ? `${source.from.name} <${source.from.address}>`
    : source.from.address;
  const toLine = source.to.map((r) => r.address).join(", ");
  const header = [
    "---------- Forwarded message ----------",
    `From: ${fromLine}`,
    `Date: ${source.date}`,
    `Subject: ${source.subject}`,
    `To: ${toLine}`,
    "",
  ].join("\n");
  return `${header}${source.bodyText}`;
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
