// C1 — Block-Wrapper für eine ```chart-Fence im Chat.
//
// Verantwortlich für:
//   1. parseAndValidate auf der rohen Spec.
//   2. Fallback-Anzeige (Roh-JSON in <pre>) bei Schema-Fehler.
//   3. Mounten von `ChatChart` innerhalb der `ChartErrorBoundary`.

import { parseAndValidate } from "../lib/chart-spec";
import { ChatChart } from "./ChatChart";
import { ChartErrorBoundary } from "./ChartErrorBoundary";

function Fallback({
  raw,
  reason,
  friendly,
}: {
  raw: string;
  reason: string;
  friendly: string;
}) {
  return (
    <div className="chart-fallback">
      <div className="hint">Das Diagramm konnte nicht angezeigt werden: {friendly}</div>
      <details className="chart-fallback-details">
        <summary>Technische Details &amp; Rohdaten</summary>
        <div className="hint-tech">{reason}</div>
        <pre>{raw}</pre>
      </details>
    </div>
  );
}

export function ChartBlock({ raw }: { raw: string }) {
  const result = parseAndValidate(raw);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn("[chart] Spec-Validierung fehlgeschlagen:", result.reason);
    return <Fallback raw={raw} reason={result.reason} friendly={result.friendly} />;
  }
  return (
    <ChartErrorBoundary
      fallback={
        <Fallback
          raw={raw}
          reason="Render-Time-Exception"
          friendly="Bei der Darstellung ist ein unerwarteter Fehler aufgetreten."
        />
      }
    >
      <ChatChart spec={result.spec} />
    </ChartErrorBoundary>
  );
}
