// v0.1.257 — IMAP-Client mit IDLE + Fallback-Poll.
//
// Wrapper um `imapflow`. Hält genau EINE Verbindung zum IMAP-Server,
// versucht via CAPABILITY-Negotiation IDLE (RFC 2177) — wenn unterstützt,
// werden neue Mails near-instant gepusht. Wenn der Server IDLE nicht
// kann (selten heutzutage, aber z. B. ältere Exchange-Setups), läuft
// ein Polling-Fallback alle `pollIntervalMinutes` Minuten.
//
// Reconnect-Strategie: bei jedem Connection-Fail wartet der Client mit
// exponentiellem Backoff (5s → 10s → 30s → 60s → 120s, capped).
//
// Out of scope hier: Klassifikation, Trust-Eval, Attachment-Extraction
// — das macht der Supervisor. Dieser Client gibt RAW MailMessages mit
// trustLevel: "unknown" + classification: null an seinen Listener weiter.

import { EventEmitter } from "node:events";
import type { ImapFlow as ImapFlowType, FetchMessageObject } from "imapflow";
import type { ParsedMail } from "mailparser";
import type {
  MailAccount,
  MailMessage,
  MailAttachment,
} from "../../shared/types";
import { extractAttachment } from "./attachments";

export type ImapConnectionState =
  | "connecting"
  | "connected"
  | "idling"
  | "polling"
  | "disconnected"
  | "error";

interface ImapClientOptions {
  account: MailAccount;
  password: string;
  /** Wenn der Server IDLE nicht kann, polling-Intervall in Millisekunden. */
  fallbackPollIntervalMs: number;
  /** Wie viele Tage rückwärts beim ersten Start abrufen. Default 14. */
  initialFetchDays?: number;
  /** Vision-Capability des aktuellen Modells. Steuert ob Bilder als base64
   *  eingelesen werden. */
  visionEnabled: boolean;
}

export interface ImapClientEvents {
  state: (state: ImapConnectionState) => void;
  message: (message: MailMessage) => void;
  error: (error: Error) => void;
}

export declare interface ImapClient {
  on<K extends keyof ImapClientEvents>(
    event: K,
    listener: ImapClientEvents[K],
  ): this;
  emit<K extends keyof ImapClientEvents>(
    event: K,
    ...args: Parameters<ImapClientEvents[K]>
  ): boolean;
}

const RECONNECT_BACKOFF_MS = [5_000, 10_000, 30_000, 60_000, 120_000];

export class ImapClient extends EventEmitter {
  private client: ImapFlowType | null = null;
  private state: ImapConnectionState = "disconnected";
  private stopping = false;
  private reconnectAttempt = 0;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private idleSupported = false;
  /** v0.1.260 — gecachte Folder-Pfade für Sent + Archive (per
   *  RFC-6154-Match oder Namens-Heuristik). null = kein passender
   *  Folder verfügbar (z. B. minimalistisch konfigurierter Server). */
  private folderCache = new Map<"sent" | "archive", string | null>();

  constructor(private readonly opts: ImapClientOptions) {
    super();
  }

  getState(): ImapConnectionState {
    return this.state;
  }

  /** v0.1.260 — gibt den (gecachten) Mailbox-Pfad für eine semantische
   *  Rolle zurück. \\Sent / \\Archive sind die RFC-6154 special-use-Flags;
   *  bekanntermaßen pflegen nicht alle Server die, also fallback auf
   *  übliche Folder-Namen pro Sprache. Liefert null wenn nichts passt. */
  async findFolder(role: "sent" | "archive"): Promise<string | null> {
    if (!this.client) return null;
    const cached = this.folderCache.get(role);
    if (cached !== undefined) return cached;
    let resolved: string | null = null;
    try {
      const list = (await this.client.list()) as Array<{
        path: string;
        specialUse?: string;
        flags?: Set<string> | string[];
      }>;
      const specialUseTag = role === "sent" ? "\\Sent" : "\\Archive";
      // 1. RFC 6154 special-use-Match
      for (const m of list) {
        const su = m.specialUse;
        const flags = Array.isArray(m.flags)
          ? m.flags
          : m.flags
            ? Array.from(m.flags)
            : [];
        if (su === specialUseTag || flags.includes(specialUseTag)) {
          resolved = m.path;
          break;
        }
      }
      // 2. Name-Heuristik (de + en)
      if (!resolved) {
        const candidates =
          role === "sent"
            ? [
                "Sent",
                "Gesendet",
                "Gesendete Elemente",
                "Sent Items",
                "Sent Messages",
                "INBOX.Sent",
                "INBOX/Sent",
              ]
            : ["Archive", "Archiv", "All Mail", "Alle Nachrichten", "INBOX.Archive"];
        const byPath = new Map(list.map((m) => [m.path.toLowerCase(), m.path]));
        for (const c of candidates) {
          const hit = byPath.get(c.toLowerCase());
          if (hit) {
            resolved = hit;
            break;
          }
        }
      }
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
    this.folderCache.set(role, resolved);
    return resolved;
  }

  /** v0.1.260 — Outbound-Sent-Sync. Hängt die soeben gesendete Mail
   *  (raw RFC822) an den Sent-Folder. Idempotent: bei Fehler still
   *  schlucken — Mail ist gesendet, nur die IMAP-Spiegelung fehlt. */
  async appendToSent(rawMessage: Buffer | string): Promise<void> {
    if (!this.client) return;
    const sent = await this.findFolder("sent");
    if (!sent) return;
    try {
      await this.client.append(sent, rawMessage, ["\\Seen"]);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** v0.1.260 — verschiebt eine Mail (per IMAP-UID, INBOX-Source) in
   *  den Archive-Folder. Liefert true wenn verschoben, false wenn kein
   *  Archive-Folder verfügbar (Caller fällt auf Flag-only zurück). */
  async moveToArchive(uid: number): Promise<boolean> {
    if (!this.client) return false;
    const archive = await this.findFolder("archive");
    if (!archive) return false;
    try {
      // imapflow MOVE braucht den aktuell geöffneten Mailbox-Context.
      // Wir gehen davon aus, dass INBOX offen ist (Standard nach connect).
      await this.client.messageMove(`${uid}`, archive, { uid: true });
      return true;
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* socket already dead */
      }
      this.client = null;
    }
    this.setState("disconnected");
  }

  private async connect(): Promise<void> {
    this.setState("connecting");
    const { ImapFlow } = (await import("imapflow")) as {
      ImapFlow: new (opts: Record<string, unknown>) => ImapFlowType;
    };
    const { account, password } = this.opts;
    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.imap.user, pass: password },
      logger: false, // imapflow's eigener logger ist sehr gesprächig
      emitLogs: false,
    });

    client.on("error", (err: Error) => {
      this.emit("error", err);
      this.scheduleReconnect();
    });
    client.on("close", () => {
      if (!this.stopping) this.scheduleReconnect();
    });

    try {
      await client.connect();
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    this.reconnectAttempt = 0;
    this.setState("connected");

    // Capability-Detect: IDLE?
    const caps = (await client.serverInfo) as unknown as
      | { capabilities?: string[] }
      | undefined;
    const capList = caps?.capabilities ?? [];
    this.idleSupported = capList.some((c) => c.toUpperCase() === "IDLE");

    await client.mailboxOpen("INBOX");
    await this.fetchInitial();

    if (this.idleSupported) {
      this.startIdle();
    } else {
      this.startFallbackPoll();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return;
    this.folderCache.clear(); // Server-Layout könnte sich geändert haben
    const delay =
      RECONNECT_BACKOFF_MS[
        Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.setState("disconnected");
    if (this.client) {
      try {
        void this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    setTimeout(() => {
      if (!this.stopping) void this.connect();
    }, delay);
  }

  /** Beim ersten Connect: alle Mails der letzten N Tage holen. Idempotent
   *  durch ON CONFLICT DO NOTHING im Store (auf imap_uid+folder). */
  private async fetchInitial(): Promise<void> {
    if (!this.client) return;
    const since = new Date(
      Date.now() - (this.opts.initialFetchDays ?? 14) * 86_400_000,
    );
    const range = await this.client.search({ since });
    if (!range || range.length === 0) return;
    for await (const msg of this.client.fetch(range, {
      uid: true,
      envelope: true,
      source: true,
      flags: true,
    })) {
      await this.handleFetchedMessage(msg);
    }
  }

  /** IDLE-Loop. imapflow kümmert sich um Re-Issue alle ~25min (IMAP-Limit). */
  private startIdle(): void {
    if (!this.client) return;
    this.setState("idling");
    void (async () => {
      // imapflow's IDLE-API: client.idle() blockiert bis exists-Event oder
      // expunge oder Timeout. Wir loopen.
      while (!this.stopping && this.client) {
        try {
          await this.client.idle();
          // Nach idle() ist mailbox sync — neue Mails fetchen
          await this.fetchUnseen();
        } catch (err) {
          this.emit("error", err instanceof Error ? err : new Error(String(err)));
          this.scheduleReconnect();
          return;
        }
      }
    })();
  }

  private startFallbackPoll(): void {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.setState("polling");
    this.fallbackTimer = setInterval(() => {
      void this.fetchUnseen().catch((err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }, this.opts.fallbackPollIntervalMs);
  }

  private async fetchUnseen(): Promise<void> {
    if (!this.client) return;
    const range = await this.client.search({ seen: false });
    if (!range || range.length === 0) return;
    for await (const msg of this.client.fetch(range, {
      uid: true,
      envelope: true,
      source: true,
      flags: true,
    })) {
      await this.handleFetchedMessage(msg);
    }
  }

  private async handleFetchedMessage(msg: FetchMessageObject): Promise<void> {
    if (!msg.source) return;
    const { simpleParser } = (await import("mailparser")) as {
      simpleParser: (input: Buffer | string) => Promise<ParsedMail>;
    };
    let parsed: ParsedMail;
    try {
      parsed = await simpleParser(msg.source);
    } catch (err) {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const message = await this.parsedToMessage(parsed, msg);
    this.emit("message", message);
  }

  private async parsedToMessage(
    parsed: ParsedMail,
    raw: FetchMessageObject,
  ): Promise<MailMessage> {
    const attachments: MailAttachment[] = [];
    for (const att of parsed.attachments ?? []) {
      attachments.push(
        await extractAttachment(att, {
          messageId: "pending", // wird vom Store gesetzt
          visionEnabled: this.opts.visionEnabled,
        }),
      );
    }
    const fromAddr = parsed.from?.value?.[0];
    const toList = parsed.to ? toAddressList(parsed.to) : [];
    const ccList = parsed.cc ? toAddressList(parsed.cc) : [];
    const authResults = parseAuthResults(parsed.headerLines);
    return {
      id: "", // wird im Store generiert
      imapUid: typeof raw.uid === "number" ? raw.uid : null,
      folder: "INBOX",
      direction: "inbound",
      from: {
        address: (fromAddr?.address ?? "").toLowerCase(),
        name: fromAddr?.name ?? null,
      },
      to: toList,
      cc: ccList,
      subject: parsed.subject ?? "",
      date: (parsed.date ?? new Date()).toISOString(),
      bodyText: parsed.text ?? "",
      bodyHtml: parsed.html === false ? null : parsed.html ?? null,
      authResults,
      trustLevel: "unknown", // wird von Trust-Engine gesetzt
      classification: null, // wird vom Classifier gesetzt
      attachments,
      readByUser: false,
      archivedAt: null,
      messageIdHeader: parsed.messageId ?? null,
      inReplyTo: parsed.inReplyTo ?? null,
    };
  }

  private setState(state: ImapConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }
}

function toAddressList(
  src: ParsedMail["to"] | ParsedMail["cc"],
): Array<{ address: string; name: string | null }> {
  if (!src) return [];
  const list = Array.isArray(src) ? src : [src];
  const out: Array<{ address: string; name: string | null }> = [];
  for (const entry of list) {
    for (const v of entry.value ?? []) {
      if (v.address) {
        out.push({ address: v.address.toLowerCase(), name: v.name ?? null });
      }
    }
  }
  return out;
}

/** Parst Authentication-Results-Header (RFC 8601) für SPF/DKIM und
 *  prüft From-vs-Return-Path-Match grob heuristisch. */
function parseAuthResults(
  headerLines: ParsedMail["headerLines"],
): MailMessage["authResults"] {
  let spf: MailMessage["authResults"]["spf"] = "none";
  let dkim: MailMessage["authResults"]["dkim"] = "none";
  let from: string | null = null;
  let returnPath: string | null = null;
  for (const h of headerLines ?? []) {
    const key = h.key.toLowerCase();
    const line = h.line;
    if (key === "authentication-results") {
      const spfMatch = /spf=(\w+)/i.exec(line);
      if (spfMatch?.[1]) spf = mapAuthVerdict(spfMatch[1]);
      const dkimMatch = /dkim=(\w+)/i.exec(line);
      if (dkimMatch?.[1]) dkim = mapAuthVerdict(dkimMatch[1]);
    } else if (key === "received-spf" && spf === "none") {
      const m = /^received-spf:\s*(\w+)/i.exec(line);
      if (m?.[1]) spf = mapAuthVerdict(m[1]);
    } else if (key === "from") {
      from = extractAddress(line);
    } else if (key === "return-path") {
      returnPath = extractAddress(line);
    }
  }
  const fromMatchesReturnPath =
    !from || !returnPath || from.toLowerCase() === returnPath.toLowerCase();
  return { spf, dkim, fromMatchesReturnPath };
}

function mapAuthVerdict(verdict: string): "pass" | "fail" | "neutral" | "none" {
  const v = verdict.toLowerCase();
  if (v === "pass") return "pass";
  if (v === "fail" || v === "softfail" || v === "permerror") return "fail";
  if (v === "neutral" || v === "temperror") return "neutral";
  return "none";
}

function extractAddress(line: string): string | null {
  const m = /<([^>]+)>/.exec(line) ?? /([\w.+-]+@[\w.-]+)/.exec(line);
  return m?.[1] ?? null;
}
