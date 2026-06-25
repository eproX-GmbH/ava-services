import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import ReactMarkdown from "react-markdown";
// v0.1.206 — GitHub-Flavored-Markdown plugin so tables, task lists,
// strikethrough, and autolinks render as HTML elements instead of
// surviving as raw `|...|` / `[x]` text in the chat bubbles.
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";
import {
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  SearchCode,
  SquarePen,
  Trash2,
} from "lucide-react";
import { openChatSearch } from "../components/AppShell";
import { onChatSearchPick } from "../components/ChatSearchModal";
import { ChartBlock } from "../components/ChartBlock";
import { chartFenceState } from "../lib/chart-spec";
import { useOllamaStore } from "../store/ollama";
import { useVoiceStore } from "../store/voice";
import { useVoiceRecorder } from "../lib/recordVoice";
import {
  composePromptWithAttachments,
  formatBytes,
  isSupportedAttachment,
  parseAttachment,
  ScanPdfDetectedError,
  type SpreadsheetAttachment,
} from "../lib/attachment";
import { renderPdfPagesToImages } from "../lib/pdf-to-images";
import type {
  AgentChoiceOption,
  AgentMatchRow,
  AgentMessage,
  AgentStatus,
  AgentStreamFrame,
  ProviderConfigBundle,
} from "../../../shared/types";
import {
  SlashPalette,
  type SlashPaletteHandle,
} from "../components/chat/SlashPalette";

/** Same detection rule as in `ChatSession.tsx` — keep them in sync.
 *  Palette stays open while the user is still typing the command name
 *  (no whitespace or newline after the slash word). */
function detectSlashOpen(text: string): { open: boolean; query: string } {
  if (!text.startsWith("/")) return { open: false, query: "" };
  if (text.includes("\n")) return { open: false, query: "" };
  if (/^\/[^\s]*\s/.test(text)) return { open: false, query: "" };
  return { open: true, query: text.slice(1).toLowerCase() };
}

const LEADING_SLASH_RE = /^\/([a-z][a-z0-9-]*)(\s|$)/;

interface ConversationListEntry {
  conversationId: string;
  modifiedAt: number;
  sizeBytes: number;
  label: string;
}

// Chat (Phase 8.a + 8.c).
//
// 8.a: round-trip a turn end-to-end with no tools.
// 8.b: render tool-call / tool-result frames.
// 8.c: ChoiceCard for `ask_user_choice`, navigation, and a per-action
//      activity timeline. tool-call → "running" step that mutates in place
//      to "done"/"error" when its tool-result arrives. The `navigate` and
//      `notify` tools also surface as one-shot timeline steps.
//
// We render strictly in chronological order — every frame appends or
// updates a UI item, so the user reads top-down what the agent did.
// Conversation persistence and switching land in 8.d.

type Activity = {
  toolName: string;
  args: unknown;
  status: "running" | "done" | "error";
  preview?: string;
};

interface UiMessage {
  id: string;
  role: AgentMessage["role"];
  content: string;
  /** v0.1.257 — Bilder, die diese Message mitgeschickt hat (nur USER).
   *  Lokal-only — bei Conversation-Reload nicht persistiert. */
  images?: Array<{ base64: string; mimeType: string; filename?: string }>;
  pending?: boolean;
  /** Inline tool-action row. When set, the message is rendered as a
   *  timeline step instead of a chat bubble. */
  activity?: Activity;
  /** Inline ask_user_choice prompt. */
  choice?: {
    choiceId: string;
    prompt: string;
    options: AgentChoiceOption[];
    answeredValue?: string;
  };
  /** Inline ask_user_text prompt — free-form input chip. Same answer
   *  channel as `choice` (resolves via `agent.answerChoice`); the union
   *  is by message kind, not by IPC method. */
  textPrompt?: {
    choiceId: string;
    prompt: string;
    placeholder?: string;
    defaultValue?: string;
    optional?: boolean;
    answeredValue?: string;
  };
  /** v0.1.392 — Batch-Zuordnung nicht eindeutiger Import-Firmen. Eine Karte
   *  mit allen Zweifelsfällen; antwortet über denselben answerChoice-Kanal
   *  mit einer JSON-Map `{ rowId: companyId | "skip" }`. */
  matchPrompt?: {
    choiceId: string;
    prompt: string;
    rows: AgentMatchRow[];
    answeredValue?: string;
  };
}

function newConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Compact one-line summary of tool args, capped to keep the timeline tidy.
 *  Used as the toggle's collapsed label — NOT the expanded view (see
 *  `formatArgsFull` for that, which returns the full pretty-printed JSON). */
function summarizeArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  try {
    const json = JSON.stringify(args);
    if (json.length <= 80) return json;
    return json.slice(0, 77) + "…";
  } catch {
    return "";
  }
}

/** v0.1.251 — Full pretty-printed JSON of tool args for the expanded
 *  view. Vorher zeigte das ausgeklappte „Argumente" denselben 80-Zeichen-
 *  Truncate wie der collapsed-State — damit konnte man bei Bug-Reports
 *  nicht sehen, was der Agent wirklich geschickt hat. */
/** v0.1.257 — File → base64 (ohne `data:` Prefix), für Bild-Anhänge. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader lieferte keinen String."));
        return;
      }
      // result ist `data:image/png;base64,XXXX` — wir wollen nur den base64-Teil
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

function formatArgsFull(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args !== "object") return String(args);
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return "";
  }
}

export function Chat() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [providerBundle, setProviderBundle] =
    useState<ProviderConfigBundle | null>(null);
  const ollamaInstalled = useOllamaStore((s) => s.status.installed);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  // 8.k10i — attached spreadsheets pending the next Send. Cleared on
  // submit (the metadata is folded into the outgoing user message).
  const [attachments, setAttachments] = useState<SpreadsheetAttachment[]>([]);
  // v0.1.257 — Bild-Anhänge an den nächsten user-turn. Werden im Chat als
  // Vorschau-Chip angezeigt, beim Send als `images: AgentMessageImage[]`
  // an `agent.send` mitgegeben. Nur sinnvoll wenn `status.supportsImages`
  // true ist; der Renderer warnt, falls das Modell keine Bilder kann.
  const [pendingImages, setPendingImages] = useState<
    Array<{ id: string; base64: string; mimeType: string; filename: string }>
  >([]);
  const [dragOver, setDragOver] = useState(false);
  // Counter rather than boolean: child elements fire dragenter/dragleave
  // as the cursor crosses each, so a single state would flicker. We
  // increment on enter, decrement on leave, and the overlay is shown
  // when the count is > 0.
  const dragDepthRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Slash-command palette state. `dismissed` lets Escape close the
  // palette without forcing the user to delete the slash they typed.
  const slashPaletteRef = useRef<SlashPaletteHandle | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashDetect = useMemo(() => detectSlashOpen(input), [input]);
  const slashOpen = slashDetect.open && !slashDismissed;
  // 8.k10h — sessions list + active id. The id is state (not just a
  // ref) because the dropdown reads it as the selected option. Ref
  // mirror is kept in sync so async stream handlers can observe the
  // latest value without re-subscribing on every switch.
  const [conversations, setConversations] = useState<ConversationListEntry[]>(
    [],
  );
  const [conversationId, setConversationId] = useState<string>("");
  const conversationIdRef = useRef<string>("");
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
  const activeRequestIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  // Sidebar collapse state — persists in localStorage. Default expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("ava.chatSidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(
        "ava.chatSidebar.collapsed",
        sidebarCollapsed ? "1" : "0",
      );
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  // v0.1.85 — pending search-pick scroll target. The ChatSearchModal
  // (mounted in AppShell) dispatches `ava:chat-search-pick`; we capture
  // the payload, switch conversations if needed, and let an effect
  // below scroll to the matched message once it has rendered.
  const [pendingPick, setPendingPick] = useState<{
    conversationId: string;
    messageId: string;
    /** Bumped per pick so consecutive picks of the same hit re-fire. */
    nonce: number;
  } | null>(null);
  // Cmd/Ctrl+Shift+S toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Refresh the sessions list. Called on mount, after sending a turn
  // (so the latest conversation's mtime bubbles to the top), and after
  // delete. Cheap — main scans userData/agent/memory and stat()s.
  const refreshConversations = useCallback(async () => {
    try {
      const list = await window.api.agent.listConversations();
      setConversations(list);
      return list;
    } catch {
      return [] as ConversationListEntry[];
    }
  }, []);

  // Project an AgentMessage[] transcript onto the UI's per-row shape.
  // - user messages → bubbles
  // - assistant messages with content → bubbles (no pending flag)
  // - assistant tool_calls → activity rows; the matching `tool` message
  //   that follows is folded in as the row's preview (we no longer have
  //   the tool's preview() function at replay time, so we trim the raw
  //   JSON content as a best-effort summary).
  // - choice/navigate frames don't survive replay — they were transient
  //   side-effects, not transcript content.
  const replayConversation = useCallback((history: AgentMessage[]): UiMessage[] => {
    const out: UiMessage[] = [];
    // Map toolCallId → activity row index so a later `tool` message can
    // back-fill the preview without scanning the whole list.
    const activityIdx = new Map<string, number>();
    for (const m of history) {
      if (m.role === "user") {
        out.push({ id: m.id, role: "user", content: m.content });
        continue;
      }
      if (m.role === "assistant") {
        // If the assistant emitted any text content, render it as a bubble.
        if (m.content && m.content.trim().length > 0) {
          out.push({ id: m.id, role: "assistant", content: m.content });
        }
        for (const tc of m.toolCalls ?? []) {
          // ask_user_choice was a transient prompt — skip on replay.
          if (tc.name === "ask_user_choice") continue;
          const rowId = `act-${tc.id}`;
          out.push({
            id: rowId,
            role: "tool",
            content: "",
            activity: {
              toolName: tc.name,
              args: tc.args,
              status: "done",
            },
          });
          activityIdx.set(tc.id, out.length - 1);
        }
        continue;
      }
      if (m.role === "tool" && m.toolCallId) {
        const idx = activityIdx.get(m.toolCallId);
        if (idx !== undefined) {
          // Best-effort preview from the stored JSON content.
          const text = (m.content ?? "").trim();
          const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;
          // v0.1.229 — Status aus dem Tool-Result rekonstruieren.
          // `runTool` im Orchestrator schreibt bei Erfolg `JSON.stringify(result)`
          // und bei Fehler `JSON.stringify({error: "..."})`. Wenn wir
          // einen `error`-Top-Level-Key sehen, war's ein Fehler — sonst
          // success.
          //
          // Ohne diesen Check waren ursprünglich fehlgeschlagene Tool-
          // Calls beim Reload als grüne Häkchen markiert, was den
          // Verlauf in der UI verfälschte.
          const cur = out[idx]!;
          if (cur.activity) {
            const isError = looksLikeToolError(text);
            out[idx] = {
              ...cur,
              activity: {
                ...cur.activity,
                preview: preview || undefined,
                status: isError ? "error" : "done",
              },
            };
          }
        }
        continue;
      }
      // system messages don't render.
    }
    return out;
  }, []);

  // Switch to a specific conversation: load its transcript from disk,
  // replay into UiMessages, and — v0.1.151 — adopt any in-flight turn
  // and re-paint any still-open prompt cards.
  //
  // We deliberately DO NOT abort the in-flight turn on switch any more.
  // Earlier behavior aborted on every switch, but that conflated two
  // very different cases:
  //   - "user switched conversations" → they probably want the OTHER
  //     conversation to keep running and to see its prompts when they
  //     come back.
  //   - "user explicitly cancelled" → use the Stop button.
  // The renderer now scopes all UI state to the displayed conversation
  // (frame filter via conversationIdRef, inFlight derived from
  // status.inFlightConversationId === current), so leaving the other
  // turn alone is the right call.
  const switchConversation = useCallback(
    async (id: string) => {
      setError(null);
      setThinking(false);
      setConversationId(id);
      conversationIdRef.current = id;
      try {
        const [history, pending, status] = await Promise.all([
          window.api.agent.loadConversation(id),
          window.api.agent.getPendingPrompts(id),
          window.api.agent.getStatus(),
        ]);
        const replayed = replayConversation(history);
        // Inject any still-open prompts as UiMessage rows so the user
        // sees the agent's outstanding question instead of silence.
        for (const p of pending) {
          if (p.kind === "choice-request") {
            replayed.push({
              id: `ch-${p.choiceId}`,
              role: "tool",
              content: "",
              choice: {
                choiceId: p.choiceId,
                prompt: p.prompt,
                options: p.options,
              },
            });
          } else if (p.kind === "match-request") {
            replayed.push({
              id: `mt-${p.choiceId}`,
              role: "tool",
              content: "",
              matchPrompt: {
                choiceId: p.choiceId,
                prompt: p.prompt,
                rows: p.rows,
              },
            });
          } else {
            replayed.push({
              id: `tx-${p.choiceId}`,
              role: "tool",
              content: "",
              textPrompt: {
                choiceId: p.choiceId,
                prompt: p.prompt,
                ...(p.placeholder !== undefined
                  ? { placeholder: p.placeholder }
                  : {}),
                ...(p.defaultValue !== undefined
                  ? { defaultValue: p.defaultValue }
                  : {}),
                ...(p.optional ? { optional: true } : {}),
              },
            });
          }
        }
        setMessages(replayed);
        // Adopt the in-flight turn if it's for THIS conversation. The
        // stream-frame filter (further down) checks activeRequestIdRef
        // before accepting frames; without this adoption step, a turn
        // that started in another mount drops every frame on the floor.
        if (
          status.inFlightRequestId &&
          status.inFlightConversationId === id
        ) {
          activeRequestIdRef.current = status.inFlightRequestId;
          // The agent is busy but hasn't streamed a visible delta yet —
          // surface the "thinking" indicator so the chat doesn't look
          // frozen between the user's last message and the next frame.
          setThinking(true);
        } else {
          activeRequestIdRef.current = null;
        }
      } catch {
        setMessages([]);
        activeRequestIdRef.current = null;
      }
    },
    [replayConversation],
  );

  // Start a brand-new conversation. We don't persist it until the
  // first user message lands (the orchestrator's appendMessage path
  // does that), so the dropdown only shows it after the first send.
  const startNewConversation = useCallback(() => {
    // v0.1.151 — abort whatever's running so the orchestrator's
    // single-slot doesn't reject the first send into the new
    // conversation. Use the ref OR the status — adopted turns may
    // not have populated the ref yet.
    if (activeRequestIdRef.current) {
      void window.api.agent.abort(activeRequestIdRef.current);
      activeRequestIdRef.current = null;
    }
    const id = newConversationId();
    setConversationId(id);
    conversationIdRef.current = id;
    setMessages([]);
    setError(null);
    setThinking(false);
  }, []);

  // v0.1.282 — Wenn die Chat-Route mit einem `prefill`-State aufgerufen
  // wird (z. B. von Triage-Inbox "Im Chat öffnen"), starten wir IMMER
  // eine neue Conversation und packen den Text in den Composer. Damit
  // landet die Mail nicht in einem ggf. laufenden Chat-Verlauf, wo der
  // Kontext untergeht. Mehrzeilige Texte werden 1:1 übernommen.
  const location = useLocation();
  const prefillFromLocationStateRef = useRef(false);
  useEffect(() => {
    const state = location.state as { prefill?: string } | null;
    const prefill = typeof state?.prefill === "string" ? state.prefill : null;
    if (!prefill || prefillFromLocationStateRef.current) return;
    prefillFromLocationStateRef.current = true;
    startNewConversation();
    setInput(prefill);
    // Konsumiert — bei React-Router-Navigation zur selben Route mit
    // anderem state würden wir sonst doppelt prefillen.
    window.history.replaceState({}, "");
    // Fokus aufs Textfeld setzen, der User soll direkt tippen können.
    setTimeout(() => composerTextareaRef.current?.focus(), 50);
  }, [location.state, startNewConversation]);

  // Mount: list sessions, auto-load the most recent. If there are no
  // saved sessions, mint a fresh id so the textarea is immediately usable.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      // v0.1.282 — Wenn wir mit prefill kommen, NICHT die letzte
      // Conversation laden. startNewConversation hat die Routing
      // schon übernommen, sonst würden wir den Composer-Inhalt
      // direkt überschreiben.
      const state = location.state as { prefill?: string } | null;
      if (typeof state?.prefill === "string") return;
      const list = await refreshConversations();
      if (!mounted) return;
      if (list.length > 0) {
        await switchConversation(list[0]!.conversationId);
      } else {
        const id = newConversationId();
        setConversationId(id);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [refreshConversations, switchConversation]);

  // v0.1.85 — react to chat-search picks. Switch conversation if the
  // hit is in a different one; the scroll-to-message effect below
  // fires once the new transcript has rendered.
  useEffect(() => {
    let nonce = 0;
    const off = onChatSearchPick((payload) => {
      nonce++;
      setPendingPick({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        nonce,
      });
      if (payload.conversationId !== conversationIdRef.current) {
        void switchConversation(payload.conversationId);
      }
    });
    return off;
  }, [switchConversation]);

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (
        !window.confirm(
          "Diese Konversation löschen? Die Transkript-Datei wird von der Festplatte entfernt.",
        )
      ) {
        return;
      }
      try {
        await window.api.agent.deleteConversation(id);
      } catch {
        /* fall through to refresh anyway */
      }
      const list = await refreshConversations();
      // If we just deleted the active session, jump to the next-latest
      // or open a fresh one.
      if (id === conversationIdRef.current) {
        if (list.length > 0) {
          await switchConversation(list[0]!.conversationId);
        } else {
          startNewConversation();
        }
      }
    },
    [refreshConversations, startNewConversation, switchConversation],
  );

  // Initial status + subscribe to pushes.
  useEffect(() => {
    let mounted = true;
    void window.api.agent.getStatus().then((s) => {
      if (mounted) setStatus(s);
    });
    const unsub = window.api.agent.onStatusChanged((s) => {
      if (mounted) setStatus(s);
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, []);

  // Provider bundle — lets us tell the user *why* the chat is unusable
  // (no local LLM AND no API key) and link them to the right surface.
  // We refetch on agent-status changes so flipping provider in Whoami,
  // pulling a model in the dock, or pasting a key all settle the
  // empty-state copy without a route remount.
  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void window.api.agent
        .getProviderConfig()
        .then((b) => {
          if (mounted) setProviderBundle(b);
        })
        .catch(() => undefined);
    };
    refresh();
    const offAgent = window.api.agent.onStatusChanged(refresh);
    return () => {
      mounted = false;
      offAgent();
    };
  }, []);

  // Stream frames. We filter by requestId so a stale subscription from a
  // previous send can never poison the current turn.
  useEffect(() => {
    const unsub = window.api.agent.onStream((frame: AgentStreamFrame) => {
      // v0.1.151 — accept frames if EITHER (a) the activeRequestIdRef
      // matches (the locally-initiated turn) OR (b) the frame is
      // addressed to the conversation currently on screen (an adopted
      // turn that started in a different mount). Without (b) the
      // adoption path would still drop every delta because the ref
      // hadn't been updated yet at the moment the frame fired.
      const matchesActive =
        activeRequestIdRef.current !== null &&
        frame.requestId === activeRequestIdRef.current;
      const matchesConversation =
        "conversationId" in frame &&
        frame.conversationId === conversationIdRef.current;
      if (!matchesActive && !matchesConversation) return;
      // Late-binding: if we accepted via (b) and the ref is empty,
      // remember the requestId so the Stop button has something to
      // abort with and subsequent frames take the fast path through (a).
      if (matchesConversation && activeRequestIdRef.current === null) {
        activeRequestIdRef.current = frame.requestId;
      }

      // The "thinking…" indicator is shown whenever the agent is busy but
      // not producing visible output. We clear it on `token` (the agent
      // is now streaming a reply) and on `tool-call` (the activity row
      // takes its place). After a `tool-result` we set it again because
      // the agent is now composing the next step but has nothing visible
      // on screen — without this the chat looks frozen between a tool
      // finishing and the final reply starting to stream.
      if (frame.kind === "token" || frame.kind === "tool-call") {
        setThinking(false);
      } else if (frame.kind === "tool-result") {
        setThinking(true);
      }

      if (frame.kind === "token") {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === frame.messageId);
          if (idx >= 0) {
            const next = prev.slice();
            const cur = next[idx]!;
            next[idx] = { ...cur, content: cur.content + frame.delta };
            return next;
          }
          return [
            ...prev,
            {
              id: frame.messageId,
              role: "assistant",
              content: frame.delta,
              pending: true,
            },
          ];
        });
      } else if (frame.kind === "done") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === frame.messageId ? { ...m, pending: false } : m,
          ),
        );
        // Clear the spinner. Critical on abort + tool-only turns
        // (no `token` frame ever arrives, so without this the
        // "denkt nach…" indicator stays forever).
        setThinking(false);
        activeRequestIdRef.current = null;
        // Refresh the list so the just-completed turn updates its
        // mtime (sort order) and label (in case it was the very first
        // user message of a new conversation).
        void refreshConversations();
      } else if (frame.kind === "error") {
        setError(frame.message);
        setThinking(false);
        setMessages((prev) =>
          prev.map((m) => (m.pending ? { ...m, pending: false } : m)),
        );
        // Mark any still-running activity rows as errored so the timeline
        // doesn't leave dangling spinners on a failed turn.
        setMessages((prev) =>
          prev.map((m) =>
            m.activity?.status === "running"
              ? { ...m, activity: { ...m.activity, status: "error" } }
              : m,
          ),
        );
        activeRequestIdRef.current = null;
      } else if (frame.kind === "tool-call") {
        // ask_user_choice gets a dedicated card via choice-request, no
        // activity row.
        if (frame.toolCall.name === "ask_user_choice") return;
        setMessages((prev) => [
          ...prev,
          {
            id: `act-${frame.toolCall.id}`,
            role: "tool",
            content: "",
            activity: {
              toolName: frame.toolCall.name,
              args: frame.toolCall.args,
              status: "running",
            },
          },
        ]);
      } else if (frame.kind === "tool-result") {
        // Mutate the matching running step in place — keeps the timeline
        // chronological without producing a separate "result" row.
        setMessages((prev) => {
          const id = `act-${frame.toolCallId}`;
          const idx = prev.findIndex((m) => m.id === id);
          if (idx < 0) {
            // Lost the call frame somehow; append a synthetic done row.
            return [
              ...prev,
              {
                id,
                role: "tool",
                content: "",
                activity: {
                  toolName: "(tool)",
                  args: undefined,
                  status: frame.ok ? "done" : "error",
                  preview: frame.preview,
                },
              },
            ];
          }
          const next = prev.slice();
          const cur = next[idx]!;
          next[idx] = {
            ...cur,
            activity: {
              ...cur.activity!,
              status: frame.ok ? "done" : "error",
              preview: frame.preview,
            },
          };
          return next;
        });
      } else if (frame.kind === "choice-request") {
        setMessages((prev) => [
          ...prev,
          {
            id: `ch-${frame.choiceId}`,
            role: "tool",
            content: "",
            choice: {
              choiceId: frame.choiceId,
              prompt: frame.prompt,
              options: frame.options,
            },
          },
        ]);
      } else if (frame.kind === "match-request") {
        setMessages((prev) => [
          ...prev,
          {
            id: `mt-${frame.choiceId}`,
            role: "tool",
            content: "",
            matchPrompt: {
              choiceId: frame.choiceId,
              prompt: frame.prompt,
              rows: frame.rows,
            },
          },
        ]);
      } else if (frame.kind === "choice-resolved") {
        setMessages((prev) =>
          prev.map((m) => {
            if (m.choice?.choiceId === frame.choiceId) {
              return { ...m, choice: { ...m.choice, answeredValue: frame.value } };
            }
            if (m.textPrompt?.choiceId === frame.choiceId) {
              return {
                ...m,
                textPrompt: { ...m.textPrompt, answeredValue: frame.value },
              };
            }
            if (m.matchPrompt?.choiceId === frame.choiceId) {
              return {
                ...m,
                matchPrompt: { ...m.matchPrompt, answeredValue: frame.value },
              };
            }
            return m;
          }),
        );
      } else if (frame.kind === "text-request") {
        setMessages((prev) => [
          ...prev,
          {
            id: `tx-${frame.choiceId}`,
            role: "tool",
            content: "",
            textPrompt: {
              choiceId: frame.choiceId,
              prompt: frame.prompt,
              placeholder: frame.placeholder,
              defaultValue: frame.defaultValue,
              optional: frame.optional,
            },
          },
        ]);
      } else if (frame.kind === "navigate") {
        navigate(frame.path);
      }
    });
    return unsub;
  }, [navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  // v0.1.85 — search-pick scroll + temporary highlight. Fires once the
  // pending pick's conversation has finished loading (messages array
  // contains the matched message id). The highlight class is removed
  // after 2.5s so the bubble settles back to the standard treatment.
  useEffect(() => {
    if (!pendingPick) return;
    if (pendingPick.conversationId !== conversationId) return;
    const target = messages.find((m) => m.id === pendingPick.messageId);
    if (!target) return;
    const el = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${cssEscape(pendingPick.messageId)}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("chat-msg--highlight");
    const handle = window.setTimeout(() => {
      el.classList.remove("chat-msg--highlight");
    }, 2500);
    setPendingPick(null);
    return () => window.clearTimeout(handle);
  }, [pendingPick, conversationId, messages]);

  // Composer textarea auto-grow (1 row → up to 5).
  //
  // Pattern: reset to `auto` (so shrink-to-fit works after a delete),
  // then read scrollHeight and clamp to 5 rows of computed line-height
  // plus the textarea's vertical padding. We do this in a layout effect
  // so the new height paints in the same frame as the value change —
  // a plain `useEffect` flashes a single-row composer for one frame
  // when pasting multi-line text.
  //
  // Past the cap, the textarea overflows internally with its own
  // scrollbar (overflow-y is set via inline style here, not CSS, so we
  // can flip it on/off as the cap is hit/released).
  useLayoutEffect(() => {
    const el = composerTextareaRef.current;
    if (!el) return;
    const styles = window.getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight);
    // Some font stacks return "normal" for line-height; fall back to
    // 1.4 × fontSize, which matches our CSS default for the composer.
    const lh =
      Number.isFinite(lineHeight) && lineHeight > 0
        ? lineHeight
        : parseFloat(styles.fontSize) * 1.4;
    const padding =
      parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const maxRows = 5;
    const maxHeight = lh * maxRows + padding;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [input]);

  // v0.1.151 — inFlight is conversation-scoped. Without the conversation
  // check, the Stop button stayed lit while the user was viewing
  // conversation B even though it was conversation A that was busy.
  // We also no longer OR with `activeRequestIdRef.current` directly:
  // the ref is mirrored from `status.inFlightRequestId` on adoption,
  // so the status check alone is authoritative. If no in-flight turn
  // belongs to THIS conversation, the button reads as Send — which is
  // exactly the "no recoverable state → show send not stop" property
  // the user asked for.
  const inFlight =
    !!status?.inFlightRequestId &&
    status?.inFlightConversationId === conversationId;
  const canSend = useMemo(
    () =>
      !!status?.ready &&
      !inFlight &&
      (input.trim().length > 0 || attachments.length > 0),
    [status?.ready, input, inFlight, attachments.length],
  );

  // "Truly unusable" empty state — no local LLM on disk AND no hosted
  // key. Distinct from the transient "Ollama is starting" state, which
  // resolves on its own. We render a guided panel pointing at the two
  // ways out (download a local model, or add an API key in Whoami)
  // instead of leaving the user staring at a disabled textarea.
  const hasAnyKey = providerBundle
    ? (["openai", "anthropic", "google", "mistral"] as const).some(
        (k) => providerBundle.hasKey[k],
      )
    : false;
  const hasAnyLocalLlm = ollamaInstalled.some((m) =>
    /^(qwen|gemma|llama|mistral|phi|deepseek|granite|command-r)/i.test(
      m.name.split("/").pop() ?? "",
    ),
  );
  const noUsableProvider =
    providerBundle !== null &&
    !status?.ready &&
    !hasAnyKey &&
    !hasAnyLocalLlm;

  // Parse a batch of dropped/picked files. Skip silently-unsupported
  // ones with a single error message — accidental drag of a PDF on the
  // chat shouldn't blow up the whole drop.
  const ingestFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    // v0.1.257 — Bilder separat behandeln (gehen in pendingImages, nicht
    // in attachments). Vision-Gate liegt am Modell, nicht am Drop —
    // wir zeigen die Bilder im Composer + warnen UI-seitig, falls
    // !supportsImages. Das gibt dem User die Chance, das Modell vorher
    // zu wechseln, ohne dass der Drop verloren geht.
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const nonImage = files.filter((f) => !f.type.startsWith("image/"));
    if (imageFiles.length > 0) {
      const next: typeof pendingImages = [];
      for (const f of imageFiles) {
        if (f.size > 5 * 1024 * 1024) {
          setError(
            `Bild "${f.name}" ist größer als 5 MB — Provider lehnen das oft ab. Bitte zuerst skalieren.`,
          );
          continue;
        }
        const base64 = await fileToBase64(f);
        next.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          base64,
          mimeType: f.type || "image/png",
          filename: f.name,
        });
      }
      if (next.length > 0) {
        setPendingImages((prev) => [...prev, ...next]);
      }
    }
    if (nonImage.length === 0) return;
    const accepted = nonImage.filter(isSupportedAttachment);
    const rejected = nonImage.length - accepted.length;
    if (rejected > 0 && accepted.length === 0 && imageFiles.length === 0) {
      setError(
        `Nicht unterstützter Dateityp. Bitte .xlsx-, .xls-, .csv-, .tsv-, .pdf-Dateien oder Bilder (PNG/JPEG) ablegen.`,
      );
      return;
    }
    if (rejected > 0) {
      setError(
        `${rejected} nicht unterstützte ${rejected === 1 ? "Datei" : "Dateien"} übersprungen.`,
      );
    } else if (imageFiles.length === 0) {
      setError(null);
    }
    const parsed: SpreadsheetAttachment[] = [];
    for (const f of accepted) {
      try {
        parsed.push(await parseAttachment(f));
      } catch (err) {
        // v0.1.302 — Scan-PDF erkannt → User fragen wie viele Seiten
        // als Bilder gerendert + ans Vision-LLM geschickt werden sollen.
        // Wir machen das hier inline (nicht via Modal-Refactor),
        // weil die Frage nur in diesem Pfad relevant ist.
        if (err instanceof ScanPdfDetectedError) {
          setScanPdfPending({
            filename: err.filename,
            bytes: err.bytes,
            numPages: err.numPages,
          });
          continue;
        }
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (parsed.length > 0) {
      setAttachments((prev) => [...prev, ...parsed]);
    }
  }, []);

  // v0.1.302 — State + Handler für das Scan-PDF-Modal. Trigger:
  // parsePdfAttachment hat ScanPdfDetectedError geworfen. User sieht
  // eine kleine Karte und wählt 5/10/20/Alle oder Abbrechen.
  const [scanPdfPending, setScanPdfPending] = useState<{
    filename: string;
    bytes: Uint8Array;
    numPages: number;
  } | null>(null);
  const [scanPdfBusy, setScanPdfBusy] = useState(false);

  const handleScanPdfChoice = useCallback(
    async (cap: number | "cancel") => {
      if (!scanPdfPending) return;
      if (cap === "cancel") {
        setScanPdfPending(null);
        return;
      }
      setScanPdfBusy(true);
      try {
        const pages = await renderPdfPagesToImages(
          scanPdfPending.bytes,
          scanPdfPending.filename,
          { maxPages: cap },
        );
        if (pages.length === 0) {
          setError(
            `PDF "${scanPdfPending.filename}" konnte nicht gerendert werden — möglicherweise verschlüsselt oder beschädigt.`,
          );
        } else {
          setPendingImages((prev) => [
            ...prev,
            ...pages.map((p) => ({
              id: `pdfpage-${Date.now()}-${p.pageNumber}-${Math.random().toString(36).slice(2, 6)}`,
              base64: p.base64,
              mimeType: p.mimeType,
              filename: p.filename,
            })),
          ]);
        }
      } catch (err) {
        setError(
          `PDF-Render fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setScanPdfBusy(false);
        setScanPdfPending(null);
      }
    },
    [scanPdfPending],
  );

  const removePendingImage = useCallback((id: string) => {
    setPendingImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  // v0.1.257 — Paste-Handler für die Composer-Textarea. Greift Bilder
  // aus der Zwischenablage (Cmd+V nach Screenshot), routet sie durch
  // ingestFiles. Andere Paste-Aktionen (Text) bleiben unberührt.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItems = items.filter((it) => it.type.startsWith("image/"));
      if (imageItems.length === 0) return; // Default-Paste (Text) durchlassen
      e.preventDefault();
      const files: File[] = [];
      for (const it of imageItems) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
      if (files.length > 0) void ingestFiles(files);
    },
    [ingestFiles],
  );

  const handleFileInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      // Allow re-picking the same file by clearing the input value.
      e.target.value = "";
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    // v0.1.324 — Symmetrie zu handleDragEnter: NUR decrementen wenn
    // "Files" im dataTransfer-Types. Vorher fiel der Counter ins
    // Negative (Math.max clampte auf 0) wenn nicht-File-Drags am
    // Element vorbeizogen. Auf Windows besonders aufgefallen.
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }, []);

  // v0.1.324 — Defensive Reset für Drag-State. Real-Run-Reports
  // "Chat hängt sich auf, Input nicht klickbar, Scroll geht nicht"
  // sehen aus wie ein stuck Overlay. Reset auf:
  //   - Window-Blur (User hat Fenster verlassen; OS-Dialog kam dazwischen;
  //     drag-cancel fires nicht zuverlässig auf Windows)
  //   - ESC-Taste (universeller Escape-Hatch für alles was hängt)
  //   - Mouse-Leave aus dem Window
  useEffect(() => {
    const reset = (): void => {
      if (dragDepthRef.current !== 0 || dragOver) {
        dragDepthRef.current = 0;
        setDragOver(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") reset();
    };
    window.addEventListener("blur", reset);
    window.addEventListener("mouseleave", reset);
    window.addEventListener("keydown", onKey);
    document.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("blur", reset);
      window.removeEventListener("mouseleave", reset);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("dragend", reset);
    };
  }, [dragOver]);

  // v0.1.324 — Watchdog: clear stuck `thinking` Indicator nach 90s
  // ohne Frames. Real-Run zeigt: wenn ein Stream serverseitig hängt
  // und nie `done`/`error` schickt, bleibt der Indicator. Stört keine
  // korrekten Flows weil ein gesunder Turn IMMER innerhalb 90s ein
  // Frame liefert (Anthropic/Ollama Streaming).
  useEffect(() => {
    if (!thinking) return;
    const t = setTimeout(() => {
      console.warn("[chat] thinking watchdog fired — clearing stuck indicator");
      setThinking(false);
    }, 90_000);
    return () => clearTimeout(t);
  }, [thinking]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragOver(false);
      const files = e.dataTransfer.files
        ? Array.from(e.dataTransfer.files)
        : [];
      void ingestFiles(files);
    },
    [ingestFiles],
  );

  const setAttachmentName = useCallback((id: string, name: string) => {
    setAttachments((prev) =>
      prev.map((a) => (a.id === id ? { ...a, transactionName: name } : a)),
    );
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      // If we already shipped bytes to main (an earlier staging round
      // that we're now abandoning), tell main to free them. Best-effort
      // — a stale entry just lives out its TTL.
      if (target?.stagedId) {
        void window.api.agent.discardAttachment(target.stagedId).catch(() => {});
      }
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  async function handleSend() {
    if (!canSend) return;
    const id = conversationIdRef.current;
    if (!id) return; // mount hasn't completed yet — refuse rather than create a stray.
    const typed = input.trim();
    // Stage attachments in main *before* composing the prompt — main
    // returns a stable id we weave into the `[attachment: …, id: …]`
    // header so the agent can hand it to `import_excel`. We do this
    // up-front (rather than inside the try/catch around send) so a
    // staging failure surfaces with the unsent typed text + chips
    // intact — same UX as a network failure on send.
    let stagedAttachments: SpreadsheetAttachment[];
    try {
      stagedAttachments = await Promise.all(
        attachments.map(async (att) => {
          if (att.stagedId) return att; // idempotent — retry path.
          const { id: stagedId } = await window.api.agent.stageAttachment({
            filename: att.filename,
            bytes: att.bytes,
            sheets: att.sheets.map((s) => ({
              name: s.name,
              headers: s.headers,
              totalRows: s.totalRows,
            })),
          });
          return { ...att, stagedId };
        }),
      );
    } catch (err) {
      setError(
        `Anhang konnte nicht vorbereitet werden: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    // Compose: every attachment's metadata block (now including the
    // staged id) + the typed text. The agent receives a single user
    // message; the disk transcript stores the same composed string so
    // a session reload still has the attachment metadata. The id will
    // be stale on reload — that's fine, the bytes were only useful
    // for the in-flight import.
    const composed = composePromptWithAttachments(typed, stagedAttachments);
    // What the user *sees* in the chat is just their typed text plus
    // a small "📎 N file(s)" tag — the metadata block stays in the
    // wire payload and the disk transcript, but the bubble doesn't
    // need to re-render the headers + samples.
    const visible = stagedAttachments.length > 0
      ? `${typed}${typed ? "\n\n" : ""}📎 ${stagedAttachments
          .map((a) => {
            const name = (a.transactionName ?? "").trim();
            return name ? `${a.filename} · "${name}"` : a.filename;
          })
          .join(", ")}`
      : typed;
    setInput("");
    const sentAttachments = stagedAttachments;
    const sentImages = pendingImages;
    setAttachments([]);
    setPendingImages([]);
    setError(null);
    const userId = `u-${Date.now().toString(36)}`;
    setMessages((prev) => [
      ...prev,
      {
        id: userId,
        role: "user",
        content: visible,
        // v0.1.257 — Bilder werden lokal im UI-Bubble eingebettet, damit
        // der User SOFORT sieht was gesendet wurde, ohne dass main den
        // Echo zurückspielt.
        images:
          sentImages.length > 0
            ? sentImages.map((img) => ({
                base64: img.base64,
                mimeType: img.mimeType,
                filename: img.filename,
              }))
            : undefined,
      },
    ]);
    setThinking(true);
    try {
      const { requestId } = await window.api.agent.send({
        conversationId: id,
        message: composed,
        ...(sentImages.length > 0
          ? {
              images: sentImages.map((img) => ({
                base64: img.base64,
                mimeType: img.mimeType,
                filename: img.filename,
              })),
            }
          : {}),
      });
      activeRequestIdRef.current = requestId;
      // Surface the (possibly newly-created) conversation in the
      // dropdown — the file is materialised by the orchestrator's
      // first appendMessage. Re-list runs in the background; UI doesn't
      // wait for it before continuing the stream.
      void refreshConversations();
    } catch (err) {
      setThinking(false);
      // Restore the attachments so the user can retry without re-dropping.
      setAttachments(sentAttachments);
      setPendingImages(sentImages);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAbort() {
    // Optimistic UI: stop the spinner immediately so the abort feels
    // instant, even before the backend's terminal `done`/`error`
    // frame lands. The frame still resets activeRequestIdRef and
    // marks any pending message as not-pending.
    setThinking(false);
    // v0.1.151 — fall back to the status's inFlightRequestId when the
    // local ref is empty (we may not have adopted yet — e.g. the user
    // hit Stop before the first frame landed). The orchestrator
    // accepts undefined too and aborts whatever's running.
    const id =
      activeRequestIdRef.current ?? status?.inFlightRequestId ?? undefined;
    void window.api.agent.abort(id);
  }

  function handlePickChoice(choiceId: string, value: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.choice?.choiceId === choiceId
          ? { ...m, choice: { ...m.choice, answeredValue: value } }
          : m,
      ),
    );
    void window.api.agent.answerChoice({ choiceId, value });
  }

  function handleSubmitText(choiceId: string, value: string) {
    setMessages((prev) =>
      prev.map((m) =>
        m.textPrompt?.choiceId === choiceId
          ? { ...m, textPrompt: { ...m.textPrompt, answeredValue: value } }
          : m,
      ),
    );
    // Same IPC channel as `answerChoice` — main routes to the same
    // `pending` map keyed by choiceId.
    void window.api.agent.answerChoice({ choiceId, value });
  }

  // v0.1.392 — Batch-Zuordnung: die Map `{ rowId: companyId | "skip" }` als
  // JSON über denselben answerChoice-Kanal.
  function handleSubmitMatch(
    choiceId: string,
    map: Record<string, string>,
  ) {
    const value = JSON.stringify(map);
    setMessages((prev) =>
      prev.map((m) =>
        m.matchPrompt?.choiceId === choiceId
          ? { ...m, matchPrompt: { ...m.matchPrompt, answeredValue: value } }
          : m,
      ),
    );
    void window.api.agent.answerChoice({ choiceId, value });
  }

  // ChatGPT-inspired layout (8.l3).
  //
  //   - Empty state (no messages yet): centered "Wo sollen wir anfangen?"
  //     welcome + composer pill, no scroll log.
  //   - Active state: scrollable message log with the composer pinned at
  //     the bottom and a small disclaimer below.
  //
  // Bubble vs plain: user turns render as a right-aligned rounded bubble;
  // assistant turns flow as plain prose without a bubble (closer to
  // long-form reading than chat shorthand). Tool activity rows and choice
  // cards keep their existing styling.
  const isEmpty = messages.length === 0 && !error && !thinking;
  const statusLine =
    status === null
      ? "lädt…"
      : status.ready
        ? `bereit · ${status.model}`
        : status.errorMessage
          ? `Fehler: ${status.errorMessage}`
          : "Warte auf Ollama…";

  // Voice recording state (Phase 8.n2). When active, the composer
  // swaps to a ChatGPT-style waveform view: PlusIcon (left) → live
  // waveform (middle) → cancel × / finish ✓ (right). Cmd+D / Ctrl+D
  // also finishes; Esc cancels. Transcript drops into the textarea
  // and we return to the normal composer.
  const recorder = useVoiceRecorder();
  const isRecording =
    recorder.state === "recording" || recorder.state === "transcribing";
  const [recError, setRecError] = useState<string | null>(null);

  const startRecording = useCallback(async () => {
    setRecError(null);
    try {
      await recorder.start();
    } catch {
      // Error already in `recorder.error`; surface in the composer.
    }
  }, [recorder]);

  const finishRecording = useCallback(async () => {
    try {
      const wav = await recorder.finish();
      const result = await window.api.voice.transcribe(wav);
      // Append transcript to whatever the user already typed.
      const text = result.text.trim();
      if (text) {
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      }
      recorder.cancel(); // resets to idle even after a no-content transcribe
    } catch (err) {
      setRecError(
        err instanceof Error
          ? `Transkription fehlgeschlagen: ${err.message}`
          : String(err),
      );
      recorder.cancel();
    }
  }, [recorder]);

  // Cmd+D / Ctrl+D = finish, Esc = cancel — matches ChatGPT's mic UX.
  useEffect(() => {
    if (recorder.state !== "recording") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        void finishRecording();
      } else if (e.key === "Escape") {
        e.preventDefault();
        recorder.cancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [recorder.state, recorder, finishRecording]);

  const composer = (
    <div className="chat-composer-wrap">
      {attachments.length > 0 && !isRecording && (
        <div className="chat-attachments">
          {attachments.map((a) => (
            <div key={a.id} className="chat-attachment-row">
              <AttachmentChip
                attachment={a}
                onRemove={() => removeAttachment(a.id)}
              />
              <input
                type="text"
                className="chat-attachment-name-input"
                placeholder="Vorgangsname (optional, sonst Dateiname)"
                value={a.transactionName ?? ""}
                onChange={(e) => setAttachmentName(a.id, e.target.value)}
                disabled={!status?.ready}
              />
            </div>
          ))}
        </div>
      )}
      {scanPdfPending && (
        <div className="scan-pdf-prompt">
          <div className="scan-pdf-prompt__head">
            <strong>{scanPdfPending.filename}</strong> ist ein Scan-PDF
            ({scanPdfPending.numPages} Seite
            {scanPdfPending.numPages === 1 ? "" : "n"}). Damit das LLM
            es lesen kann, rendere ich die Seiten als Bilder.
          </div>
          <div className="scan-pdf-prompt__hint">
            Achtung: Seiten als Bilder kosten mehr Vision-Tokens als
            normaler Text. Wähle wie viele Seiten gerendert werden
            sollen — der Rest wird ignoriert.
          </div>
          <div className="scan-pdf-prompt__buttons">
            <button
              type="button"
              disabled={scanPdfBusy}
              onClick={() => handleScanPdfChoice(5)}
            >
              5 Seiten (~7.5k Tokens)
            </button>
            <button
              type="button"
              disabled={scanPdfBusy}
              onClick={() => handleScanPdfChoice(10)}
            >
              10 Seiten (~15k)
            </button>
            <button
              type="button"
              disabled={scanPdfBusy}
              onClick={() => handleScanPdfChoice(20)}
            >
              20 Seiten (~30k)
            </button>
            <button
              type="button"
              disabled={scanPdfBusy}
              onClick={() =>
                handleScanPdfChoice(scanPdfPending.numPages)
              }
            >
              Alle ({scanPdfPending.numPages})
            </button>
            <button
              type="button"
              disabled={scanPdfBusy}
              onClick={() => handleScanPdfChoice("cancel")}
            >
              Abbrechen
            </button>
          </div>
          {scanPdfBusy && (
            <div className="scan-pdf-prompt__busy">Seiten rendern…</div>
          )}
        </div>
      )}
      {pendingImages.length > 0 && !isRecording && (
        <div className="chat-images">
          {!status?.supportsImages && (
            <div className="chat-images__warn">
              Aktuelles Modell unterstützt keine Bilder. Wechsle in den
              Einstellungen zu einem Vision-Modell (z. B. Claude Sonnet,
              GPT-4o, Gemini, llava), sonst werden die Anhänge ignoriert.
            </div>
          )}
          <div className="chat-images__grid">
            {pendingImages.map((img) => (
              <div key={img.id} className="chat-image-chip" title={img.filename}>
                <img
                  src={`data:${img.mimeType};base64,${img.base64}`}
                  alt={img.filename}
                />
                <button
                  type="button"
                  onClick={() => removePendingImage(img.id)}
                  aria-label={`${img.filename} entfernen`}
                  className="chat-image-chip__remove"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div
        className={`chat-composer${status?.ready ? "" : " is-disabled"}${isRecording ? " chat-composer--recording" : ""}`}
      >
        <button
          type="button"
          className="chat-composer__icon-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={!status?.ready || isRecording}
          title="Tabelle anhängen (.xlsx, .xls, .csv, .tsv)"
          aria-label="Anhängen"
        >
          <PlusIcon />
        </button>

        {isRecording ? (
          <RecordingView
            levels={recorder.levels}
            elapsedSeconds={recorder.elapsedSeconds}
            transcribing={recorder.state === "transcribing"}
            onCancel={() => recorder.cancel()}
            onFinish={() => void finishRecording()}
          />
        ) : (
          <>
            <SlashPalette
              ref={slashPaletteRef}
              open={slashOpen}
              query={slashDetect.query}
              onSelect={(cmd) => {
                setInput("/" + cmd.name + " ");
                setSlashDismissed(false);
                setTimeout(() => {
                  const el = composerTextareaRef.current;
                  if (el) {
                    el.focus();
                    const len = el.value.length;
                    el.setSelectionRange(len, len);
                  }
                }, 0);
              }}
              onClose={() => setSlashDismissed(true)}
              anchorRef={composerTextareaRef}
            />
            <textarea
              ref={composerTextareaRef}
              className="chat-composer__textarea"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                setSlashDismissed(false);
              }}
              onKeyDown={(e) => {
                if (slashOpen) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    slashPaletteRef.current?.moveDown();
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    slashPaletteRef.current?.moveUp();
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    if (slashPaletteRef.current?.select()) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setSlashDismissed(true);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              onPaste={handlePaste}
              placeholder={
                status?.ready
                  ? attachments.length > 0 || pendingImages.length > 0
                    ? "Notiz hinzufügen (oder direkt senden)…"
                    : "Frag AVA…"
                  : "Warte auf das lokale Modell…"
              }
              rows={1}
              disabled={!status?.ready}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".xlsx,.xls,.csv,.tsv,.pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif"
              style={{ display: "none" }}
              onChange={handleFileInput}
            />
            <VoiceMicButton onActivate={() => void startRecording()} />
            {inFlight ? (
              <button
                type="button"
                className="chat-composer__icon-btn chat-composer__send"
                onClick={handleAbort}
                title="Stoppen"
                aria-label="Stoppen"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                className="chat-composer__icon-btn chat-composer__send"
                onClick={() => void handleSend()}
                disabled={!canSend}
                title="Senden"
                aria-label="Senden"
              >
                <ArrowUpIcon />
              </button>
            )}
          </>
        )}
      </div>
      {recorder.error && (
        <div className="chat-recorder-error" role="alert">
          {recorder.error.message.split(/\n\n/).map((para, i) => (
            <p
              key={i}
              className={`chat-recorder-error__msg${i > 0 ? " chat-recorder-error__msg--note" : ""}`}
            >
              {para}
            </p>
          ))}
          <div className="chat-recorder-error__actions">
            {recorder.error.kind === "system-denied" && (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  void window.api.voice.openMicSettings();
                }}
              >
                Systemeinstellungen öffnen
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                recorder.clearError();
                void startRecording();
              }}
            >
              Erneut versuchen
            </button>
            <button
              type="button"
              className="link"
              onClick={() => recorder.clearError()}
            >
              Schließen
            </button>
          </div>
        </div>
      )}
      {recError && (
        <div className="chat-disclaimer chat-disclaimer--error">
          {recError}
        </div>
      )}
      <div className="chat-disclaimer">
        {isRecording ? (
          <span>
            Diktat aktiv ·{" "}
            <kbd className="chat-kbd">{macKey()}D</kbd> zum Beenden,{" "}
            <kbd className="chat-kbd">Esc</kbd> zum Abbrechen
          </span>
        ) : (
          <>
            {statusLine} ·{" "}
            <span className="muted">
              AVA kann Fehler machen. Wichtige Angaben überprüfen.
            </span>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`chat-route${sidebarCollapsed ? " chat-route--sidebar-collapsed" : ""}${dragOver ? " chat-route--drag" : ""}`}
    >
      <ChatSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((c) => !c)}
        conversations={conversations}
        activeId={conversationId}
        onSelect={(id) => void switchConversation(id)}
        onNew={() => startNewConversation()}
        onDelete={(id) => void handleDeleteConversation(id)}
        footer={status?.ready ? status.model : null}
      />
      <div
        className={`chat-route__main ${isEmpty ? "chat-route__main--empty" : "chat-route__main--active"}`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
      {dragOver && (
        <div className="chat-drop-overlay" aria-hidden>
          <div className="chat-drop-overlay__inner">
            Tabelle hier ablegen, um sie anzuhängen
            <div className="muted small">.xlsx · .xls · .csv · .tsv</div>
          </div>
        </div>
      )}

      {isEmpty ? (
        <div className="chat-welcome-stack">
          {noUsableProvider ? (
            <div className="chat-empty chat-empty--blocked">
              <strong>Dem Agenten steht kein Sprachmodell zur Verfügung.</strong>
              <p className="muted">
                Es ist weder ein lokales LLM auf der Festplatte vorhanden noch
                ein API-Key für einen Cloud-Anbieter hinterlegt. Bitte wähle:
              </p>
              <ul>
                <li>
                  <Link to="/whoami">Status öffnen</Link> und ein lokales Modell
                  herunterladen (Qwen 2.5 7B ist der empfohlene Standard,
                  ~4,7 GB), oder
                </li>
                <li>
                  <Link to="/whoami">Status öffnen</Link> und einen API-Key für
                  OpenAI / Anthropic / Google / Mistral hinterlegen.
                </li>
              </ul>
            </div>
          ) : (
            <div className="chat-welcome-block">
              <h1 className="chat-welcome">
                Womit fangen wir <span className="ct-gradient-text">heute</span> an?
              </h1>
              <p className="chat-welcome__lede">
                Suche Informationen zu deinen Zielfirmen: Geschäftsdaten,
                Ansprechpartner, Finanzkennzahlen, Website und aktuelle
                Entwicklungen. Ich recherchiere für dich und bereite alles
                so auf, dass du es direkt im Vertrieb nutzen kannst.
              </p>
            </div>
          )}
          {composer}
        </div>
      ) : (
        <>
          <div className="chat-log" ref={scrollRef}>
            {messages.map((m) => {
              if (m.activity) {
                return (
                  <ActivityRow
                    key={m.id}
                    toolName={m.activity.toolName}
                    args={m.activity.args}
                    status={m.activity.status}
                    preview={m.activity.preview}
                  />
                );
              }
              if (m.choice) {
                return (
                  <ChoiceCardWithOther
                    key={m.id}
                    choice={m.choice}
                    onPick={(value) =>
                      handlePickChoice(m.choice!.choiceId, value)
                    }
                  />
                );
              }
              if (m.textPrompt) {
                return (
                  <TextPromptCard
                    key={m.id}
                    prompt={m.textPrompt}
                    onSubmit={(v) => handleSubmitText(m.textPrompt!.choiceId, v)}
                  />
                );
              }
              if (m.matchPrompt) {
                return (
                  <MatchResolutionCard
                    key={m.id}
                    prompt={m.matchPrompt}
                    onSubmit={(map) =>
                      handleSubmitMatch(m.matchPrompt!.choiceId, map)
                    }
                  />
                );
              }
              return (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  className={`chat-msg chat-msg-${m.role}`}
                  aria-label={roleLabel(m.role)}
                >
                  <div className="chat-content">
                    {m.role === "user" ? (
                      <>
                        <UserBubbleContent content={m.content} />
                        {m.images && m.images.length > 0 && (
                          <div className="chat-msg-images">
                            {m.images.map((img, idx) => (
                              <img
                                key={idx}
                                src={`data:${img.mimeType};base64,${img.base64}`}
                                alt={img.filename ?? `Bild ${idx + 1}`}
                                className="chat-msg-image"
                              />
                            ))}
                          </div>
                        )}
                      </>
                    ) : (
                      renderChatContent(m.content)
                    )}
                    {m.pending && <span className="chat-cursor">▍</span>}
                  </div>
                </div>
              );
            })}
            {thinking && <ThinkingRow />}
            {error && <ChatErrorBanner message={error} onCleared={() => setError(null)} />}
          </div>
          {composer}
        </>
      )}
      </div>
    </div>
  );
}

// ---- Composer icons -------------------------------------------------------
//
// Inline SVGs (no icon library dependency). 20×20 viewBox, currentColor so
// the icons inherit the disabled/idle/hover state from the button styles.

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 4v12M4 10h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function VoiceMicButton({ onActivate }: { onActivate: () => void }) {
  const status = useVoiceStore((s) => s.status);
  const navigate = useNavigate();
  const ready = status.state === "ready";
  const title = ready
    ? `Diktat starten (${macKey()}D zum Beenden)`
    : status.state === "downloading"
      ? "Sprachmodell wird heruntergeladen, zu den Einstellungen"
      : status.state === "model-missing"
        ? "Sprachmodell installieren, zu den Einstellungen"
        : status.state === "binary-missing"
          ? "Whisper einrichten, zu den Einstellungen"
          : "Sprachmodus einrichten, zu den Einstellungen";
  const onClick = () => {
    if (ready) onActivate();
    else navigate("/settings#voice-settings");
  };
  return (
    <button
      type="button"
      className="chat-composer__icon-btn"
      title={title}
      aria-label="Sprachmodus"
      data-voice-state={status.state}
      onClick={onClick}
    >
      <MicIcon />
    </button>
  );
}

function macKey(): string {
  // Best-effort platform sniff for the keybinding chip. Electron's
  // navigator.platform is less reliable post-deprecation; userAgent
  // works consistently in Chromium.
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /Mac|iPhone|iPad/.test(ua) ? "⌘" : "Ctrl+";
}

function RecordingView({
  levels,
  elapsedSeconds,
  transcribing,
  onCancel,
  onFinish,
}: {
  levels: number[];
  elapsedSeconds: number;
  transcribing: boolean;
  onCancel: () => void;
  onFinish: () => void;
}) {
  const mm = Math.floor(elapsedSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = (elapsedSeconds % 60).toString().padStart(2, "0");
  return (
    <div className="chat-composer__rec">
      <Waveform levels={levels} active={!transcribing} />
      <span className="chat-composer__rec-time muted">
        {transcribing ? "Transkribiere…" : `${mm}:${ss}`}
      </span>
      <button
        type="button"
        className="chat-composer__icon-btn chat-composer__rec-cancel"
        onClick={onCancel}
        title="Abbrechen (Esc)"
        aria-label="Diktat abbrechen"
        disabled={transcribing}
      >
        <CloseIcon />
      </button>
      <button
        type="button"
        className="chat-composer__icon-btn chat-composer__send chat-composer__rec-finish"
        onClick={onFinish}
        title={`Diktat beenden (${macKey()}D)`}
        aria-label="Diktat beenden"
        disabled={transcribing}
      >
        <CheckIcon />
      </button>
    </div>
  );
}

function Waveform({
  levels,
  active,
}: {
  levels: number[];
  active: boolean;
}) {
  // Render the rolling level slice as vertical bars on a canvas.
  // Newer samples on the right, dotted "rest of room" line on the
  // left to suggest scroll history — matches the ChatGPT look.
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const cssHeight = canvas.clientHeight;
    if (canvas.width !== cssWidth * dpr) canvas.width = cssWidth * dpr;
    if (canvas.height !== cssHeight * dpr) canvas.height = cssHeight * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    // Base dotted track (the "ahead" empty area in ChatGPT's UI).
    // Pull the live foreground colour from CSS (`.chat-composer--recording`
    // sets `color` per theme), so the bars/dots stay readable in both
    // light + dark mode. Falls back to white for legacy/no-CSS paths.
    const liveColor =
      getComputedStyle(canvas).color || "rgba(255, 255, 255, 1)";
    const trackColor = withAlpha(liveColor, active ? 0.34 : 0.2);
    const dotR = 1.4;
    const dotGap = 5;
    const trackY = cssHeight / 2;
    ctx.fillStyle = trackColor;
    for (let x = 2; x < cssWidth - 4; x += dotGap) {
      ctx.beginPath();
      ctx.arc(x, trackY, dotR, 0, Math.PI * 2);
      ctx.fill();
    }

    // Level bars — aligned to the right edge so the freshest sample
    // sits next to the action buttons.
    const BAR_W = 3;
    const BAR_GAP = 2;
    const STRIDE = BAR_W + BAR_GAP;
    const maxBars = Math.floor((cssWidth - 8) / STRIDE);
    const slice = levels.slice(-maxBars);
    const minBar = 4; // visible even when silence
    const maxBar = cssHeight - 4;
    const rightEdge = cssWidth - 4;
    ctx.fillStyle = active ? liveColor : withAlpha(liveColor, 0.6);
    for (let i = 0; i < slice.length; i++) {
      const v = Math.min(1, Math.max(0, slice[i]!));
      // sqrt curve gives quiet sounds a more visible bar.
      const norm = Math.sqrt(v);
      const h = Math.max(minBar, Math.round(norm * maxBar));
      const x = rightEdge - (slice.length - i) * STRIDE;
      const y = trackY - h / 2;
      // Rounded ends — small radius matches the bar width.
      const r = BAR_W / 2;
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + BAR_W - r, y);
      ctx.quadraticCurveTo(x + BAR_W, y, x + BAR_W, y + r);
      ctx.lineTo(x + BAR_W, y + h - r);
      ctx.quadraticCurveTo(x + BAR_W, y + h, x + BAR_W - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.fill();
    }
  }, [levels, active]);
  return <canvas className="chat-composer__waveform" ref={ref} />;
}

/**
 * Parse an `rgb(r, g, b)` / `rgba(r, g, b, a)` colour string and
 * return a new `rgba(...)` with the given alpha. Falls back to
 * white-with-alpha if the input isn't an rgb form (e.g. a named
 * colour from a browser quirk).
 */
function withAlpha(rgbColor: string, alpha: number): string {
  const m = rgbColor.match(
    /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+)?\s*\)/,
  );
  if (!m) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})`;
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M4 11l4 4 8-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7.5" y="2.5" width="5" height="9" rx="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7 17.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M10 16V4M5 9l5-5 5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

// ---- Inline components ----------------------------------------------------

/**
 * v0.1.321 — ChoiceCard mit immer-vorhandenem "Sonstiges"-Button.
 * Auf Klick wird der Button-Row durch ein Inline-Textfeld ersetzt; bei
 * Submit wird der Wert mit Sentinel-Prefix `__user_other__:` an
 * `answerChoice` geschickt. Main-Side erkennt den Prefix, beendet das
 * Tool-Choice mit Cancel-Sentinel und injiziert den Freitext als
 * nächste User-Message in die Conversation.
 *
 * Begründung: User soll bei jedem Confirm-Dialog die Option haben "ich
 * will eigentlich was anderes" zu sagen, ohne die ganze Conversation
 * abbrechen und neu starten zu müssen. Speziell bei Multi-Step-Tools
 * (HubSpot-Update, Mail-Send, Schedule-Create) ist die feste Auswahl
 * "Übernehmen / Verwerfen" zu eng.
 */
function ChoiceCardWithOther(props: {
  choice: {
    choiceId: string;
    prompt: string;
    options: Array<{
      value: string;
      label: string;
      description?: string;
    }>;
    answeredValue?: string;
  };
  onPick: (value: string) => void;
}) {
  const { choice, onPick } = props;
  const picked = choice.answeredValue;
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (otherMode) inputRef.current?.focus();
  }, [otherMode]);

  function submitOther(): void {
    const t = otherText.trim();
    if (t.length === 0) return;
    onPick(`__user_other__:${t}`);
  }

  // Wenn schon beantwortet: nur statisch anzeigen, kein Editier-State.
  if (picked !== undefined) {
    return (
      <div className="chat-msg chat-msg-choice">
        <div className="chat-choice">
          <div className="chat-choice-prompt">{renderTextSegment(choice.prompt, `choiceprompt-${choice.choiceId}`)}</div>
          <div className="chat-choice-options">
            {choice.options.map((opt) => (
              <button
                key={opt.value}
                className={`chat-choice-option${picked === opt.value ? " picked" : ""}`}
                disabled
              >
                <span className="chat-choice-label">{opt.label}</span>
                {opt.description && (
                  <span className="chat-choice-desc">{opt.description}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-msg chat-msg-choice">
      <div className="chat-choice">
        <div className="chat-choice-prompt">{renderTextSegment(choice.prompt, `choiceprompt-${choice.choiceId}`)}</div>
        {otherMode ? (
          <div className="chat-choice-other">
            <input
              ref={inputRef}
              type="text"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitOther();
                if (e.key === "Escape") {
                  setOtherMode(false);
                  setOtherText("");
                }
              }}
              placeholder="Was möchtest du stattdessen?"
              className="chat-choice-other-input"
            />
            <div className="chat-choice-other-actions">
              <button
                type="button"
                className="chat-choice-other-submit"
                onClick={submitOther}
                disabled={otherText.trim().length === 0}
              >
                Senden
              </button>
              <button
                type="button"
                className="chat-choice-other-cancel"
                onClick={() => {
                  setOtherMode(false);
                  setOtherText("");
                }}
              >
                Zurück
              </button>
            </div>
          </div>
        ) : (
          <div className="chat-choice-options">
            {choice.options.map((opt) => (
              <button
                key={opt.value}
                className="chat-choice-option"
                onClick={() => onPick(opt.value)}
              >
                <span className="chat-choice-label">{opt.label}</span>
                {opt.description && (
                  <span className="chat-choice-desc">{opt.description}</span>
                )}
              </button>
            ))}
            <button
              type="button"
              className="chat-choice-option chat-choice-option--other"
              onClick={() => setOtherMode(true)}
              title="Etwas anderes als die vorgeschlagenen Optionen"
            >
              <span className="chat-choice-label">Sonstiges …</span>
              <span className="chat-choice-desc">
                Eigene Antwort eingeben — AVA übernimmt den Text als neue
                Anweisung
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function TextPromptCard(props: {
  prompt: {
    choiceId: string;
    prompt: string;
    placeholder?: string;
    defaultValue?: string;
    optional?: boolean;
    answeredValue?: string;
  };
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(props.prompt.defaultValue ?? "");
  const answered = props.prompt.answeredValue !== undefined;
  const trimmed = value.trim();
  const canSubmit = !answered && (props.prompt.optional || trimmed.length > 0);

  return (
    <div className="chat-msg chat-msg-choice">
      <div className="chat-choice">
        <div className="chat-choice-prompt">{renderTextSegment(props.prompt.prompt, `inputprompt-${props.prompt.choiceId}`)}</div>
        {answered ? (
          <div className="chat-textprompt__answered muted">
            {props.prompt.answeredValue ? (
              <>Antwort: <strong>{props.prompt.answeredValue}</strong></>
            ) : (
              "Übersprungen."
            )}
          </div>
        ) : (
          <form
            className="chat-textprompt__form"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) props.onSubmit(trimmed);
            }}
          >
            <input
              type="text"
              autoFocus
              value={value}
              placeholder={props.prompt.placeholder}
              onChange={(e) => setValue(e.target.value)}
              className="chat-textprompt__input"
            />
            <div className="chat-textprompt__actions">
              {props.prompt.optional && (
                <button
                  type="button"
                  className="link"
                  onClick={() => props.onSubmit("")}
                >
                  Überspringen
                </button>
              )}
              <button type="submit" className="primary" disabled={!canSubmit}>
                Senden
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// v0.1.392 — Batch-Zuordnung nicht eindeutiger Import-Firmen. Eine
// scrollbare Karte: pro Firma die Kandidaten (relativer Treffer-Balken,
// „bester Treffer"-Tag) + „Überspringen". Top-Kandidat ist vorausgewählter,
// überschreibbarer Default. Massen-Aktionen + Filter für große Listen.
function MatchResolutionCard(props: {
  prompt: {
    choiceId: string;
    prompt: string;
    rows: AgentMatchRow[];
    answeredValue?: string;
  };
  onSubmit: (map: Record<string, string>) => void;
}) {
  const { rows } = props.prompt;
  const answered = props.prompt.answeredValue !== undefined;
  const [selection, setSelection] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const r of rows) init[r.rowId] = r.candidates[0]?.companyId ?? "skip";
    return init;
  });
  const [filter, setFilter] = useState("");

  if (answered) {
    let assigned = 0;
    let skipped = 0;
    try {
      const map = JSON.parse(props.prompt.answeredValue || "{}") as Record<
        string,
        string
      >;
      for (const r of rows) {
        const v = map[r.rowId];
        if (v && v !== "skip") assigned += 1;
        else skipped += 1;
      }
    } catch {
      /* ignore */
    }
    return (
      <div className="chat-msg chat-msg-choice">
        <div className="chat-choice import-match import-match--done">
          <div className="import-match__head">
            <i className="ti ti-git-compare" aria-hidden="true" />
            <span>
              Zuordnung übermittelt — {assigned} zugeordnet, {skipped}{" "}
              übersprungen
            </span>
          </div>
        </div>
      </div>
    );
  }

  const setAll = (mode: "top" | "skip") =>
    setSelection(() => {
      const next: Record<string, string> = {};
      for (const r of rows) {
        next[r.rowId] =
          mode === "skip" ? "skip" : (r.candidates[0]?.companyId ?? "skip");
      }
      return next;
    });

  const q = filter.trim().toLowerCase();
  const visible = q
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          r.location.toLowerCase().includes(q),
      )
    : rows;
  const assignedCount = Object.values(selection).filter(
    (v) => v && v !== "skip",
  ).length;
  const skippedCount = rows.length - assignedCount;

  return (
    <div className="chat-msg chat-msg-choice">
      <div className="chat-choice import-match">
        <div className="import-match__head">
          <i className="ti ti-git-compare" aria-hidden="true" />
          <span>{props.prompt.prompt}</span>
        </div>
        <div className="import-match__bulk">
          <button type="button" onClick={() => setAll("top")}>
            Top-Vorschlag überall
          </button>
          <button type="button" onClick={() => setAll("skip")}>
            Alle überspringen
          </button>
          <input
            type="text"
            className="import-match__filter"
            placeholder="Filtern…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <div className="import-match__list">
          {visible.map((r) => {
            const maxScore = r.candidates.reduce(
              (m, c) => Math.max(m, c.score ?? 0),
              0,
            );
            const group = `m-${props.prompt.choiceId}-${r.rowId}`;
            return (
              <div key={r.rowId} className="import-match__row">
                <div className="import-match__company">
                  <span className="import-match__name">{r.name}</span>
                  {r.location && (
                    <span className="import-match__city"> · {r.location}</span>
                  )}
                </div>
                <div className="import-match__options">
                  {r.candidates.map((c, i) => {
                    const pct =
                      maxScore > 0
                        ? Math.round(((c.score ?? 0) / maxScore) * 100)
                        : 0;
                    const sel = selection[r.rowId] === c.companyId;
                    return (
                      <label
                        key={c.companyId}
                        className={`import-match__opt${sel ? " is-selected" : ""}`}
                      >
                        <input
                          type="radio"
                          name={group}
                          checked={sel}
                          onChange={() =>
                            setSelection((p) => ({
                              ...p,
                              [r.rowId]: c.companyId,
                            }))
                          }
                        />
                        <span className="import-match__opt-main">
                          <span className="import-match__opt-name">
                            {c.name}
                            {c.location ? (
                              <span className="muted"> · {c.location}</span>
                            ) : null}
                            {i === 0 && (
                              <span className="import-match__best">
                                bester Treffer
                              </span>
                            )}
                          </span>
                          {maxScore > 0 && (
                            <span className="import-match__bar" aria-hidden="true">
                              <span
                                className="import-match__bar-fill"
                                style={{ width: `${pct}%` }}
                              />
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  <label
                    className={`import-match__opt import-match__opt--skip${
                      selection[r.rowId] === "skip" ? " is-selected" : ""
                    }`}
                  >
                    <input
                      type="radio"
                      name={group}
                      checked={selection[r.rowId] === "skip"}
                      onChange={() =>
                        setSelection((p) => ({ ...p, [r.rowId]: "skip" }))
                      }
                    />
                    <span className="import-match__opt-main">
                      <i
                        className="ti ti-player-skip-forward"
                        aria-hidden="true"
                      />{" "}
                      Überspringen
                    </span>
                  </label>
                </div>
              </div>
            );
          })}
          {visible.length === 0 && (
            <div className="import-match__empty muted">
              Kein Treffer für „{filter}".
            </div>
          )}
        </div>
        <div className="import-match__foot">
          <span className="muted">
            {assignedCount} zugeordnet · {skippedCount} übersprungen
          </span>
          <button
            type="button"
            className="primary"
            onClick={() => props.onSubmit(selection)}
          >
            Auswahl übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityRow(props: {
  toolName: string;
  args: unknown;
  status: Activity["status"];
  preview?: string;
}) {
  const [open, setOpen] = useState(false);
  const [errorOpen, setErrorOpen] = useState(false);
  const argSummary = summarizeArgs(props.args);
  const argFull = formatArgsFull(props.args);
  const hasArgs = argSummary.length > 0;
  // v0.1.246 — Bei Fehler-Status den Preview in einen ausklappbaren
  // <pre>-Block schieben. Standard-Anzeige bleibt kurz (erste 100
  // Zeichen, einzeilig); Klick auf "Fehler anzeigen" expandiert den
  // VOLLEN Text. Vorher wurde die ganze Notion-400-Validation-Story
  // einzeilig + auf Span-Breite getrimmt — der User sah weder den
  // gesendeten Filter noch den Schema-Hint, weil beides am
  // span-Overflow weggeschnitten war.
  const isError = props.status === "error";
  const fullPreview = props.preview ?? "";
  const shortPreview =
    isError && fullPreview.length > 100
      ? fullPreview.slice(0, 100) + "…"
      : fullPreview;
  const errorTooLongForInline = isError && fullPreview.length > 100;
  return (
    <div className={`activity activity-${props.status}`}>
      <div className="activity-marker">
        {props.status === "running" ? (
          <span className="activity-spinner" aria-hidden />
        ) : props.status === "done" ? (
          <span className="activity-icon ok">✓</span>
        ) : (
          <span className="activity-icon bad">✗</span>
        )}
      </div>
      <div className="activity-body">
        <div className="activity-headline">
          <code className="activity-tool">{props.toolName}</code>
          {hasArgs && (
            <button
              type="button"
              className="activity-args-toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? "Argumente ausblenden" : "Argumente"}
            </button>
          )}
          {errorTooLongForInline && (
            <button
              type="button"
              className="activity-args-toggle"
              onClick={() => setErrorOpen((v) => !v)}
              aria-expanded={errorOpen}
            >
              {errorOpen ? "Fehler ausblenden" : "Fehler anzeigen"}
            </button>
          )}
          {fullPreview && (
            <span className="activity-preview">
              {errorTooLongForInline ? shortPreview : fullPreview}
            </span>
          )}
        </div>
        {hasArgs && open && <pre className="activity-args">{argFull}</pre>}
        {errorTooLongForInline && errorOpen && (
          <pre className="activity-args activity-error-detail">
            {fullPreview}
          </pre>
        )}
      </div>
    </div>
  );
}

function AttachmentChip(props: {
  attachment: SpreadsheetAttachment;
  onRemove: () => void;
}) {
  const { attachment } = props;
  // Compact summary: filename + (sheet count + total rows + size).
  const totalRows = attachment.sheets.reduce(
    (sum, s) => sum + s.totalRows,
    0,
  );
  const sheetSummary =
    attachment.sheets.length === 1
      ? `${attachment.sheets[0]!.headers.length} Spalten`
      : `${attachment.sheets.length} Tabellenblätter`;
  return (
    <div className="chat-attachment-chip" title={attachment.filename}>
      <span className="chat-attachment-icon" aria-hidden>
        📎
      </span>
      <span className="chat-attachment-name">{attachment.filename}</span>
      <span className="chat-attachment-meta muted small">
        {sheetSummary} · {totalRows} {totalRows === 1 ? "Zeile" : "Zeilen"} ·{" "}
        {formatBytes(attachment.sizeBytes)}
      </span>
      <button
        type="button"
        className="link bad chat-attachment-remove"
        onClick={props.onRemove}
        title="Anhang entfernen"
      >
        ✕
      </button>
    </div>
  );
}

function ChatSidebar(props: {
  collapsed: boolean;
  onToggle: () => void;
  conversations: ConversationListEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  footer: string | null;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return props.conversations;
    return props.conversations.filter((c) =>
      labelFor(c).toLowerCase().includes(q),
    );
  }, [query, props.conversations]);

  return (
    <aside
      className={`chat-sidebar${props.collapsed ? " chat-sidebar--collapsed" : ""}`}
      aria-label="Konversationen"
    >
      <div className="chat-sidebar__header">
        <button
          type="button"
          className="chat-sidebar__icon-btn"
          onClick={props.onToggle}
          title={
            props.collapsed
              ? "Seitenleiste einblenden (⌘/Ctrl+Shift+S)"
              : "Seitenleiste ausblenden (⌘/Ctrl+Shift+S)"
          }
          aria-label={
            props.collapsed ? "Seitenleiste einblenden" : "Seitenleiste ausblenden"
          }
        >
          {props.collapsed ? (
            <PanelLeftOpen size={18} />
          ) : (
            <PanelLeftClose size={18} />
          )}
        </button>
        <div className="chat-sidebar__header-right">
          <button
            type="button"
            className="chat-sidebar__icon-btn"
            onClick={props.onNew}
            title="Neue Konversation"
            aria-label="Neue Konversation"
          >
            <SquarePen size={18} />
          </button>
          <button
            type="button"
            className="chat-sidebar__icon-btn"
            onClick={() => openChatSearch()}
            title="In allen Chats suchen (⌘/Ctrl+K)"
            aria-label="In allen Chats suchen"
          >
            <SearchCode size={18} />
          </button>
        </div>
      </div>
      {!props.collapsed && (
        <>
          <div className="chat-sidebar__search">
            <SearchIcon size={14} className="chat-sidebar__search-icon" />
            <input
              type="text"
              placeholder="Chats suchen"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Konversationen durchsuchen"
            />
          </div>
          <div className="chat-sidebar__list" role="listbox">
            {filtered.length === 0 ? (
              <div className="chat-sidebar__empty muted small">
                {props.conversations.length === 0
                  ? "Keine Konversationen"
                  : "Keine Treffer"}
              </div>
            ) : (
              filtered.map((c) => {
                const isActive = c.conversationId === props.activeId;
                return (
                  <div
                    key={c.conversationId}
                    role="option"
                    aria-selected={isActive}
                    className={`chat-sidebar__row${isActive ? " chat-sidebar__row--active" : ""}`}
                    onClick={() => props.onSelect(c.conversationId)}
                    title={labelFor(c)}
                  >
                    <span className="chat-sidebar__row-label">
                      {c.label || `(leer) ${c.conversationId.slice(0, 8)}`}
                    </span>
                    <button
                      type="button"
                      className="chat-sidebar__row-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onDelete(c.conversationId);
                      }}
                      title="Konversation löschen"
                      aria-label="Konversation löschen"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>
          <div className="chat-sidebar__footer muted small">
            {props.footer ? props.footer : ""}
          </div>
        </>
      )}
    </aside>
  );
}

/** Polyfill for CSS.escape. Conversation/message ids are UUIDs, so
 *  the surface here is small — alphanumerics + dashes. We still run
 *  it through the standard escape when available for safety against
 *  future id formats. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

function labelFor(c: ConversationListEntry): string {
  const stamp = formatRelative(c.modifiedAt);
  if (c.label) return `${c.label}  ·  ${stamp}`;
  // Anonymous fallback: short id + timestamp.
  return `(leer) ${c.conversationId.slice(0, 8)} · ${stamp}`;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "gerade eben";
  if (diff < 3_600_000) return `vor ${Math.round(diff / 60_000)} Min.`;
  if (diff < 86_400_000) return `vor ${Math.round(diff / 3_600_000)} Std.`;
  return `vor ${Math.round(diff / 86_400_000)} Tagen`;
}

// Markdown renderer for chat bubbles. The agent emits real markdown
// (bold, italic, lists, headings, fenced code, inline code, paragraphs)
// plus two link forms that need special routing:
//   `[Label](company:<companyId>)` → in-app <Link to="/companies/:id">
//     The agent is instructed (see prompts.ts) to wrap company mentions
//     in this form so the user can jump to the detail page.
//   `[Label](http(s)://…)` → external open via window.api.shell.openExternal.
//     The renderer is hash-routed and replacing location would tear down
//     the chat session, so we never let the browser navigate the URL.
//
// Chart fences (```chart …) are intercepted twice: once by the pre-pass
// `CHART_FENCE_RE` extractor below (so streaming placeholders still work)
// and again by the `code` component override (belt-and-suspenders in case
// the pre-pass misses a fence — defensive against ever changing the regex).

// User-bubble content. Live sends look like `📎 filename` + the user's
// note (composed in handleSend), but on transcript replay the full
// `[attachment: …]` block + sample rows is what we get back from disk.
// That can be hundreds of lines for a real spreadsheet, so we collapse
// the attachment block(s) to a chip that expands on click. The user's
// own typed text always stays visible.
function UserBubbleContent({ content }: { content: string }) {
  const split = useMemo(() => splitAttachmentBlocks(content), [content]);
  if (split.attachments.length === 0) {
    return <>{renderUserBubbleText(content)}</>;
  }
  return (
    <>
      {split.attachments.map((a, i) => (
        <AttachmentDisclosure key={i} block={a} />
      ))}
      {split.typed.trim().length > 0 && (
        <div className="chat-attachment-typed">
          {renderUserBubbleText(split.typed)}
        </div>
      )}
    </>
  );
}

// If the user message's first line starts with `/<name>`, render that
// token as a pill so the bubble visually matches the composer. The
// rest of the content (incl. line 2+) goes through `renderChatContent`
// as usual.
function renderUserBubbleText(text: string): ReactNode {
  if (!text.startsWith("/")) return renderChatContent(text);
  const newlineIdx = text.indexOf("\n");
  const firstLine = newlineIdx >= 0 ? text.slice(0, newlineIdx) : text;
  const rest = newlineIdx >= 0 ? text.slice(newlineIdx) : "";
  const match = LEADING_SLASH_RE.exec(firstLine);
  if (!match) return renderChatContent(text);
  const name = match[1];
  const after = firstLine.slice(match[0].length);
  return (
    <>
      <span className="slash-cmd-pill">/{name}</span>
      {match[2] === " " ? " " : ""}
      {renderChatContent(after + rest)}
    </>
  );
}

interface AttachmentBlock {
  filename: string;
  /** User-supplied transaction name extracted from the header
   *  (`[attachment: foo.xlsx, name: "Q2-Akquise"]`); shown on the
   *  collapsed chip so the analyst sees what was attached + named
   *  without expanding. */
  transactionName: string | null;
  /** Everything between the `[attachment: …]` header and the next blank
   *  line that's followed by non-attachment content. The body has the
   *  Sheet / Columns / Sample lines from `renderAttachmentForPrompt`. */
  body: string;
}

interface SplitContent {
  attachments: AttachmentBlock[];
  /** The user's own typed text, with the attachment block(s) removed. */
  typed: string;
}

// Match the header forms emitted by `renderAttachmentForPrompt`:
//   [attachment: foo.xlsx]
//   [attachment: foo.xlsx, id: att-…]
//   [attachment: foo.xlsx, id: att-…, name: "Q2-Akquise"]
//   [attachment: foo.xlsx, name: "Q2-Akquise"]
// Capture groups: 1 = filename, 2 = id (optional), 3 = quoted name body
// (optional, JSON.stringify'd at compose time so embedded quotes/escapes
// can be JSON.parse'd back out).
const ATTACHMENT_HEADER_RE =
  /^\[attachment: ([^,\]]+)(?:, id: ([^,\]]+))?(?:, name: ("(?:[^"\\]|\\.)*"))?\]$/;

function splitAttachmentBlocks(content: string): SplitContent {
  const lines = content.split("\n");
  const attachments: AttachmentBlock[] = [];
  const typedLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = ATTACHMENT_HEADER_RE.exec(lines[i] ?? "");
    if (!m) {
      typedLines.push(lines[i] ?? "");
      i += 1;
      continue;
    }
    // Found a header. Walk forward, accumulating lines until either
    // (a) the next attachment header, or (b) a blank line followed by
    // a non-empty, non-attachment line (= the user's own text starts).
    const filename = m[1] ?? "(unknown)";
    let transactionName: string | null = null;
    if (m[3]) {
      try {
        transactionName = JSON.parse(m[3]) as string;
      } catch {
        transactionName = null;
      }
    }
    const bodyLines: string[] = [];
    i += 1;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (ATTACHMENT_HEADER_RE.test(line)) break;
      if (line === "") {
        // Peek: does the rest still look like an attachment block?
        const next = lines[i + 1] ?? "";
        const nextIsBlock =
          next === "" ||
          /^Sheet "/.test(next) ||
          /^Columns:/.test(next) ||
          /^Sample/.test(next) ||
          /^\d+\. /.test(next) ||
          /^\(.+\)$/.test(next) ||
          ATTACHMENT_HEADER_RE.test(next);
        if (!nextIsBlock) {
          // The blank line and everything after it is user-typed text.
          i += 1;
          break;
        }
      }
      bodyLines.push(line);
      i += 1;
    }
    attachments.push({
      filename,
      transactionName,
      body: bodyLines.join("\n").trim(),
    });
  }
  return { attachments, typed: typedLines.join("\n") };
}

function AttachmentDisclosure({ block }: { block: AttachmentBlock }) {
  const [open, setOpen] = useState(false);
  // Best-effort meta: pluck the first "(N data rows)" we see; gives the
  // chip something concrete next to the filename.
  const rowMatch = /\((\d+) data rows?\)/.exec(block.body);
  const rowSummary = rowMatch
    ? `${rowMatch[1]} ${rowMatch[1] === "1" ? "Zeile" : "Zeilen"}`
    : null;
  return (
    <details
      className="chat-attachment-disclosure"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="chat-attachment-icon" aria-hidden>
          📎
        </span>
        <span className="chat-attachment-name">{block.filename}</span>
        {block.transactionName && (
          <span className="chat-attachment-tx-name">
            „{block.transactionName}"
          </span>
        )}
        {rowSummary && (
          <span className="chat-attachment-meta muted small">{rowSummary}</span>
        )}
        <span className="chat-attachment-toggle muted small">
          {open ? "ausblenden" : "anzeigen"}
        </span>
      </summary>
      <pre className="chat-attachment-body">{block.body}</pre>
    </details>
  );
}

// Chart-Fence-Extractor — siehe PLANS_chart_skill.md §4.2/§4.3.
//
// `renderChatContent` ist der zentrale Bubble-Renderer (kein react-markdown).
// Wir verarbeiten daher ```chart-Fences VOR dem Link-Tokenizer und splicen
// React-Nodes (`ChartBlock`) inline ein. Restliche Segmente laufen wie zuvor
// durch `renderTextSegment` (extrahierte Variante der ursprünglichen
// Schleife) und der Tokenizer sieht NIEMALS JSON-Inhalt eines Charts.
//
// Streaming: ein offener Fence ohne Close → Platzhalter, Rest wird nicht
// weiter tokenisiert (nächster Stream-Frame ersetzt den Platzhalter).

const CHART_FENCE_RE = /```chart\s*\n([\s\S]*?)\n```/g;
const CHART_OPEN_RE = /```chart\b/;

function renderChatContent(text: string): ReactNode {
  if (!text) return null;
  const nodes: ReactNode[] = [];
  let segKey = 0;

  // 1) Vollständige ```chart-Fences einsammeln.
  CHART_FENCE_RE.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = CHART_FENCE_RE.exec(text)) !== null) {
    const before = text.slice(cursor, match.index);
    if (before) nodes.push(renderTextSegment(before, `seg-${segKey++}`));
    const raw = match[1] ?? "";
    nodes.push(<ChartBlock key={`chart-${segKey++}`} raw={raw} />);
    cursor = match.index + match[0].length;
  }

  const trailing = text.slice(cursor);

  // 2) Trailing-Slice: kann offener Fence (Streaming) oder normaler Text sein.
  if (trailing) {
    const state = chartFenceState(trailing);
    if (state === "open") {
      // Inhalt bis zum Öffner normal rendern; alles ab dem Öffner → Platzhalter.
      const openerAt = trailing.search(CHART_OPEN_RE);
      const head = openerAt > 0 ? trailing.slice(0, openerAt) : "";
      if (head) nodes.push(renderTextSegment(head, `seg-${segKey++}`));
      nodes.push(
        <div key={`ph-${segKey++}`} className="chart-placeholder">
          Diagramm wird gerendert…
        </div>,
      );
    } else {
      nodes.push(renderTextSegment(trailing, `seg-${segKey++}`));
    }
  }

  return nodes;
}

// react-markdown custom components. Memoised at module scope so the
// component object is referentially stable across renders (cheap perf
// nicety — react-markdown re-walks the tree on every render anyway).
// v0.1.352 — robuste Erkennung interner Firmen-Links. Der Agent SOLL
// `company:<id>` schreiben (siehe prompts.ts), liefert aber in der
// Praxis auch andere Formate (`/companies/<id>`, `companies/<id>`,
// `#/companies/<id>`). Alle müssen über den SPA-<Link> laufen — NICHT
// über ein nacktes <a href>, sonst macht der Hash-Router eine harte
// Navigation, lädt index.html neu und der User landet wieder im Chat
// (Default-Route). Genau der gemeldete Bug.
// AVA-Company-ID-Form: GROSSBUCHSTABEN/Ziffern-Segmente per Unterstrich,
// endend auf eine Register-Nummer — z. B. `KEMPTENALLGAEU_HRA_325`,
// `ULM_HRB_721978`, `FULDA_HRA_1593`. Diente als letzter Fallback: liefert
// das Modell die ID NACKT als href (häufig bei schwächeren Modellen, v. a.
// in Tabellenzellen, statt `company:<id>`), erkennen wir sie trotzdem als
// Firmen-Link. http(s)-URLs / SPA-Pfade matchen hier nicht (enthalten
// `:` / `/` / Kleinbuchstaben), TransactionId-UUIDs auch nicht.
const BARE_COMPANY_ID = /^[A-Z0-9ÄÖÜ]+(?:_[A-Z0-9ÄÖÜ]+)*_\d+$/;

function extractCompanyId(target: string): string {
  if (/^company:/i.test(target)) {
    return target.replace(/^company:/i, "").trim();
  }
  const m = target.match(/^#?\/?companies\/([^/?#]+)/i);
  if (m && m[1]) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  if (BARE_COMPANY_ID.test(target)) {
    return target;
  }
  return "";
}

// Interner SPA-Pfad (z. B. `/transactions`, `#/meldungen`) → normalisiert
// auf einen führenden Slash, damit er per <Link> geroutet werden kann.
// Gibt null zurück, wenn es kein interner Pfad ist.
function toSpaPath(target: string): string | null {
  if (target.startsWith("#/")) return target.slice(1); // "#/x" -> "/x"
  if (target.startsWith("/")) return target; // "/x"
  return null;
}

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, ...rest }) {
    const target = typeof href === "string" ? href.trim() : "";

    // 1) Interner Firmen-Link (mehrere Formate) → SPA-Detailseite.
    const companyId = extractCompanyId(target);
    if (companyId) {
      return (
        <Link
          to={`/companies/${encodeURIComponent(companyId)}`}
          className="chat-company-link"
          title={`Firma ${companyId} öffnen`}
          // Phase 8.r4 — interest signal. CompanyDetail will also
          // ping on mount, but recording here too means the scheduler
          // sees the click even if the user never lands on the page.
          onClick={() => {
            void window.api.interest.record(companyId);
          }}
        >
          {children}
        </Link>
      );
    }

    // 1b) v0.1.390 — Lokale Datei (z. B. Import-Report) → im OS-Standard-
    //     programm öffnen. Form: `[Label](avafile:/abs/pfad.xlsx)`.
    if (/^avafile:/i.test(target)) {
      const filePath = target.replace(/^avafile:/i, "");
      return (
        <a
          href="#"
          className="chat-link"
          title={`Datei öffnen: ${filePath}`}
          onClick={(e) => {
            e.preventDefault();
            void window.api.shell.openPath(filePath);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    // 2) Externer http(s)-Link → im OS-Browser öffnen, niemals den
    //    hash-gerouteten Renderer navigieren (würde den Chat zerstören).
    if (/^https?:\/\//i.test(target)) {
      return (
        <a
          href={target}
          className="chat-link"
          onClick={(e) => {
            e.preventDefault();
            void window.api.shell.openExternal(target);
          }}
          {...rest}
        >
          {children}
        </a>
      );
    }

    // 3) Anderer interner SPA-Pfad (/foo oder #/foo) → per <Link>
    //    routen statt hart zu navigieren.
    const spaPath = toSpaPath(target);
    if (spaPath) {
      return (
        <Link to={spaPath} className="chat-link">
          {children}
        </Link>
      );
    }

    // 4) Unbekannter / leerer / nackter href → als Text-Link rendern,
    //    aber NIE hart navigieren (preventDefault). Sonst lädt der
    //    Browser index.html neu und der User landet wieder im Chat.
    return (
      <a
        href={target || undefined}
        className="chat-link"
        onClick={(e) => e.preventDefault()}
        {...rest}
      >
        {children}
      </a>
    );
  },
  code({ className, children, ...rest }) {
    // Belt-and-suspenders chart-fence catch. The pre-pass extractor in
    // `renderChatContent` already pulls complete ```chart fences out
    // before markdown ever sees the text; this branch only fires if a
    // chart fence somehow leaks through (regex drift, edge whitespace).
    if (className === "language-chart") {
      const raw = String(children ?? "").replace(/\n$/, "");
      return <ChartBlock raw={raw} />;
    }
    // Default behaviour — inline `code` or fenced block. react-markdown
    // hands us the inner text; styling is in styles.css.
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  },
};

function renderTextSegment(text: string, prefix: string): ReactNode {
  if (!text) return null;
  return (
    <ReactMarkdown
      key={prefix}
      components={MARKDOWN_COMPONENTS}
      remarkPlugins={[remarkGfm]}
    >
      {text}
    </ReactMarkdown>
  );
}

function roleLabel(role: AgentMessage["role"]): string {
  switch (role) {
    case "user":
      return "Du";
    case "assistant":
      return "AVA";
    case "tool":
      return "Werkzeug";
    case "system":
      return "System";
    default:
      return role;
  }
}

function ThinkingRow() {
  return (
    <div className="activity activity-running">
      <div className="activity-marker">
        <span className="activity-spinner" aria-hidden />
      </div>
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-thinking">denkt nach…</span>
        </div>
      </div>
    </div>
  );
}

// Chat-Fehlerzeile. Früher gab es hier einen Sonderfall für
// Anthropic-Abo-Auth-Fehler mit „neu autorisieren"-Button (OAuth) —
// das Claude-Abo wurde entfernt, daher zeigen wir Fehler jetzt schlicht
// an. Anthropic läuft nur noch per API-Key (in den Einstellungen).
function ChatErrorBanner({
  message,
}: {
  message: string;
  onCleared?: () => void;
}) {
  return <div className="chat-error">{message}</div>;
}

/**
 * v0.1.229 — Heuristik: war das Tool-Result ein Fehler?
 *
 * Konvention im Orchestrator (`runTool`):
 *   - Erfolg → `JSON.stringify(toolReturnValue)`
 *   - Fehler → `JSON.stringify({ error: "<message>" })`
 *
 * Wir parsen das tolerant. Wenn JSON valide ist und ein Top-Level
 * `error`-Key existiert (String), behandeln wir es als Fehler. Das
 * deckt auch den v0.1.227-Anti-Loop-Refuse-Fall ab, der dieselbe
 * Shape nutzt.
 *
 * Fallback für ältere Transcripts ohne JSON-Shape: schauen ob der
 * Text mit `error:` startet. Selten, aber sicher.
 */
function looksLikeToolError(content: string): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.error === "string" && parsed.error.length > 0) {
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  if (/^error:/i.test(trimmed)) return true;
  return false;
}
