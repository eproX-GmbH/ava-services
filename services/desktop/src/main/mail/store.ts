// v0.1.257 — Lokaler Mail-Store (Phase 9.m).
//
// PGlite-Speicher für AVAs Mail-Konto: das Konto selbst (1 Row),
// eingegangene und gesendete Nachrichten, Anhänge (BLOBs ≤ 10 MB
// inline, größere via cachePath auf Filesystem), und die Sender-
// Allowlist, die das Trust-Modell antreibt.
//
// Datenpfad: `<userData>/pglite/mail/`. Verlässt die Maschine nie.
// Verschlüsselung der Creds liegt im MailAccountManager (safeStorage),
// nicht hier — der Store speichert nur die nicht-sensitiven Felder
// von MailAccount. IMAP/SMTP-Passwörter und OAuth-Tokens werden
// separat im OS-Keychain gehalten.
//
// Single-writer: nur main-process ruft start()/record(). Renderer
// liest über IPC-Snapshots.

import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type {
  MailAccount,
  MailAllowlistEntry,
  MailAttachment,
  MailClassification,
  MailMessage,
  MailSnapshot,
  MailTrustLevel,
} from "../../shared/types";

/** Anhänge größer als das Inline-Limit landen auf dem Filesystem,
 *  nicht im PGlite-BLOB. PGlite ist nicht für 100MB-PDFs optimiert. */
const INLINE_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;

interface PGliteInstance {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

interface MessageRow {
  id: string;
  imap_uid: number | string | null;
  folder: string;
  direction: string;
  from_address: string;
  from_name: string | null;
  to_json: string | null;
  cc_json: string | null;
  subject: string;
  date: string;
  body_text: string;
  body_html: string | null;
  auth_results_json: string | null;
  trust_level: string;
  classification_json: string | null;
  read_by_user: boolean;
  archived_at: string | null;
  message_id_header: string | null;
  in_reply_to: string | null;
}

interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  extracted_text: string | null;
  image_base64: string | null;
  cache_path: string | null;
}

interface AccountRow {
  address: string;
  display_name: string;
  imap_json: string;
  smtp_json: string;
  outbound_enabled: boolean;
  // v0.1.299 — Optional, weil ältere Tables die Spalte noch nicht haben
  // (siehe applySchema unten — ALTER TABLE ADD COLUMN IF NOT EXISTS).
  auto_triage_enabled?: boolean | null;
  poll_interval_minutes: number | string;
  last_sync_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
}

interface AllowlistRow {
  id: string;
  pattern: string;
  label: string;
  added_at: string;
  source: string;
}

export interface MailStoreEvents {
  /** Neue inbound Mail wurde gespeichert (vor Klassifikation). */
  messageReceived: (message: MailMessage) => void;
  /** Bestehende Mail wurde aktualisiert (z. B. Classification ergänzt). */
  messageUpdated: (message: MailMessage) => void;
  /** Allowlist hat sich geändert — Trust-Engine soll neu evaluieren. */
  allowlistChanged: (entries: MailAllowlistEntry[]) => void;
  /** Konto wurde konfiguriert oder geändert. */
  accountChanged: (account: MailAccount | null) => void;
}

export declare interface MailStore {
  on<K extends keyof MailStoreEvents>(
    event: K,
    listener: MailStoreEvents[K],
  ): this;
  emit<K extends keyof MailStoreEvents>(
    event: K,
    ...args: Parameters<MailStoreEvents[K]>
  ): boolean;
}

export class MailStore extends EventEmitter {
  private pglite: PGliteInstance | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly dataRoot = defaultDataRoot()) {
    super();
  }

  async start(): Promise<void> {
    if (this.pglite) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      mkdirSync(this.dataRoot, { recursive: true });
      const mod = (await import("@electric-sql/pglite")) as unknown as {
        PGlite: new (path: string) => PGliteInstance;
      };
      this.pglite = new mod.PGlite(this.dataRoot);
      await this.applySchema();
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async stop(): Promise<void> {
    if (!this.pglite) return;
    try {
      await this.pglite.close();
    } catch {
      /* shutdown */
    }
    this.pglite = null;
  }

  // ---------------- Account ----------------

  async getAccount(): Promise<MailAccount | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<AccountRow>(
      `SELECT * FROM mail_account LIMIT 1`,
    );
    const row = res.rows[0];
    if (!row) return null;
    return rowToAccount(row);
  }

  async setAccount(account: MailAccount): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    // Single-row table: löschen + neu einfügen ist einfacher als UPSERT
    // bei sich änderndem PK (address kann gewechselt werden).
    await pg.exec(`DELETE FROM mail_account`);
    await pg.query(
      `INSERT INTO mail_account
         (address, display_name, imap_json, smtp_json, outbound_enabled,
          auto_triage_enabled,
          poll_interval_minutes, last_sync_at, last_error_at, last_error_message)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10)`,
      [
        account.address,
        account.displayName,
        JSON.stringify(account.imap),
        JSON.stringify(account.smtp),
        // v0.1.318 — Beide Toggles defaulten auf TRUE wenn nicht
        // explizit gesetzt. Vorher wurde `autoTriageEnabled === true`
        // genutzt, was undefined zu FALSE machte → User legte ein
        // Konto an und Auto-Antwort war stumm aus.
        account.outboundEnabled !== false,
        account.autoTriageEnabled !== false,
        account.pollIntervalMinutes,
        account.lastSyncAt,
        account.lastErrorAt,
        account.lastErrorMessage,
      ],
    );
    this.emit("accountChanged", account);
  }

  async deleteAccount(): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.exec(`DELETE FROM mail_account`);
    // Mails bleiben für Audit/Verlauf erhalten; nur das Konto wird entfernt.
    this.emit("accountChanged", null);
  }

  async updateAccountSyncState(patch: {
    lastSyncAt?: string | null;
    lastErrorAt?: string | null;
    lastErrorMessage?: string | null;
  }): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    const fields: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      fields.push(`${col} = $${params.length}`);
    };
    if (patch.lastSyncAt !== undefined) push("last_sync_at", patch.lastSyncAt);
    if (patch.lastErrorAt !== undefined) push("last_error_at", patch.lastErrorAt);
    if (patch.lastErrorMessage !== undefined)
      push("last_error_message", patch.lastErrorMessage);
    if (fields.length === 0) return;
    await pg.query(`UPDATE mail_account SET ${fields.join(", ")}`, params);
    const account = await this.getAccount();
    if (account) this.emit("accountChanged", account);
  }

  // ---------------- Allowlist ----------------

  async listAllowlist(): Promise<MailAllowlistEntry[]> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<AllowlistRow>(
      `SELECT * FROM mail_allowlist ORDER BY added_at DESC`,
    );
    return res.rows.map(rowToAllowlist);
  }

  async addAllowlistEntry(input: {
    pattern: string;
    label: string;
    source: "user" | "agent";
  }): Promise<MailAllowlistEntry> {
    await this.start();
    const pg = this.requirePg();
    const entry: MailAllowlistEntry = {
      id: randomUUID(),
      pattern: input.pattern.toLowerCase().trim(),
      label: input.label.trim(),
      addedAt: new Date().toISOString(),
      source: input.source,
    };
    // ON CONFLICT: pattern ist unique. Bei Re-Add → bestehenden Eintrag
    // zurückgeben (label-Update wenn gewünscht).
    await pg.query(
      `INSERT INTO mail_allowlist (id, pattern, label, added_at, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (pattern) DO UPDATE SET label = EXCLUDED.label`,
      [entry.id, entry.pattern, entry.label, entry.addedAt, entry.source],
    );
    const entries = await this.listAllowlist();
    this.emit("allowlistChanged", entries);
    return entry;
  }

  async removeAllowlistEntry(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(`DELETE FROM mail_allowlist WHERE id = $1`, [id]);
    const entries = await this.listAllowlist();
    this.emit("allowlistChanged", entries);
  }

  // ---------------- Messages ----------------

  async recordMessage(
    input: Omit<MailMessage, "id" | "readByUser" | "archivedAt"> & {
      id?: string;
      readByUser?: boolean;
      archivedAt?: string | null;
    },
  ): Promise<MailMessage> {
    await this.start();
    const pg = this.requirePg();
    // v0.1.262 Hotfix — Idempotenz via natürlicher IMAP-Identität.
    // Wenn diese Mail (folder + uid) schon mal gespeichert wurde, deren
    // existierende ID weiterverwenden statt einer neuen UUID. Sonst
    // hätten wir bei jedem Reconnect/Re-Fetch Duplikate.
    if (input.imapUid != null) {
      const existing = await this.findByImapUid(input.folder, input.imapUid);
      if (existing) return existing;
    }
    const message: MailMessage = {
      ...input,
      // WICHTIG: `||` statt `??` — der IMAP-Client liefert `id: ""` als
      // Platzhalter (nicht null/undefined), der Nullish-Coalescing-Operator
      // würde den Empty-String durchlassen und alle Mails kollidierten
      // auf id="" via ON CONFLICT (id) DO NOTHING.
      id: input.id || randomUUID(),
      readByUser: input.readByUser ?? false,
      archivedAt: input.archivedAt ?? null,
    };
    await pg.query(
      `INSERT INTO mail_messages
         (id, imap_uid, folder, direction, from_address, from_name,
          to_json, cc_json, subject, date, body_text, body_html,
          auth_results_json, trust_level, classification_json,
          read_by_user, archived_at, message_id_header, in_reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
               $11, $12, $13::jsonb, $14, $15::jsonb, $16, $17, $18, $19)
       ON CONFLICT (id) DO NOTHING`,
      [
        message.id,
        message.imapUid,
        message.folder,
        message.direction,
        message.from.address.toLowerCase(),
        message.from.name,
        JSON.stringify(message.to),
        JSON.stringify(message.cc),
        message.subject,
        message.date,
        message.bodyText,
        message.bodyHtml,
        JSON.stringify(message.authResults),
        message.trustLevel,
        message.classification ? JSON.stringify(message.classification) : null,
        message.readByUser,
        message.archivedAt,
        message.messageIdHeader,
        message.inReplyTo,
      ],
    );
    for (const att of message.attachments) {
      await this.upsertAttachment({ ...att, messageId: message.id });
    }
    this.emit("messageReceived", message);
    return message;
  }

  async findByImapUid(
    folder: string,
    uid: number,
  ): Promise<MailMessage | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<MessageRow>(
      `SELECT * FROM mail_messages WHERE folder = $1 AND imap_uid = $2 LIMIT 1`,
      [folder, uid],
    );
    const row = res.rows[0];
    if (!row) return null;
    const attachments = await this.attachmentsFor(row.id);
    return rowToMessage(row, attachments);
  }

  async updateClassification(
    id: string,
    classification: MailClassification,
  ): Promise<MailMessage | null> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `UPDATE mail_messages SET classification_json = $2::jsonb WHERE id = $1`,
      [id, JSON.stringify(classification)],
    );
    const message = await this.getMessage(id);
    if (message) this.emit("messageUpdated", message);
    return message;
  }

  async updateTrustLevel(id: string, level: MailTrustLevel): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `UPDATE mail_messages SET trust_level = $2 WHERE id = $1`,
      [id, level],
    );
    const message = await this.getMessage(id);
    if (message) this.emit("messageUpdated", message);
  }

  async markRead(id: string, read = true): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `UPDATE mail_messages SET read_by_user = $2 WHERE id = $1`,
      [id, read],
    );
    const message = await this.getMessage(id);
    if (message) this.emit("messageUpdated", message);
  }

  async archive(id: string): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    await pg.query(
      `UPDATE mail_messages SET archived_at = $2 WHERE id = $1`,
      [id, new Date().toISOString()],
    );
    const message = await this.getMessage(id);
    if (message) this.emit("messageUpdated", message);
  }

  async getMessage(id: string): Promise<MailMessage | null> {
    await this.start();
    const pg = this.requirePg();
    const res = await pg.query<MessageRow>(
      `SELECT * FROM mail_messages WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) return null;
    const attachments = await this.attachmentsFor(row.id);
    return rowToMessage(row, attachments);
  }

  async listInbox(
    options: { limit?: number; includeArchived?: boolean } = {},
  ): Promise<MailMessage[]> {
    await this.start();
    const pg = this.requirePg();
    const limit = Math.min(options.limit ?? 100, 500);
    const whereArchived = options.includeArchived ? "" : "AND archived_at IS NULL";
    const res = await pg.query<MessageRow>(
      `SELECT * FROM mail_messages
        WHERE direction = 'inbound' ${whereArchived}
        ORDER BY date DESC
        LIMIT $1`,
      [limit],
    );
    const out: MailMessage[] = [];
    for (const row of res.rows) {
      const attachments = await this.attachmentsFor(row.id);
      out.push(rowToMessage(row, attachments));
    }
    return out;
  }

  /** Anzahl Mails pro Absender in den letzten N Stunden. Trust-Engine
   *  nutzt das zur Rate-Limit-Heuristik. */
  async countFromSenderRecent(
    fromAddress: string,
    hours: number,
  ): Promise<number> {
    await this.start();
    const pg = this.requirePg();
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const res = await pg.query<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM mail_messages
        WHERE direction = 'inbound'
          AND from_address = $1
          AND date >= $2`,
      [fromAddress.toLowerCase(), since],
    );
    const n = res.rows[0]?.n;
    return typeof n === "string" ? parseInt(n, 10) : Number(n ?? 0);
  }

  // ---------------- Attachments ----------------

  async upsertAttachment(att: MailAttachment): Promise<void> {
    await this.start();
    const pg = this.requirePg();
    if (att.sizeBytes > INLINE_ATTACHMENT_LIMIT_BYTES) {
      // Sicherung gegen versehentliches Inline-BLOB-Speichern.
      if (att.imageBase64) {
        throw new Error(
          `Attachment ${att.filename} (${att.sizeBytes} B) übersteigt Inline-Limit. cachePath nutzen.`,
        );
      }
    }
    await pg.query(
      `INSERT INTO mail_attachments
         (id, message_id, filename, mime_type, size_bytes,
          extracted_text, image_base64, cache_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         extracted_text = EXCLUDED.extracted_text,
         image_base64   = EXCLUDED.image_base64,
         cache_path     = EXCLUDED.cache_path`,
      [
        att.id,
        att.messageId,
        att.filename,
        att.mimeType,
        att.sizeBytes,
        att.extractedText,
        att.imageBase64,
        att.cachePath,
      ],
    );
  }

  private async attachmentsFor(messageId: string): Promise<MailAttachment[]> {
    const pg = this.requirePg();
    const res = await pg.query<AttachmentRow>(
      `SELECT * FROM mail_attachments WHERE message_id = $1 ORDER BY filename`,
      [messageId],
    );
    return res.rows.map(rowToAttachment);
  }

  /**
   * v0.1.299 — Per-Thread Auto-Reply-Quota.
   *
   * Reserviert ein Auto-Reply-Slot für einen Thread. Returnt
   * { allowed: true } wenn die Quota frei ist (= AVA darf antworten),
   * { allowed: false, reason } sonst. Wenn allowed=true wird der
   * Counter SOFORT hochgezählt (auch wenn der Agent dann doch nichts
   * sendet — dann ist es ein „wasted slot", aber das ist sicherer als
   * race-conditions zwischen Trigger und Reply).
   *
   * Limits:
   *   - max 5 Auto-Replies pro Thread insgesamt
   *   - max 1 Auto-Reply alle 5 Minuten pro Thread (Cooldown)
   *
   * threadKey: normalisierte Form von (Subject ohne "Re:" + Sender-Address).
   */
  async checkAndReserveAutoReplyQuota(threadKey: string): Promise<{
    allowed: boolean;
    reason?: string;
    replyCount?: number;
  }> {
    const pg = this.requirePg();
    const now = new Date();
    const existing = await pg.query<{
      reply_count: number;
      last_reply_at: string;
      first_reply_at: string;
    }>(
      `SELECT reply_count, last_reply_at, first_reply_at
       FROM mail_auto_reply_log
       WHERE thread_key = $1`,
      [threadKey],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0]!;
      const count =
        typeof row.reply_count === "number"
          ? row.reply_count
          : Number(row.reply_count);
      if (count >= 5) {
        return {
          allowed: false,
          reason: `Auto-Reply-Limit (5) für diesen Thread erreicht`,
          replyCount: count,
        };
      }
      const lastAt = new Date(row.last_reply_at).getTime();
      const cooldownMs = 5 * 60 * 1000;
      if (now.getTime() - lastAt < cooldownMs) {
        const remainingMin = Math.ceil(
          (cooldownMs - (now.getTime() - lastAt)) / 60000,
        );
        return {
          allowed: false,
          reason: `Cooldown aktiv — nächste Auto-Reply in ${remainingMin}min`,
          replyCount: count,
        };
      }
      // Quota frei — hochzählen.
      await pg.query(
        `UPDATE mail_auto_reply_log
         SET reply_count = reply_count + 1,
             last_reply_at = $2
         WHERE thread_key = $1`,
        [threadKey, now.toISOString()],
      );
      return { allowed: true, replyCount: count + 1 };
    }
    // Erstes Reply für diesen Thread.
    await pg.query(
      `INSERT INTO mail_auto_reply_log
         (thread_key, reply_count, first_reply_at, last_reply_at)
       VALUES ($1, 1, $2, $2)`,
      [threadKey, now.toISOString()],
    );
    return { allowed: true, replyCount: 1 };
  }

  // ---------------- Snapshot (für IPC) ----------------

  async snapshot(): Promise<MailSnapshot> {
    const [account, messages, allowlist] = await Promise.all([
      this.getAccount(),
      this.listInbox({ limit: 200 }),
      this.listAllowlist(),
    ]);
    const unreadCount = messages.filter((m) => !m.readByUser).length;
    return {
      account,
      // connectionState wird vom Supervisor injiziert, store kennt es nicht.
      connectionState: "disconnected",
      unreadCount,
      messages,
      allowlist,
    };
  }

  // ---------------- intern ----------------

  private requirePg(): PGliteInstance {
    if (!this.pglite) {
      throw new Error("MailStore not started yet — call start() first");
    }
    return this.pglite;
  }

  private async applySchema(): Promise<void> {
    const pg = this.requirePg();
    await pg.exec(`
      CREATE TABLE IF NOT EXISTS mail_account (
        address                TEXT PRIMARY KEY,
        display_name           TEXT NOT NULL,
        imap_json              JSONB NOT NULL,
        smtp_json              JSONB NOT NULL,
        outbound_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
        poll_interval_minutes  INTEGER NOT NULL DEFAULT 15,
        last_sync_at           TIMESTAMPTZ,
        last_error_at          TIMESTAMPTZ,
        last_error_message     TEXT
      );
      -- v0.1.299 — Migration: auto_triage_enabled hinzufügen, wenn das
      -- Schema schon mit v0.1.282 erzeugt wurde. IF NOT EXISTS macht
      -- den ALTER idempotent.
      ALTER TABLE mail_account
        ADD COLUMN IF NOT EXISTS auto_triage_enabled BOOLEAN NOT NULL DEFAULT TRUE;
      -- v0.1.318 — Defaults von outbound + auto_triage auf TRUE gesetzt.
      -- Hintergrund: der User erwartet "Whitelist == AVA antwortet
      -- automatisch", drei separate Sicherheits-Toggles waren zu viel
      -- Reibung. Outbound bleibt als Kill-Switch (UI), aber Default an.
      -- Auto-Migration für bereits angelegte Konten, sonst hilft das
      -- neue Default nichts: einmalig ON setzen wenn auto_triage_enabled
      -- noch nie aktiv war. Marker via mail_migration_log damit's nicht
      -- bei jedem Boot toggled (User kann manuell wieder abdrehen).
      CREATE TABLE IF NOT EXISTS mail_migration_log (
        migration_id TEXT PRIMARY KEY,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM mail_migration_log WHERE migration_id = 'v0.1.318_default_auto_triage_on'
        ) THEN
          UPDATE mail_account
             SET auto_triage_enabled = TRUE,
                 outbound_enabled    = TRUE
           WHERE auto_triage_enabled = FALSE OR outbound_enabled = FALSE;
          INSERT INTO mail_migration_log (migration_id) VALUES ('v0.1.318_default_auto_triage_on');
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS mail_allowlist (
        id        TEXT PRIMARY KEY,
        pattern   TEXT NOT NULL UNIQUE,
        label     TEXT NOT NULL,
        added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mail_allowlist_pattern_idx
        ON mail_allowlist (pattern);

      CREATE TABLE IF NOT EXISTS mail_messages (
        id                    TEXT PRIMARY KEY,
        imap_uid              BIGINT,
        folder                TEXT NOT NULL,
        direction             TEXT NOT NULL,
        from_address          TEXT NOT NULL,
        from_name             TEXT,
        to_json               JSONB NOT NULL DEFAULT '[]'::jsonb,
        cc_json               JSONB NOT NULL DEFAULT '[]'::jsonb,
        subject               TEXT NOT NULL DEFAULT '',
        date                  TIMESTAMPTZ NOT NULL,
        body_text             TEXT NOT NULL DEFAULT '',
        body_html             TEXT,
        auth_results_json     JSONB,
        trust_level           TEXT NOT NULL DEFAULT 'unknown',
        classification_json   JSONB,
        read_by_user          BOOLEAN NOT NULL DEFAULT FALSE,
        archived_at           TIMESTAMPTZ,
        message_id_header     TEXT,
        in_reply_to           TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_messages_date_idx
        ON mail_messages (date DESC);
      CREATE INDEX IF NOT EXISTS mail_messages_from_idx
        ON mail_messages (from_address);
      CREATE INDEX IF NOT EXISTS mail_messages_folder_uid_idx
        ON mail_messages (folder, imap_uid);
      CREATE INDEX IF NOT EXISTS mail_messages_direction_archived_idx
        ON mail_messages (direction, archived_at);

      CREATE TABLE IF NOT EXISTS mail_attachments (
        id              TEXT PRIMARY KEY,
        message_id      TEXT NOT NULL,
        filename        TEXT NOT NULL,
        mime_type       TEXT NOT NULL,
        size_bytes      BIGINT NOT NULL,
        extracted_text  TEXT,
        image_base64    TEXT,
        cache_path      TEXT
      );
      CREATE INDEX IF NOT EXISTS mail_attachments_message_idx
        ON mail_attachments (message_id);

      -- v0.1.299 — Per-Thread Auto-Reply-Counter für den Loop-Guard.
      -- Wenn AVA im Auto-Triage-Modus auf eine Mail antwortet, könnte
      -- die Reply selbst eine Reply auslösen (Ping-Pong). Wir tracken
      -- pro Thread die Anzahl Auto-Replies und stoppen bei N=5 oder
      -- Cooldown unter 5min.
      CREATE TABLE IF NOT EXISTS mail_auto_reply_log (
        thread_key      TEXT PRIMARY KEY,
        reply_count     INTEGER NOT NULL DEFAULT 0,
        last_reply_at   TIMESTAMPTZ NOT NULL,
        first_reply_at  TIMESTAMPTZ NOT NULL
      );
    `);

    // v0.1.262 Hotfix — Bestehende Rows mit id='' reparieren. Tritt auf
    // bei Stores die unter v0.1.257-v0.1.261 angelegt wurden, wo
    // input.id ?? randomUUID() den Empty-String durchgelassen hat.
    // Anhänge müssen auf die neue ID umgemappt werden, sonst werden
    // sie waisen.
    // Da `id` PRIMARY KEY ist, kann es höchstens EINE Row mit id='' geben.
    const broken = await pg.query<{ n: string | number }>(
      `SELECT COUNT(*)::text AS n FROM mail_messages WHERE id = ''`,
    );
    const brokenCount =
      typeof broken.rows[0]?.n === "string"
        ? parseInt(broken.rows[0].n, 10)
        : Number(broken.rows[0]?.n ?? 0);
    if (brokenCount > 0) {
      const newId = randomUUID();
      await pg.query(`UPDATE mail_messages SET id = $1 WHERE id = ''`, [newId]);
      await pg.query(
        `UPDATE mail_attachments SET message_id = $1 WHERE message_id = ''`,
        [newId],
      );
      console.log(
        `[mail/store] Migration: defekte Mail-Row mit leerer ID auf ${newId} umbenannt.`,
      );
    }
  }
}

function defaultDataRoot(): string {
  return join(app.getPath("userData"), "pglite", "mail");
}

function rowToAccount(row: AccountRow): MailAccount {
  return {
    address: row.address,
    displayName: row.display_name,
    imap: parseJson(row.imap_json) as MailAccount["imap"],
    smtp: parseJson(row.smtp_json) as MailAccount["smtp"],
    outboundEnabled: row.outbound_enabled,
    autoTriageEnabled: row.auto_triage_enabled === true,
    pollIntervalMinutes: Number(row.poll_interval_minutes),
    lastSyncAt: row.last_sync_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
  };
}

function rowToAllowlist(row: AllowlistRow): MailAllowlistEntry {
  return {
    id: row.id,
    pattern: row.pattern,
    label: row.label,
    addedAt: row.added_at,
    source: row.source === "agent" ? "agent" : "user",
  };
}

function rowToMessage(
  row: MessageRow,
  attachments: MailAttachment[],
): MailMessage {
  return {
    id: row.id,
    imapUid: row.imap_uid == null ? null : Number(row.imap_uid),
    folder: row.folder,
    direction: row.direction === "outbound" ? "outbound" : "inbound",
    from: { address: row.from_address, name: row.from_name },
    to: (parseJson(row.to_json) ?? []) as MailMessage["to"],
    cc: (parseJson(row.cc_json) ?? []) as MailMessage["cc"],
    subject: row.subject,
    date: row.date,
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    authResults: (parseJson(row.auth_results_json) ?? {
      spf: "none",
      dkim: "none",
      fromMatchesReturnPath: true,
    }) as MailMessage["authResults"],
    trustLevel: row.trust_level as MailTrustLevel,
    classification: parseJson(row.classification_json) as MailClassification | null,
    attachments,
    readByUser: row.read_by_user,
    archivedAt: row.archived_at,
    messageIdHeader: row.message_id_header,
    inReplyTo: row.in_reply_to,
  };
}

function rowToAttachment(row: AttachmentRow): MailAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    extractedText: row.extracted_text,
    imageBase64: row.image_base64,
    cachePath: row.cache_path,
  };
}

function parseJson(value: string | Record<string, unknown> | null): unknown {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export { INLINE_ATTACHMENT_LIMIT_BYTES };
