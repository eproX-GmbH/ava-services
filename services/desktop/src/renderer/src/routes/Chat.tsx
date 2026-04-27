import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChoiceOption,
  AgentMessage,
  AgentStatus,
  AgentStreamFrame,
} from "../../../shared/types";

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
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const conversationIdRef = useRef<string>(newConversationId());
  const activeRequestIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

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

  // Stream frames. We filter by requestId so a stale subscription from a
  // previous send can never poison the current turn.
  useEffect(() => {
    const unsub = window.api.agent.onStream((frame: AgentStreamFrame) => {
      if (frame.requestId !== activeRequestIdRef.current) return;

      // Any frame other than the very first heartbeat clears the "thinking"
      // state — once the agent is doing something visible we don't need a
      // separate spinner.
      setThinking(false);

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
        activeRequestIdRef.current = null;
      } else if (frame.kind === "error") {
        setError(frame.message);
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
          prev.map((m) =>
            m.choice?.choiceId === frame.choiceId
              ? { ...m, choice: { ...m.choice, answeredValue: frame.value } }
              : m,
          ),
        );
      } else if (frame.kind === "navigate") {
        navigate(frame.path);
      }
    });
    return unsub;
  }, [navigate]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, thinking]);

  const inFlight =
    activeRequestIdRef.current !== null || !!status?.inFlightRequestId;
  const canSend = useMemo(
    () => !!status?.ready && input.trim().length > 0 && !inFlight,
    [status?.ready, input, inFlight],
  );

  async function handleSend() {
    if (!canSend) return;
    const text = input.trim();
    setInput("");
    setError(null);
    const userId = `u-${Date.now().toString(36)}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", content: text },
    ]);
    setThinking(true);
    try {
      const { requestId } = await window.api.agent.send({
        conversationId: conversationIdRef.current,
        message: text,
      });
      activeRequestIdRef.current = requestId;
    } catch (err) {
      setThinking(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleAbort() {
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

  return (
    <div className="chat-route">
      <header className="chat-header">
        <h2>Chat</h2>
        <div className="chat-status muted">
          {status === null
            ? "loading…"
            : status.ready
              ? `ready · ${status.model}`
              : status.errorMessage
                ? `error: ${status.errorMessage}`
                : "waiting for Ollama…"}
        </div>
      </header>

      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="muted chat-empty">
            Ask AVA anything. The agent can search companies, fetch details,
            and walk you through the app.
          </div>
        )}
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
                <div className="chat-role">choose</div>
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
          return (
            <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
              <div className="chat-role">{m.role}</div>
              <div className="chat-content">
                {m.content}
                {m.pending && <span className="chat-cursor">▍</span>}
              </div>
            </div>
          );
        })}
        {thinking && <ThinkingRow />}
        {error && <div className="chat-error">{error}</div>}
      </div>

      <div className="chat-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={
            status?.ready
              ? "Type a message and press Enter…"
              : "Waiting for the local model to come up…"
          }
          rows={3}
          disabled={!status?.ready}
        />
        <div className="chat-actions">
          {inFlight ? (
            <button onClick={handleAbort} className="link">
              stop
            </button>
          ) : (
            <button onClick={() => void handleSend()} disabled={!canSend}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Inline components ----------------------------------------------------

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
              {open ? "hide args" : "args"}
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

function ThinkingRow() {
  return (
    <div className="activity activity-running">
      <div className="activity-marker">
        <span className="activity-spinner" aria-hidden />
      </div>
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-thinking">thinking…</span>
        </div>
      </div>
    </div>
  );
}
