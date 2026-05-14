import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { gatewaySSE } from "../api/gateway";

// W4 — live transaction progress. Subscribes to the gateway SSE bridge and
// renders the per-row events as they arrive. This is the end-to-end smoke
// test for the §6 SSE bridge: if events show up here, the producer
// services → AMQP → gateway → renderer path is intact.
//
// v0.1.179 — also responsible for auto-restoring research skip-mode
// once the linked transaction settles. Two heuristics, both call
// `endSkipModeForTransaction(id)` (idempotent):
//   1. On 5-minute idle (no SSE events for 5min) — the transaction
//      has either completed or stalled hard enough that holding the
//      skip-mode no longer makes sense.
//   2. On component unmount — user navigated away; assume they're
//      done watching this import. If the transaction is still running
//      research will run with the user's actual configured settings
//      from that moment forward, which is what they would expect.
// Backend tracks the snapshot in main/research/store.ts; if neither
// heuristic fires (app close mid-import), the user's saved config
// stays at off which is the fail-safe outcome (no surprise spending).
const SKIP_MODE_IDLE_RESTORE_MS = 5 * 60 * 1000;

interface Event {
  receivedAt: number;
  type: string;
  data: unknown;
}

export function TransactionStream() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Idle-timer ref so we can reset on every new event without
  // dropping/recreating the effect.
  const idleTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!id) return;
    const txId = id;
    setEvents([]);
    setError(null);

    function resetIdleTimer() {
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
      }
      idleTimerRef.current = window.setTimeout(() => {
        // No events for SKIP_MODE_IDLE_RESTORE_MS — assume the
        // transaction is done and release the skip-mode snapshot.
        void window.api.research.endSkipModeForTransaction(txId);
      }, SKIP_MODE_IDLE_RESTORE_MS);
    }

    resetIdleTimer();

    let stop: (() => void) | null = null;
    let cancelled = false;
    void gatewaySSE(
      `/v1/transactions/${id}/events`,
      (ev) => {
        setEvents((prev) => [...prev, { ...ev, receivedAt: Date.now() }]);
        resetIdleTimer();
      },
      () => setError("SSE-Verbindungsfehler (Auth oder Upstream); siehe DevTools-Netzwerk-Tab"),
    ).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
      if (idleTimerRef.current != null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      // User navigated away — release the skip-mode snapshot if one
      // is still pending for this tx-id. No-op when none is.
      void window.api.research.endSkipModeForTransaction(txId);
    };
  }, [id]);

  return (
    <section>
      <h2>Vorgangs-Live-Stream</h2>
      <p>
        Vorgang <code>{id}</code> · {events.length}{" "}
        {events.length === 1 ? "Event" : "Events"} empfangen
      </p>
      {error && <p className="error">{error}</p>}
      <ul className="event-log">
        {events.map((ev, i) => (
          <li key={i}>
            <strong>{ev.type}</strong>{" "}
            <span className="muted">
              {new Date(ev.receivedAt).toLocaleTimeString("de-DE")}
            </span>
            <pre>{JSON.stringify(ev.data, null, 2)}</pre>
          </li>
        ))}
      </ul>
    </section>
  );
}
