import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import type { Alert, AlertKind, AlertSeverity } from "../../shared/types";

// AlertsStore (Phase 8.f1).
//
// Append-only JSONL of heartbeat-generated alerts, mirroring
// general-memory.ts. Keeping a separate file (not stuffing into
// general-memory.jsonl) because:
//   - Alert rows have very different lifecycle: generated, seen,
//     dismissed. General-memory rows are fact ↔ delete only.
//   - Volume is asymmetric. Long-running users will accumulate
//     hundreds-to-thousands of alerts; we don't want every
//     `recall_memory` lookup to scan past them.
//   - Wiping memory ("forget everything you know about me") shouldn't
//     also wipe alerts, and vice-versa.
//
// Storage: `userData/agent/alerts.jsonl`, one JSON-encoded `Alert` per
// line. In-memory cache lazily populated; sourceRef → row index Map for
// O(1) dedup. Mutations rewrite atomically (tmp + rename) the same way
// GeneralMemoryStore.remove does, so a crash mid-write can't leave torn
// lines.

export interface AlertsProbeResult {
  writable: boolean;
  reason?: string;
  path: string;
}

export interface AlertCreateInput {
  tenantId: string | null;
  companyId: string;
  companyName: string;
  kind: AlertKind;
  severity: AlertSeverity;
  headline: string;
  rationale: string;
  /**
   * Identifies the upstream signal so the same item can't be alerted
   * twice. The store hashes nothing — callers provide a stable string
   * (e.g. `publication:${companyId}:${publicationId}`).
   */
  sourceRef: string;
  /** v0.1.369 — optionale externe Quell-URL (z. B. LinkedIn-Permalink). */
  url?: string | null;
}

export class AlertsStore {
  readonly path: string;
  private readonly dir: string;
  private writable = false;
  private cache: Alert[] | null = null;
  private bySourceRef: Map<string, number> = new Map();

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "alerts.jsonl");
  }

  probe(): AlertsProbeResult {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      if (!existsSync(this.path)) {
        writeFileSync(this.path, "", { mode: 0o600 });
      }
      this.writable = true;
      return { writable: true, path: this.path };
    } catch (err) {
      this.writable = false;
      return {
        writable: false,
        path: this.path,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  isWritable(): boolean {
    return this.writable;
  }

  /**
   * All non-dismissed alerts, newest first. The renderer's `/alerts`
   * route renders this directly; dismissed rows stay on disk for audit
   * but never reach the UI.
   */
  list(): Alert[] {
    return this.loadCache()
      .filter((a) => a.dismissedAt === null)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Number of alerts the user hasn't yet marked as read. */
  unreadCount(): number {
    return this.loadCache().filter(
      (a) => a.dismissedAt === null && a.seenAt === null,
    ).length;
  }

  hasSourceRef(sourceRef: string): boolean {
    this.loadCache();
    return this.bySourceRef.has(sourceRef);
  }

  /**
   * Insert a new alert. Returns the inserted row, or `null` if the
   * `sourceRef` already exists (dedup). Callers can treat `null` as
   * "already alerted, do nothing".
   */
  add(input: AlertCreateInput): Alert | null {
    this.loadCache();
    if (this.bySourceRef.has(input.sourceRef)) return null;
    const row: Alert = {
      id: randomUUID(),
      tenantId: input.tenantId,
      companyId: input.companyId,
      companyName: input.companyName,
      kind: input.kind,
      severity: input.severity,
      headline: input.headline.trim().slice(0, 120),
      rationale: input.rationale.trim().slice(0, 500),
      sourceRef: input.sourceRef,
      createdAt: new Date().toISOString(),
      seenAt: null,
      dismissedAt: null,
      ...(input.url ? { url: input.url } : {}),
    };
    if (this.writable) {
      try {
        appendFileSync(this.path, JSON.stringify(row) + "\n");
      } catch (err) {
        console.warn("[alerts] append failed:", err);
      }
    }
    if (this.cache) {
      this.cache.push(row);
      this.bySourceRef.set(row.sourceRef, this.cache.length - 1);
    }
    return row;
  }

  markSeen(id: string): boolean {
    return this.patch(id, { seenAt: new Date().toISOString() });
  }

  dismiss(id: string): boolean {
    const now = new Date().toISOString();
    return this.patch(id, { dismissedAt: now, seenAt: now });
  }

  /**
   * Bulk-dismiss every currently-visible alert. Returns the number of
   * rows touched. Used by the `alerts_dismiss_all` tool when the user
   * tells the agent "lösche alle Meldungen". Dismissed rows stay on
   * disk for audit (same semantics as single-row `dismiss`); the
   * `/alerts` route + bell never show them again.
   */
  dismissAll(): number {
    const all = this.loadCache();
    const now = new Date().toISOString();
    let touched = 0;
    const next = all.map((a) => {
      if (a.dismissedAt !== null) return a;
      touched += 1;
      return { ...a, dismissedAt: now, seenAt: a.seenAt ?? now };
    });
    if (touched === 0) return 0;
    this.rewrite(next);
    return touched;
  }

  /**
   * Hard delete — physically removes rows from `alerts.jsonl` and the
   * in-memory `sourceRef` index. Used by the `alerts_purge` tool when
   * the user wants entries to come back on the next heartbeat tick
   * (e.g. "lösche endgültig", "retrigger alle"). Soft-dismissed rows
   * keep blocking re-creation via the `sourceRef` dedup, so a true
   * reset has to nuke them, not just hide them.
   *
   * `dismissedOnly: true` retains active alerts and only removes those
   * already in the dismissed bucket — useful for "räum auf, aber
   * behalte was noch sichtbar ist".
   */
  purge(opts: { dismissedOnly?: boolean } = {}): { removed: number } {
    const all = this.loadCache();
    const keep = opts.dismissedOnly
      ? all.filter((a) => a.dismissedAt === null)
      : [];
    const removed = all.length - keep.length;
    if (removed === 0) return { removed: 0 };
    this.rewrite(keep);
    return { removed };
  }

  // ---- Internal -----------------------------------------------------------

  private patch(id: string, fields: Partial<Alert>): boolean {
    const all = this.loadCache();
    const idx = all.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    all[idx] = { ...all[idx]!, ...fields };
    return this.rewrite(all);
  }

  private rewrite(all: Alert[]): boolean {
    this.cache = all;
    this.bySourceRef = new Map(all.map((a, i) => [a.sourceRef, i]));
    if (!this.writable) return true;
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      const body = all.map((a) => JSON.stringify(a)).join("\n");
      writeFileSync(tmp, body ? body + "\n" : "", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[alerts] rewrite failed:", err);
      return false;
    }
    return true;
  }

  private loadCache(): Alert[] {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      this.bySourceRef = new Map();
      return this.cache;
    }
    const out: Alert[] = [];
    try {
      const raw = readFileSync(this.path, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<Alert>;
          if (this.isValid(parsed)) {
            out.push(parsed);
          }
        } catch {
          // Tolerate manual edits / torn lines from a crashed write.
        }
      }
    } catch (err) {
      console.warn("[alerts] read failed:", err);
    }
    this.cache = out;
    this.bySourceRef = new Map(out.map((a, i) => [a.sourceRef, i]));
    return this.cache;
  }

  private isValid(v: Partial<Alert>): v is Alert {
    return (
      typeof v.id === "string" &&
      typeof v.companyId === "string" &&
      typeof v.companyName === "string" &&
      typeof v.kind === "string" &&
      typeof v.severity === "string" &&
      typeof v.headline === "string" &&
      typeof v.rationale === "string" &&
      typeof v.sourceRef === "string" &&
      typeof v.createdAt === "string"
    );
  }
}
