import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { AgentMessage } from "../../shared/types";

// MemoryStore (Phase 8.d).
//
// On-disk persistence for conversation transcripts. Each conversation lives
// in its own markdown file under `userData/agent/memory/<conversationId>.md`.
// Append-only on the write path (so a crash mid-turn doesn't corrupt prior
// messages); full-file parse on the read path (cheap — most conversations
// are < 100 messages, reading them in one shot dominates the per-message
// streaming overhead).
//
// File format:
//   ---
//   conversationId: <id>
//   createdAt: <ISO>
//   ---
//
//   ## user · <messageId> · <ISO>
//
//   <content>
//
//   ## assistant · <messageId> · <ISO>
//
//   ```toolcall <toolCallId>
//   <name>(<args-json>)
//   ```
//
//   ## tool · <messageId> · <ISO> · <toolCallId>
//
//   <content>
//
// Why markdown: it's user-readable. An analyst can open the .md in any
// editor to inspect what the agent did. Re-loading is best-effort — we
// tolerate manual edits, dropping unparseable sections rather than
// crashing.
//
// Tool calls are serialised as a fenced ```toolcall block under the
// assistant message so a parser doesn't have to choose between "is this
// content or metadata" — anything outside fenced blocks is content.

export interface MemoryProbeResult {
  writable: boolean;
  /** Filled when writable=false. Human-readable; surfaced in
   *  `AgentStatus.memoryError` and the FirstRunWizard fallback. */
  reason?: string;
  /** The directory we tried to use; useful for the user-facing error
   *  message ("memory dir at /Users/.../@ava/desktop/agent/memory not
   *  writable"). */
  path: string;
}

export interface MemoryListEntry {
  conversationId: string;
  modifiedAt: number;
  sizeBytes: number;
  /**
   * Human-readable label for the dropdown. Derived from the first
   * user message's first line, truncated to ~60 chars. Empty string
   * if the conversation has no user message yet (e.g. initialised
   * but never sent).
   */
  label: string;
}

export class MemoryStore {
  readonly dir: string;
  private writable = false;

  constructor(dir?: string) {
    // Override hook for tests / dev — production always lands in userData.
    this.dir = dir ?? join(app.getPath("userData"), "agent", "memory");
  }

  // ---- Probe ---------------------------------------------------------------

  /**
   * Verifies the memory directory exists and is writable. Called on app
   * boot. The result is cached on the instance — `isWritable()` reads it
   * back without retouching disk. Re-probe by constructing a new store.
   */
  probe(): MemoryProbeResult {
    try {
      if (!existsSync(this.dir)) {
        mkdirSync(this.dir, { recursive: true });
      }
      // Round-trip a tiny file. ENOSPC / EROFS / EACCES surface here.
      const probePath = join(this.dir, `.probe-${process.pid}`);
      writeFileSync(probePath, "ok");
      unlinkSync(probePath);
      this.writable = true;
      return { writable: true, path: this.dir };
    } catch (err) {
      this.writable = false;
      return {
        writable: false,
        path: this.dir,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  isWritable(): boolean {
    return this.writable;
  }

  // ---- Read ----------------------------------------------------------------

  list(): MemoryListEntry[] {
    if (!this.writable || !existsSync(this.dir)) return [];
    try {
      const files = readdirSync(this.dir).filter((f) => f.endsWith(".md"));
      return files
        .map((f) => {
          const path = join(this.dir, f);
          const st = statSync(path);
          return {
            conversationId: f.slice(0, -3),
            modifiedAt: st.mtimeMs,
            sizeBytes: st.size,
            label: peekFirstUserMessage(path),
          };
        })
        .sort((a, b) => b.modifiedAt - a.modifiedAt);
    } catch {
      return [];
    }
  }

  /**
   * Hard-delete a conversation file. Used by the renderer when the
   * user picks "delete session" from the dropdown. Returns true when
   * a file existed and was unlinked.
   */
  delete(conversationId: string): boolean {
    if (!this.writable) return false;
    const path = this.fileFor(conversationId);
    if (!existsSync(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch (err) {
      console.warn("[memory] delete failed:", err);
      return false;
    }
  }

  /**
   * Reads a transcript back into AgentMessage[]. Returns empty array on
   * unknown id, parse failure, or non-writable state — the caller can
   * still proceed with an empty conversation.
   */
  load(conversationId: string): AgentMessage[] {
    const path = this.fileFor(conversationId);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf8");
      return parseTranscript(raw);
    } catch {
      return [];
    }
  }

  // ---- Write ---------------------------------------------------------------

  /**
   * Initialises the conversation file with frontmatter if it doesn't exist
   * yet. Idempotent — safe to call before every append.
   */
  ensureConversation(conversationId: string): void {
    if (!this.writable) return;
    const path = this.fileFor(conversationId);
    if (existsSync(path)) return;
    const frontmatter = [
      "---",
      `conversationId: ${conversationId}`,
      `createdAt: ${new Date().toISOString()}`,
      "---",
      "",
      "",
    ].join("\n");
    writeFileSync(path, frontmatter, { mode: 0o600 });
  }

  /**
   * Appends one message section. Best-effort: if the disk write fails
   * (e.g. user yanked the disk) we log and move on rather than crashing
   * the orchestrator — the in-memory conversation still works for the
   * remainder of the session.
   */
  append(conversationId: string, message: AgentMessage): void {
    if (!this.writable) return;
    try {
      this.ensureConversation(conversationId);
      const path = this.fileFor(conversationId);
      appendFileSync(path, formatMessage(message));
    } catch (err) {
      console.warn("[memory] append failed:", err);
    }
  }

  // ---- Internal ------------------------------------------------------------

  private fileFor(conversationId: string): string {
    // Conversation ids are UUIDs we generate in the renderer; sanitise
    // anyway to refuse path traversal if a future code path takes user
    // input here.
    const safe = conversationId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.md`);
  }
}

/**
 * Cheap label-extraction for the session dropdown. Reads the file,
 * scans for the first `## user · …` header, and returns the first
 * non-empty content line truncated to 60 chars. Returns "" on miss
 * (e.g. an empty conversation that's been initialised but never
 * sent). I/O cost is dominated by the directory scan in `list()`,
 * which already touched stat — adding a readFile per entry is fine
 * for typical session counts (< 100).
 */
function peekFirstUserMessage(path: string): string {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!line.startsWith("## user")) continue;
      // Skip the blank line after the header, then take the first
      // non-empty content line.
      for (let j = i + 1; j < lines.length; j++) {
        const candidate = (lines[j] ?? "").trim();
        if (!candidate) continue;
        // Stop at the next message header — no content in this msg.
        if (candidate.startsWith("## ")) break;
        return candidate.length > 60
          ? candidate.slice(0, 57) + "…"
          : candidate;
      }
      return "";
    }
    return "";
  } catch {
    return "";
  }
}

// ---- Format helpers --------------------------------------------------------

function formatMessage(m: AgentMessage): string {
  const iso = new Date(m.createdAt || Date.now()).toISOString();
  const lines: string[] = [];
  // Header line carries everything a parser needs to round-trip.
  if (m.role === "tool") {
    lines.push(
      `## tool · ${m.id} · ${iso}${m.toolCallId ? ` · ${m.toolCallId}` : ""}`,
    );
  } else {
    lines.push(`## ${m.role} · ${m.id} · ${iso}`);
  }
  lines.push("");
  lines.push(m.content || "");
  if (m.toolCalls && m.toolCalls.length > 0) {
    lines.push("");
    for (const tc of m.toolCalls) {
      lines.push(`\`\`\`toolcall ${tc.id}`);
      lines.push(`${tc.name}(${JSON.stringify(tc.args ?? {})})`);
      lines.push("```");
    }
  }
  lines.push("");
  lines.push("");
  return lines.join("\n");
}

interface ParsedHeader {
  role: AgentMessage["role"];
  id: string;
  createdAt: number;
  toolCallId?: string;
}

function parseHeader(line: string): ParsedHeader | null {
  // "## <role> · <id> · <iso>[ · <toolCallId>]"
  const m = line.match(/^##\s+(user|assistant|system|tool)\s+·\s+([^·]+?)\s+·\s+([^·]+?)(?:\s+·\s+(.+))?$/);
  if (!m) return null;
  const [, role, id, iso, toolCallId] = m;
  if (!role || !id || !iso) return null;
  const ts = Date.parse(iso.trim());
  return {
    role: role as AgentMessage["role"],
    id: id.trim(),
    createdAt: Number.isFinite(ts) ? ts : Date.now(),
    toolCallId: toolCallId?.trim(),
  };
}

/**
 * Parses a transcript into AgentMessage[]. Lenient: skips malformed
 * sections, swallows unknown fenced-block kinds, ignores frontmatter.
 */
function parseTranscript(raw: string): AgentMessage[] {
  const lines = raw.split(/\r?\n/);
  // Skip frontmatter block at the very top.
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    while (i < lines.length && lines[i]?.trim() !== "---") i++;
    if (i < lines.length) i++;
  }

  const out: AgentMessage[] = [];
  let cur: { header: ParsedHeader; content: string[]; calls: AgentMessage["toolCalls"] } | null =
    null;

  const flush = (): void => {
    if (!cur) return;
    const content = cur.content.join("\n").trim();
    out.push({
      id: cur.header.id,
      role: cur.header.role,
      content,
      createdAt: cur.header.createdAt,
      ...(cur.header.toolCallId ? { toolCallId: cur.header.toolCallId } : {}),
      ...(cur.calls && cur.calls.length > 0 ? { toolCalls: cur.calls } : {}),
    });
    cur = null;
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.startsWith("## ")) {
      flush();
      const header = parseHeader(line);
      if (header) cur = { header, content: [], calls: [] };
      i++;
      continue;
    }
    if (cur) {
      // Tool-call fenced block?
      const fenceMatch = line.match(/^```toolcall\s+(.+)$/);
      if (fenceMatch) {
        const callId = fenceMatch[1]!.trim();
        i++;
        const body: string[] = [];
        while (i < lines.length && lines[i] !== "```") {
          body.push(lines[i] ?? "");
          i++;
        }
        // skip closing ```
        if (i < lines.length) i++;
        const joined = body.join("\n");
        const m = joined.match(/^([^(]+)\((.*)\)$/s);
        if (m) {
          let args: unknown = {};
          try {
            args = JSON.parse(m[2] ?? "{}");
          } catch {
            args = m[2] ?? {};
          }
          cur.calls!.push({ id: callId, name: m[1]!.trim(), args });
        }
        continue;
      }
      cur.content.push(line);
    }
    i++;
  }
  flush();
  return out;
}
