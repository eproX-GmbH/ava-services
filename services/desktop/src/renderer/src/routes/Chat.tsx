import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "react-router-dom";
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
import { useOllamaStore } from "../store/ollama";
import { useVoiceStore } from "../store/voice";
import { useVoiceRecorder } from "../lib/recordVoice";
import {
  composePromptWithAttachments,
  formatBytes,
  isSupportedAttachment,
  parseAttachment,
  type SpreadsheetAttachment,
} from "../lib/attachment";
import type {
  AgentChoiceOption,
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
}

function newConversationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Compact one-line summary of tool args, capped to keep the timeline tidy. */
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
          const cur = out[idx]!;
          if (cur.activity) {
            out[idx] = {
              ...cur,
              activity: { ...cur.activity, preview: preview || undefined },
            };
          }
        }
        continue;
      }
      // system messages don't render.
    }
    return out;
  }, []);

  // Switch to a specific conversation: abort any in-flight turn,
  // load its transcript from disk, replay into UiMessages.
  const switchConversation = useCallback(
    async (id: string) => {
      if (activeRequestIdRef.current) {
        try {
          await window.api.agent.abort(activeRequestIdRef.current);
        } catch {
          /* best effort */
        }
        activeRequestIdRef.current = null;
      }
      setError(null);
      setThinking(false);
      setConversationId(id);
      try {
        const history = await window.api.agent.loadConversation(id);
        setMessages(replayConversation(history));
      } catch {
        setMessages([]);
      }
    },
    [replayConversation],
  );

  // Start a brand-new conversation. We don't persist it until the
  // first user message lands (the orchestrator's appendMessage path
  // does that), so the dropdown only shows it after the first send.
  const startNewConversation = useCallback(() => {
    if (activeRequestIdRef.current) {
      void window.api.agent.abort(activeRequestIdRef.current);
      activeRequestIdRef.current = null;
    }
    const id = newConversationId();
    setConversationId(id);
    setMessages([]);
    setError(null);
    setThinking(false);
  }, []);

  // Mount: list sessions, auto-load the most recent. If there are no
  // saved sessions, mint a fresh id so the textarea is immediately usable.
  useEffect(() => {
    let mounted = true;
    void (async () => {
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
      if (frame.requestId !== activeRequestIdRef.current) return;

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

  const inFlight =
    activeRequestIdRef.current !== null || !!status?.inFlightRequestId;
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
    const accepted = files.filter(isSupportedAttachment);
    const rejected = files.length - accepted.length;
    if (rejected > 0 && accepted.length === 0) {
      setError(
        `Nicht unterstützter Dateityp. Bitte .xlsx-, .xls-, .csv- oder .tsv-Dateien ablegen.`,
      );
      return;
    }
    if (rejected > 0) {
      setError(
        `${rejected} nicht unterstützte ${rejected === 1 ? "Datei" : "Dateien"} übersprungen.`,
      );
    } else {
      setError(null);
    }
    const parsed: SpreadsheetAttachment[] = [];
    for (const f of accepted) {
      try {
        parsed.push(await parseAttachment(f));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
    if (parsed.length > 0) {
      setAttachments((prev) => [...prev, ...parsed]);
    }
  }, []);

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
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragOver(false);
  }, []);

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
    setAttachments([]);
    setError(null);
    const userId = `u-${Date.now().toString(36)}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: visible },
    ]);
    setThinking(true);
    try {
      const { requestId } = await window.api.agent.send({
        conversationId: id,
        message: composed,
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
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAbort() {
    // Optimistic UI: stop the spinner immediately so the abort feels
    // instant, even before the backend's terminal `done`/`error`
    // frame lands. The frame still resets activeRequestIdRef and
    // marks any pending message as not-pending.
    setThinking(false);
    void window.api.agent.abort(activeRequestIdRef.current ?? undefined);
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
              placeholder={
                status?.ready
                  ? attachments.length > 0
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
              accept=".xlsx,.xls,.csv,.tsv"
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
                const picked = m.choice.answeredValue;
                return (
                  <div key={m.id} className="chat-msg chat-msg-choice">
                    <div className="chat-choice">
                      <div className="chat-choice-prompt">{m.choice.prompt}</div>
                      <div className="chat-choice-options">
                        {m.choice.options.map((opt) => {
                          const isPicked = picked === opt.value;
                          return (
                            <button
                              key={opt.value}
                              className={`chat-choice-option${isPicked ? " picked" : ""}`}
                              disabled={picked !== undefined}
                              onClick={() =>
                                handlePickChoice(m.choice!.choiceId, opt.value)
                              }
                            >
                              <span className="chat-choice-label">{opt.label}</span>
                              {opt.description && (
                                <span className="chat-choice-desc">
                                  {opt.description}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
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
              return (
                <div
                  key={m.id}
                  data-message-id={m.id}
                  className={`chat-msg chat-msg-${m.role}`}
                  aria-label={roleLabel(m.role)}
                >
                  <div className="chat-content">
                    {m.role === "user" ? (
                      <UserBubbleContent content={m.content} />
                    ) : (
                      renderChatContent(m.content)
                    )}
                    {m.pending && <span className="chat-cursor">▍</span>}
                  </div>
                </div>
              );
            })}
            {thinking && <ThinkingRow />}
            {error && <div className="chat-error">{error}</div>}
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
    const dotR = 1.4;
    const dotGap = 5;
    const trackY = cssHeight / 2;
    const trackColor = active
      ? "rgba(255, 255, 255, 0.28)"
      : "rgba(255, 255, 255, 0.16)";
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
    ctx.fillStyle = active ? "#ffffff" : "rgba(255, 255, 255, 0.55)";
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
        <div className="chat-choice-prompt">{props.prompt.prompt}</div>
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

function ActivityRow(props: {
  toolName: string;
  args: unknown;
  status: Activity["status"];
  preview?: string;
}) {
  const [open, setOpen] = useState(false);
  const argSummary = summarizeArgs(props.args);
  const hasArgs = argSummary.length > 0;
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
          {props.preview && (
            <span className="activity-preview">{props.preview}</span>
          )}
        </div>
        {hasArgs && open && <pre className="activity-args">{argSummary}</pre>}
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

// Minimal markdown-link renderer for chat bubbles. Two link forms
// are recognised:
//   `[Label](company:<companyId>)` → <Link to="/companies/:id">Label</Link>
//     The agent is instructed (see prompts.ts) to always wrap company
//     mentions in this form so the user can jump to the detail page.
//   `[Label](http://…)` / `[Label](https://…)`
//     → external <a target="_blank">. We don't open these in the same
//     window because the renderer is hash-routed and replacing location
//     would tear down the chat session.
//
// Everything else is plain text, including stray brackets that don't
// match either pattern. Newlines are preserved as <br />. We do NOT
// support full markdown (bold/italics/lists/headings) — the agent's
// output is conversational German prose; over-rendering invites edge
// cases. If we ever need richer formatting, swap this out for
// react-markdown with a custom anchor renderer.
const LINK_RE = /\[([^\]]+)\]\((company:[^)]+|https?:\/\/[^)\s]+)\)/g;

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

function renderChatContent(text: string): ReactNode {
  if (!text) return null;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  const pushText = (raw: string) => {
    if (!raw) return;
    // Preserve line breaks. A naive `whitespace: pre-wrap` on the
    // container would also work, but interleaving link nodes makes
    // that unreliable, so we split here.
    const parts = raw.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) nodes.push(<br key={`br-${key++}`} />);
      if (parts[i]) nodes.push(<span key={`t-${key++}`}>{parts[i]}</span>);
    }
  };

  // Reset regex state — `lastIndex` survives across invocations on
  // global regexes, which would skip matches on rerenders if shared.
  LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LINK_RE.exec(text)) !== null) {
    const whole = match[0];
    const label = match[1] ?? "";
    const target = match[2] ?? "";
    const start = match.index;
    pushText(text.slice(cursor, start));
    if (target.startsWith("company:")) {
      const companyId = target.slice("company:".length).trim();
      if (companyId) {
        nodes.push(
          <Link
            key={`co-${key++}`}
            to={`/companies/${encodeURIComponent(companyId)}`}
            className="chat-company-link"
            title={`Firma ${companyId} öffnen`}
            // Phase 8.r4 — interest signal. CompanyDetail will also
            // ping on mount, but recording here too means the scheduler
            // sees the click even if the user never lands on the page
            // (e.g. ⌘+click that opens elsewhere later).
            onClick={() => {
              void window.api.interest.record(companyId);
            }}
          >
            {label}
          </Link>,
        );
      } else {
        // Malformed `company:` link — fall back to literal text so the
        // user can at least see something went wrong, instead of a
        // silently-disappearing token.
        pushText(whole);
      }
    } else {
      nodes.push(
        <a
          key={`a-${key++}`}
          href={target}
          target="_blank"
          rel="noopener noreferrer"
          className="chat-link"
        >
          {label}
        </a>,
      );
    }
    cursor = start + whole.length;
  }
  pushText(text.slice(cursor));
  return nodes;
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
