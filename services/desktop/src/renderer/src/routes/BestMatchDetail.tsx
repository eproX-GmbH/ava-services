import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { gatewayFetch } from "../api/gateway";

// W15 (view best-match) + W16 (per-row feedback).
//
// Each row has its own thumbs/label control. POST /feedback writes a label
// against the *result* (bestMatchJobResultId), not the job — same as the
// upstream contract. We refetch the job after a feedback write so the
// matchFeedback blob updates inline.

const LABELS = ["ACCEPTED", "REJECTED", "NOTSURE", "IGNORED", "CONTACTED", "CLICKED"] as const;
type Label = (typeof LABELS)[number];

interface ResultItem {
  id: string;
  companyId?: string | null;
  explanation?: string | null;
  score?: number | null;
  matchFeedback?: { label?: string } | null;
}
interface BestMatch {
  id: string;
  input: string;
  transactionId?: string | null;
  results: ResultItem[];
  createdAt: string;
  updatedAt: string;
}

export function BestMatchDetail() {
  const { id } = useParams<{ id: string }>();
  const q = useQuery({
    queryKey: ["best-match", id],
    queryFn: () => gatewayFetch<BestMatch>(`/v1/evaluations/best-matches/${id}`),
    enabled: !!id,
  });

  return (
    <section>
      <h2>
        Best-match <code>{id?.slice(0, 8)}…</code>
      </h2>
      {q.isLoading && <p>Loading…</p>}
      {q.error && <p className="error">{(q.error as Error).message}</p>}
      {q.data && (
        <>
          <details>
            <summary>Input ({q.data.input.length} chars)</summary>
            <pre>{q.data.input}</pre>
          </details>

          <p className="muted">
            {q.data.results.length} result{q.data.results.length === 1 ? "" : "s"}
          </p>

          {q.data.results.length === 0 && <p className="muted">No results yet.</p>}
          {q.data.results.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Score</th>
                  <th>Explanation</th>
                  <th>Feedback</th>
                </tr>
              </thead>
              <tbody>
                {q.data.results.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.companyId ? (
                        <code>{r.companyId.slice(0, 12)}…</code>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{r.score?.toFixed(3) ?? "—"}</td>
                    <td>{r.explanation ?? <span className="muted">—</span>}</td>
                    <td>
                      <FeedbackPicker
                        bestMatchId={id!}
                        resultId={r.id}
                        current={(r.matchFeedback?.label as Label | undefined) ?? null}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}

function FeedbackPicker({
  bestMatchId,
  resultId,
  current,
}: {
  bestMatchId: string;
  resultId: string;
  current: Label | null;
}) {
  const qc = useQueryClient();
  const [picked, setPicked] = useState<Label | null>(current);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (label: Label) =>
      gatewayFetch<unknown>(`/v1/evaluations/best-matches/${bestMatchId}/feedback`, {
        method: "POST",
        body: { bestMatchJobResultId: resultId, label },
      }),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["best-match", bestMatchId] });
    },
    onError: (err) => setError((err as Error).message),
  });

  return (
    <div className="feedback">
      <select
        value={picked ?? ""}
        onChange={(e) => {
          const next = (e.target.value || null) as Label | null;
          setPicked(next);
          if (next) mut.mutate(next);
        }}
        disabled={mut.isPending}
      >
        <option value="">—</option>
        {LABELS.map((l) => (
          <option key={l} value={l}>
            {l}
          </option>
        ))}
      </select>
      {mut.isPending && <span className="muted"> saving…</span>}
      {error && <span className="error"> {error}</span>}
    </div>
  );
}
