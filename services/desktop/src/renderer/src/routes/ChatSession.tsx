import { useState, useRef, useEffect, useMemo, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";
import {
  SlashPalette,
  type SlashPaletteHandle,
} from "../components/chat/SlashPalette";

/** When the leading line still looks like the user is typing `/<name>`
 *  (i.e. no whitespace or newline after the slash word), open the
 *  palette. Once the user types a space the orchestrator is in charge
 *  of parsing args and the popover gets in the way. */
function detectSlashOpen(text: string): { open: boolean; query: string } {
  if (!text.startsWith("/")) return { open: false, query: "" };
  if (text.includes("\n")) return { open: false, query: "" };
  // `/foo ` (trailing space) means the user has committed the name —
  // close the palette. `/` and `/foo` keep it open.
  if (/^\/[^\s]*\s/.test(text)) return { open: false, query: "" };
  return { open: true, query: text.slice(1).toLowerCase() };
}

// W18 — send chat message + view history (W19 detail).
//
// Single-page chat: list messages newest-at-bottom, autoscroll on update,
// post a new question with the form. Polls every 5s while the page is open
// because chat completions are async upstream — the message lands first as
// `user`, then the assistant message appears once the LLM call finishes.

interface ChatMessage {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function ChatSession() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const messages = useQuery({
    queryKey: ["chat", sessionId, "messages"],
    queryFn: () =>
      gatewayFetch<Page<ChatMessage>>(`/v1/evaluations/chats/${sessionId}/messages`, {
        query: { page: 1, pageSize: 200 },
      }),
    enabled: !!sessionId,
    refetchInterval: 5_000,
  });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.data?.items.length]);

  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const paletteRef = useRef<SlashPaletteHandle | null>(null);
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const slash = useMemo(() => detectSlashOpen(question), [question]);
  const slashOpen = slash.open && !paletteDismissed;
  const send = useMutation({
    mutationFn: (q: string) =>
      gatewayFetch<unknown>(`/v1/evaluations/chats/${sessionId}/messages`, {
        method: "POST",
        body: { question: q },
      }),
    onSuccess: () => {
      setQuestion("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["chat", sessionId, "messages"] });
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    send.mutate(question.trim());
  }

  return (
    <section className="chat">
      <header className="ct-page-header">
        <p className="ct-page-header__eyebrow">Verlauf</p>
        <h2 className="ct-page-header__title">
          <span className="ct-gradient-text">Chat-Sitzung</span>{" "}
          <code style={{ fontWeight: 600, fontSize: "0.7em" }}>{sessionId?.slice(0, 8)}…</code>
        </h2>
      </header>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.isLoading && <p>Lädt…</p>}
        {messages.error && (
          <p className="error">{(messages.error as Error).message}</p>
        )}
        {messages.data?.items.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            <div className="msg-role muted">
              {m.role === "user" ? "Du" : "AVA"}
            </div>
            <div className="msg-body">
              {m.role === "user" ? renderUserContent(m.content) : m.content}
            </div>
          </div>
        ))}
      </div>
      <form
        onSubmit={onSubmit}
        className="chat-form"
        style={{ position: "relative" }}
      >
        <SlashPalette
          ref={paletteRef}
          open={slashOpen}
          query={slash.query}
          onSelect={(cmd) => {
            setQuestion("/" + cmd.name + " ");
            setPaletteDismissed(false);
            // Refocus + put caret at end after React flushes.
            setTimeout(() => {
              const el = textareaRef.current;
              if (el) {
                el.focus();
                const len = el.value.length;
                el.setSelectionRange(len, len);
              }
            }, 0);
          }}
          onClose={() => setPaletteDismissed(true)}
          anchorRef={textareaRef}
        />
        <textarea
          ref={textareaRef}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            setPaletteDismissed(false);
          }}
          rows={2}
          placeholder="Folgefrage stellen… (/ für Befehle)"
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                paletteRef.current?.moveDown();
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                paletteRef.current?.moveUp();
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                if (paletteRef.current?.select()) {
                  e.preventDefault();
                  return;
                }
                // No matches — fall through to default behaviour.
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setPaletteDismissed(true);
                return;
              }
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (question.trim()) send.mutate(question.trim());
            }
          }}
        />
        <button type="submit" className="primary" disabled={send.isPending || !question.trim()}>
          {send.isPending ? "Wird gesendet…" : "Senden (⌘↵)"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  );
}

// Recognise a leading slash-command on the first line of a user
// message and wrap it in a pill so the rendered bubble matches the
// composer's visual treatment. Only the first line is transformed.
const LEADING_SLASH_RE = /^\/([a-z][a-z0-9-]*)(\s|$)/;

function renderUserContent(content: string) {
  if (!content.startsWith("/")) return content;
  const newlineIdx = content.indexOf("\n");
  const firstLine = newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
  const rest = newlineIdx >= 0 ? content.slice(newlineIdx) : "";
  const match = LEADING_SLASH_RE.exec(firstLine);
  if (!match) return content;
  const name = match[1];
  const after = firstLine.slice(match[0].length);
  return (
    <>
      <span className="slash-cmd-pill">/{name}</span>
      {match[2] === " " ? "" : ""}
      {after}
      {rest}
    </>
  );
}
