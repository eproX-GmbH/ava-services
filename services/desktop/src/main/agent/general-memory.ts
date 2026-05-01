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

// GeneralMemoryStore (Phase 8.k10h).
//
// Long-lived bag of facts the agent should remember across conversations,
// distinct from per-conversation transcripts (which live in MemoryStore).
// Used for things like:
//   - "I work at company X" / "always answer in German"
//   - prior search results the user told us to keep
//   - quick scratchpad entries the user explicitly asked the agent to save
//
// Why a separate store:
//   - Per-conversation transcripts are transcripts; mixing "facts" into
//     them means the recall tool would have to scan every conversation
//     file on every lookup. JSONL with one entry per line is O(n) read
//     and tiny — typical user has < a few hundred entries.
//   - Permanence semantics differ. A user may delete a conversation
//     ("clear chat history") without expecting to lose the fact that
//     they prefer German answers. Two stores = two delete affordances.
//
// File: `userData/agent/general-memory.jsonl`. Append-only writes; full
// load on first read, in-memory cache thereafter. Atomic rewrite on
// remove() to avoid leaving torn lines on a crash mid-delete.
//
// JSON shape per line:
//   { "id": "<uuid>", "content": "<text>", "tags"?: ["..."],
//     "createdAt": <epoch-ms> }
//
// Search is dumb-simple: case-insensitive substring across content +
// tags, ranked by recency. Good enough for the agent's recall needs at
// our scale; a future move to embeddings is straightforward (drop in a
// vector index keyed by `id`, keep this file as the source of truth).

export interface GeneralMemoryEntry {
  id: string;
  content: string;
  tags?: string[];
  createdAt: number;
}

export interface GeneralMemoryProbeResult {
  writable: boolean;
  reason?: string;
  path: string;
}

export class GeneralMemoryStore {
  readonly path: string;
  private readonly dir: string;
  private writable = false;
  private cache: GeneralMemoryEntry[] | null = null;

  constructor(dir?: string) {
    this.dir = dir ?? join(app.getPath("userData"), "agent");
    this.path = join(this.dir, "general-memory.jsonl");
  }

  probe(): GeneralMemoryProbeResult {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      // Touch the file so subsequent appends don't have to mkdir.
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

  /** All entries, newest first. */
  list(): GeneralMemoryEntry[] {
    return this.loadCache().slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Substring search across content + tags. `query` empty → return
   * all entries (used by the agent for "list everything you remember
   * about me" prompts). `limit` defaults to 20 — we don't want to dump
   * megabytes into a single tool result.
   */
  search(query: string, limit = 20): GeneralMemoryEntry[] {
    const all = this.list();
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, limit);
    const out: GeneralMemoryEntry[] = [];
    for (const e of all) {
      const hay = `${e.content}\n${(e.tags ?? []).join(" ")}`.toLowerCase();
      if (hay.includes(q)) out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  add(input: { content: string; tags?: string[] }): GeneralMemoryEntry {
    const trimmed = input.content.trim();
    if (!trimmed) throw new Error("memory entry content is empty");
    const entry: GeneralMemoryEntry = {
      id: randomUUID(),
      content: trimmed,
      ...(input.tags && input.tags.length > 0 ? { tags: input.tags } : {}),
      createdAt: Date.now(),
    };
    if (this.writable) {
      try {
        appendFileSync(this.path, JSON.stringify(entry) + "\n");
      } catch (err) {
        console.warn("[general-memory] append failed:", err);
      }
    }
    // Update cache regardless of disk state — keeps in-process consumers
    // consistent for the lifetime of the run, mirroring MemoryStore's
    // best-effort write semantics.
    if (this.cache) this.cache.push(entry);
    return entry;
  }

  remove(id: string): boolean {
    const all = this.loadCache();
    const idx = all.findIndex((e) => e.id === id);
    if (idx < 0) return false;
    all.splice(idx, 1);
    this.cache = all;
    if (!this.writable) return true;
    // Rewrite atomically: tmp + rename. Cheap for typical sizes.
    const tmp = `${this.path}.${process.pid}.tmp`;
    try {
      const body = all.map((e) => JSON.stringify(e)).join("\n");
      writeFileSync(tmp, body ? body + "\n" : "", { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch (err) {
      console.warn("[general-memory] remove rewrite failed:", err);
    }
    return true;
  }

  // ---- Internal ------------------------------------------------------------

  private loadCache(): GeneralMemoryEntry[] {
    if (this.cache !== null) return this.cache;
    if (!existsSync(this.path)) {
      this.cache = [];
      return this.cache;
    }
    const out: GeneralMemoryEntry[] = [];
    try {
      const raw = readFileSync(this.path, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as Partial<GeneralMemoryEntry>;
          if (
            typeof parsed.id === "string" &&
            typeof parsed.content === "string" &&
            typeof parsed.createdAt === "number"
          ) {
            out.push({
              id: parsed.id,
              content: parsed.content,
              createdAt: parsed.createdAt,
              ...(Array.isArray(parsed.tags) ? { tags: parsed.tags } : {}),
            });
          }
        } catch {
          // Skip malformed lines — tolerate manual edits the same way
          // MemoryStore tolerates them.
        }
      }
    } catch (err) {
      console.warn("[general-memory] read failed:", err);
    }
    this.cache = out;
    return this.cache;
  }
}
