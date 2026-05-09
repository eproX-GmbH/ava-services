import { useState, useRef, useEffect, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

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
            <div className="msg-body">{m.content}</div>
          </div>
        ))}
      </div>
      <form onSubmit={onSubmit} className="chat-form">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          placeholder="Folgefrage stellen…"
          onKeyDown={(e) => {
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
