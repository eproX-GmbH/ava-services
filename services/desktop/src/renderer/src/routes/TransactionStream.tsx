import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { gatewaySSE } from "../api/gateway";

// W4 — live transaction progress. Subscribes to the gateway SSE bridge and
// renders the per-row events as they arrive. This is the end-to-end smoke
// test for the §6 SSE bridge: if events show up here, the producer
// services → AMQP → gateway → renderer path is intact.

interface Event {
  receivedAt: number;
  type: string;
  data: unknown;
}

export function TransactionStream() {
  const { id } = useParams<{ id: string }>();
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setEvents([]);
    setError(null);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void gatewaySSE(
      `/v1/transactions/${id}/events`,
      (ev) => setEvents((prev) => [...prev, { ...ev, receivedAt: Date.now() }]),
      () => setError("SSE-Verbindungsfehler (Auth oder Upstream); siehe DevTools-Netzwerk-Tab"),
    ).then((teardown) => {
      if (cancelled) teardown();
      else stop = teardown;
    });
    return () => {
      cancelled = true;
      stop?.();
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
