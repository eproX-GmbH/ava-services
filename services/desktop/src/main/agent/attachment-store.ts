import { randomUUID } from "node:crypto";

// AttachmentStore (Phase 8.e — Excel-in-chat Scope C bridge).
//
// In-memory hold for the raw bytes + parsed metadata of files the user
// dropped into the chat. The renderer parses xlsx/csv client-side for
// the preview chip, then ships the original bytes here on send so a
// tool (e.g. `import_excel`) can re-upload them via the gateway.
//
// Why we don't ship bytes to the agent directly:
//   - The model sees `[attachment: …, id: <uuid>, N rows]` markers and
//     calls a tool with the id. Bytes never enter the prompt context.
//   - A 142-row spreadsheet is ~10 KB; a 25 MB .xlsx would otherwise
//     blow the context window long before the model has a chance to
//     decide what to do with it.
//
// Lifetime:
//   - Keyed by a fresh UUID per stage. The id appears in the user
//     message that just got sent and in any tool calls that follow.
//   - Soft TTL of 30 minutes — long enough that the user can stage,
//     chat for a while, then say "go", but short enough that abandoned
//     uploads don't sit in RAM forever.
//   - Renderer can `discard` an entry early (e.g. user removed the chip
//     before sending, or we want a fresh staging on edit-and-resend).

export interface StagedSheetSummary {
  name: string;
  headers: string[];
  totalRows: number;
}

export interface StagedAttachment {
  id: string;
  filename: string;
  sizeBytes: number;
  bytes: Uint8Array;
  sheets: StagedSheetSummary[];
  stagedAt: number;
}

export interface StageAttachmentInput {
  filename: string;
  /** Raw file bytes — Electron's structured-clone IPC handles Uint8Array. */
  bytes: Uint8Array;
  sheets: StagedSheetSummary[];
}

const TTL_MS = 30 * 60 * 1000;

export class AttachmentStore {
  private readonly entries = new Map<string, StagedAttachment>();
  private sweepTimer?: NodeJS.Timeout;

  stage(input: StageAttachmentInput): StagedAttachment {
    this.sweepExpired();
    const id = `att-${randomUUID()}`;
    const entry: StagedAttachment = {
      id,
      filename: input.filename,
      sizeBytes: input.bytes.byteLength,
      bytes: input.bytes,
      sheets: input.sheets,
      stagedAt: Date.now(),
    };
    this.entries.set(id, entry);
    this.armSweeper();
    return entry;
  }

  get(id: string): StagedAttachment | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.stagedAt > TTL_MS) {
      this.entries.delete(id);
      return undefined;
    }
    return entry;
  }

  discard(id: string): boolean {
    return this.entries.delete(id);
  }

  /** Drop everything — used on conversation switch / app shutdown. */
  clear(): void {
    this.entries.clear();
  }

  /** Visible for tests. */
  size(): number {
    return this.entries.size;
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.stagedAt > TTL_MS) this.entries.delete(id);
    }
  }

  private armSweeper(): void {
    if (this.sweepTimer) return;
    // Cheap periodic sweep so an idle process doesn't hold dead bytes.
    this.sweepTimer = setInterval(() => this.sweepExpired(), 5 * 60 * 1000);
    // Don't keep the event loop alive just for sweeping.
    this.sweepTimer.unref?.();
  }
}
