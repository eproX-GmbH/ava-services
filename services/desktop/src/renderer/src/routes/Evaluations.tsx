import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

// W14 (launcher) + W15 (list) + W17 (start chat) + W19 (chat list).
//
// One page per transaction. The transactionId scopes everything below — the
// gateway's §4.3 reads filter best-matches and chat sessions by it, and the
// §5.2 writes for "start chat" / "submit best-match" need it (or company
// IDs scoped to it). Keeping this on one screen mirrors the analyst's
// mental model: pick a transaction, then explore its evaluations.

const TOPICS = [
  "keywords",
  "companyProfile",
  "businessPurpose",
  "serpCategory",
  "sales",
  "profits",
  "employees",
  "totalAssets",
  "stateOfAffairs",
] as const;
type Topic = (typeof TOPICS)[number];

interface BestMatch {
  id: string;
  input: string;
  transactionId?: string | null;
  createdAt: string;
}
interface ChatSession {
  id: string;
  transactionId: string;
  summary?: string | null;
  createdAt: string;
}
interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function Evaluations() {
  const { id: transactionId } = useParams<{ id: string }>();
  return (
    <section>
      <h2>
        Evaluations · transaction <code>{transactionId?.slice(0, 8)}…</code>
      </h2>

      <div className="grid-2">
        <BestMatchPanel transactionId={transactionId!} />
        <ChatPanel transactionId={transactionId!} />
      </div>
    </section>
  );
}

// ---- Best matches (W14 launcher + W15 list) -------------------------------

function BestMatchPanel({ transactionId }: { transactionId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["best-matches", transactionId],
    queryFn: () =>
      gatewayFetch<Page<BestMatch>>("/v1/evaluations/best-matches", {
        query: { transactionId, page: 1, pageSize: 50 },
      }),
  });

  return (
    <div className="panel">
      <h3>Best matches</h3>
      <BestMatchCreateForm
        transactionId={transactionId}
        onCreated={() => qc.invalidateQueries({ queryKey: ["best-matches", transactionId] })}
      />
      {list.isLoading && <p>Loading…</p>}
      {list.error && <p className="error">{(list.error as Error).message}</p>}
      {list.data && list.data.items.length === 0 && (
        <p className="muted">No best-match jobs yet.</p>
      )}
      {list.data && list.data.items.length > 0 && (
        <ul className="list">
          {list.data.items.map((m) => (
            <li key={m.id}>
              <Link to={`/evaluations/best-matches/${m.id}`}>
                <code>{m.id.slice(0, 8)}…</code>
              </Link>{" "}
              <span className="muted">{m.createdAt}</span>
              <div className="muted">
                {m.input.slice(0, 80)}
                {m.input.length > 80 ? "…" : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BestMatchCreateForm({
  transactionId,
  onCreated,
}: {
  transactionId: string;
  onCreated: () => void;
}) {
  const [input, setInput] = useState("");
  const [companyIdsCsv, setCompanyIdsCsv] = useState("");
  const [topics, setTopics] = useState<Topic[]>(["keywords", "companyProfile"]);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: (body: { input: string; companyIds: string[]; topics: Topic[] }) =>
      gatewayFetch<{ id: string }>("/v1/evaluations/best-matches", {
        method: "POST",
        body: { ...body, transactionId },
      }),
    onSuccess: () => {
      setInput("");
      setCompanyIdsCsv("");
      setError(null);
      onCreated();
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const companyIds = companyIdsCsv
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (companyIds.length < 2) {
      setError("Need at least 2 company IDs.");
      return;
    }
    if (topics.length === 0) {
      setError("Pick at least one topic.");
      return;
    }
    if (!input.trim()) {
      setError("Provide an offer / RFQ text.");
      return;
    }
    create.mutate({ input: input.trim(), companyIds, topics });
  }

  function toggleTopic(t: Topic) {
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  return (
    <form onSubmit={onSubmit} className="form compact">
      <label className="field">
        <span>Offer / RFQ text</span>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          placeholder="Paste the offer brief…"
        />
      </label>
      <label className="field">
        <span>Company IDs (comma or space separated, ≥ 2)</span>
        <input
          type="text"
          value={companyIdsCsv}
          onChange={(e) => setCompanyIdsCsv(e.target.value)}
          placeholder="abc123, def456"
        />
      </label>
      <div className="field">
        <span>Topics (≥ 1)</span>
        <div className="chips selectable">
          {TOPICS.map((t) => (
            <button
              key={t}
              type="button"
              className={`chip ${topics.includes(t) ? "active" : ""}`}
              onClick={() => toggleTopic(t)}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <button type="submit" className="primary" disabled={create.isPending}>
        {create.isPending ? "Submitting…" : "Run best-match"}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

// ---- Chat (W17 start + W19 list) -------------------------------------------

function ChatPanel({ transactionId }: { transactionId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ["chats", transactionId],
    queryFn: () =>
      gatewayFetch<Page<ChatSession>>("/v1/evaluations/chats", {
        query: { transactionId, page: 1, pageSize: 50 },
      }),
  });

  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (q: string) =>
      gatewayFetch<{ sessionId: string; messageId: string }>("/v1/evaluations/chats", {
        method: "POST",
        body: { transactionId, question: q },
      }),
    onSuccess: () => {
      setQuestion("");
      setError(null);
      qc.invalidateQueries({ queryKey: ["chats", transactionId] });
    },
    onError: (err) => setError((err as Error).message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    create.mutate(question.trim());
  }

  return (
    <div className="panel">
      <h3>Chat sessions</h3>
      <form onSubmit={onSubmit} className="form compact">
        <label className="field">
          <span>Start a session with a question</span>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder="What do these companies have in common?"
          />
        </label>
        <button type="submit" className="primary" disabled={create.isPending}>
          {create.isPending ? "Starting…" : "Start chat"}
        </button>
        {error && <p className="error">{error}</p>}
      </form>

      {list.isLoading && <p>Loading…</p>}
      {list.error && <p className="error">{(list.error as Error).message}</p>}
      {list.data && list.data.items.length === 0 && (
        <p className="muted">No chat sessions yet.</p>
      )}
      {list.data && list.data.items.length > 0 && (
        <ul className="list">
          {list.data.items.map((s) => (
            <li key={s.id}>
              <Link to={`/evaluations/chats/${s.id}`}>
                <code>{s.id.slice(0, 8)}…</code>
              </Link>{" "}
              <span className="muted">{s.createdAt}</span>
              {s.summary && <div className="muted">{s.summary}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
