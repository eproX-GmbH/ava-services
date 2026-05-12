// C1 — Block-Wrapper für eine ```chart-Fence im Chat.
//
// Verantwortlich für:
//   1. parseAndValidate auf der rohen Spec.
//   2. Fallback-Anzeige (Roh-JSON in <pre>) bei Schema-Fehler.
//   3. Mounten von `ChatChart` innerhalb der `ChartErrorBoundary`.

import { parseAndValidate } from "../lib/chart-spec";
import { ChatChart } from "./ChatChart";
import { ChartErrorBoundary } from "./ChartErrorBoundary";

function Fallback({ raw, reason }: { raw: string; reason: string }) {
  return (
    <div className="chart-fallback">
      <div className="hint">
        Diagramm-Spec ungültig — Rohdaten anzeigen ({reason})
      </div>
      <pre>{raw}</pre>
    </div>
  );
}

export function ChartBlock({ raw }: { raw: string }) {
  const result = parseAndValidate(raw);
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn("[chart] Spec-Validierung fehlgeschlagen:", result.reason);
    return <Fallback raw={raw} reason={result.reason} />;
  }
  return (
    <ChartErrorBoundary
      fallback={<Fallback raw={raw} reason="Render-Time-Exception" />}
    >
      <ChatChart spec={result.spec} />
    </ChartErrorBoundary>
  );
}
