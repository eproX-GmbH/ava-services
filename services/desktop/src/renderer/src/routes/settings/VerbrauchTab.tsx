import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  LlmProviderKind,
  UsageDailyBucket,
} from "../../../../shared/types";
import { ChartBlock } from "../../components/ChartBlock";

// v0.1.210 — Settings → Verbrauch.
//
// Lokal-only, privat. Liest aus `window.api.usage.daily(days)` —
// PGlite im Mainprozess. Default-Einheit: Tokens (Nutzer-Entscheidung,
// USD-Schätzung ist sekundär). Default-Zeitraum: 7 Tage.
//
// Aktuell zeigen wir nur Chat-Calls — Producer-Capture kommt in P3
// (v0.1.211). Bis dahin steht ein dezenter Hinweis am Kopf, dass
// Hintergrund-Producer noch nicht erfasst werden.

type RangeOption = 7 | 30 | 90;
type Unit = "tokens" | "usd";

export function VerbrauchTab() {
  const qc = useQueryClient();
  const [rangeDays, setRangeDays] = useState<RangeOption>(7);
  const [unit, setUnit] = useState<Unit>("tokens");

  const daily = useQuery<UsageDailyBucket[]>({
    queryKey: ["usage", "daily", rangeDays],
    queryFn: () => window.api.usage.daily(rangeDays),
    staleTime: 30_000,
  });

  const purge = useMutation({
    mutationFn: () => window.api.usage.purgeAll(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["usage"] }),
  });

  const summary = useMemo(() => summarize(daily.data ?? []), [daily.data]);
  const chartSpec = useMemo(
    () => buildStackedChartSpec(daily.data ?? [], unit),
    [daily.data, unit],
  );
  const hasOAuthEvents = useMemo(
    () =>
      (daily.data ?? []).some((d) =>
        d.byModel.some(
          (m) => m.estimatedUsd === null && m.provider === "anthropic",
        ),
      ),
    [daily.data],
  );

  return (
    <section className="verbrauch-tab">
      <header className="verbrauch-tab__header">
        <h3>Token-Verbrauch</h3>
        <p className="muted">
          Lokale Aufzeichnung jeder LLM-Anfrage. Daten verlassen deine
          Maschine nicht. Aktuell werden nur Chat-Anfragen erfasst —
          Hintergrund-Aufgaben der Producer folgen im nächsten Update.
        </p>
      </header>

      <div className="verbrauch-tab__controls">
        <div className="verbrauch-tab__range">
          {([7, 30, 90] as const).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRangeDays(n)}
              className={
                "verbrauch-tab__pill" +
                (rangeDays === n ? " verbrauch-tab__pill--active" : "")
              }
            >
              {n} Tage
            </button>
          ))}
        </div>
        <div className="verbrauch-tab__unit">
          <button
            type="button"
            onClick={() => setUnit("tokens")}
            className={
              "verbrauch-tab__pill" +
              (unit === "tokens" ? " verbrauch-tab__pill--active" : "")
            }
          >
            Tokens
          </button>
          <button
            type="button"
            onClick={() => setUnit("usd")}
            className={
              "verbrauch-tab__pill" +
              (unit === "usd" ? " verbrauch-tab__pill--active" : "")
            }
          >
            USD (Schätzung)
          </button>
        </div>
      </div>

      {daily.isLoading && <p className="muted">Lädt…</p>}
      {daily.error && (
        <p className="error">
          Konnte Verbrauchsdaten nicht laden:{" "}
          {(daily.error as Error).message}
        </p>
      )}

      {!daily.isLoading && !daily.error && (
        <>
          <div className="verbrauch-tab__summary">
            <SummaryStat label="Anfragen" value={summary.calls.toLocaleString("de-DE")} />
            <SummaryStat
              label="Input-Tokens"
              value={summary.inputTokens.toLocaleString("de-DE")}
            />
            <SummaryStat
              label="Output-Tokens"
              value={summary.outputTokens.toLocaleString("de-DE")}
            />
            <SummaryStat
              label="Cache-Read"
              value={summary.cacheReadTokens.toLocaleString("de-DE")}
              hint="Anthropic Prompt-Caching"
            />
            <SummaryStat
              label="Kosten (Schätzung)"
              value={
                summary.estimatedUsd === null
                  ? "Im Abo enthalten"
                  : formatUsd(summary.estimatedUsd)
              }
              hint={
                summary.estimatedUsd === null
                  ? "Anthropic Pro/Max-Abo aktiv — keine API-Kosten"
                  : "Stand 2026-05; tatsächliche Abrechnung kann abweichen"
              }
            />
          </div>

          {hasOAuthEvents && (
            <div className="verbrauch-tab__oauth-note">
              ℹ️ Mindestens ein Anthropic-Call läuft über dein Pro/Max-Abo
              (OAuth). Diese Tokens zählen gegen dein Abo-Quota statt
              gegen API-Guthaben — daher keine USD-Schätzung.
            </div>
          )}

          <div className="verbrauch-tab__chart">
            {chartSpec ? (
              <ChartBlock raw={JSON.stringify(chartSpec)} />
            ) : (
              <p className="muted">
                Noch keine Daten im gewählten Zeitraum. Schreib ein paar
                Nachrichten im Chat — die Aufzeichnung läuft automatisch.
              </p>
            )}
          </div>

          <TopModelsTable buckets={daily.data ?? []} unit={unit} />

          <div className="verbrauch-tab__danger">
            <button
              type="button"
              className="link"
              onClick={() => {
                if (
                  window.confirm(
                    "Alle Verbrauchsdaten lokal löschen? Die Producer/CRM/Audit-Daten bleiben unberührt.",
                  )
                ) {
                  purge.mutate();
                }
              }}
              disabled={purge.isPending}
            >
              {purge.isPending
                ? "Lösche…"
                : "Verbrauchsdaten löschen"}
            </button>
            {purge.data && (
              <span className="muted small">
                {purge.data.removed} Einträge entfernt.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="verbrauch-tab__stat">
      <div className="verbrauch-tab__stat-label">{label}</div>
      <div className="verbrauch-tab__stat-value">{value}</div>
      {hint && <div className="verbrauch-tab__stat-hint">{hint}</div>}
    </div>
  );
}

interface DailySummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** null = wenigstens ein Anthropic-OAuth-Call dabei → USD nicht
   *  aussagekräftig. Wir setzen dann null statt 0, damit das UI
   *  „Im Abo enthalten" zeigen kann. */
  estimatedUsd: number | null;
}

function summarize(buckets: UsageDailyBucket[]): DailySummary {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let usd = 0;
  let oauthSeen = false;
  for (const b of buckets) {
    for (const m of b.byModel) {
      calls += m.calls;
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheReadTokens += m.cacheReadTokens;
      cacheWriteTokens += m.cacheWriteTokens;
      if (m.estimatedUsd === null) {
        oauthSeen = true;
      } else {
        usd += m.estimatedUsd;
      }
    }
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedUsd: oauthSeen && usd === 0 ? null : usd,
  };
}

/** Baut die Spec für den gestapelten Tages-Balken. Stapeln nach
 *  Modell (alle Modelle eines Tages addieren sich zu einem Balken). */
function buildStackedChartSpec(
  buckets: UsageDailyBucket[],
  unit: Unit,
): Record<string, unknown> | null {
  if (buckets.length === 0) return null;

  // Alle Modelle einsammeln (in Reihenfolge der ersten Sichtung →
  // stabile Farben über die Tage).
  const modelOrder: string[] = [];
  const seen = new Set<string>();
  for (const b of buckets) {
    for (const m of b.byModel) {
      const key = `${m.provider}:${m.model}`;
      if (!seen.has(key)) {
        seen.add(key);
        modelOrder.push(key);
      }
    }
  }
  if (modelOrder.length === 0) return null;

  // Pro Modell eine Serie mit einem Datenpunkt pro Tag (0 wenn Modell
  // an dem Tag nicht aktiv war — Stack-Renderer überspringt 0).
  const series = modelOrder.map((modelKey) => ({
    name: prettyModelLabel(modelKey),
    data: buckets.map((b) => {
      const entry = b.byModel.find(
        (m) => `${m.provider}:${m.model}` === modelKey,
      );
      const y = entry
        ? unit === "tokens"
          ? entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
          : entry.estimatedUsd ?? 0
        : 0;
      return { x: shortDay(b.day), y };
    }),
  }));

  return {
    kind: "bar",
    title:
      unit === "tokens"
        ? "Tokens pro Tag (gestapelt nach Modell)"
        : "USD pro Tag (Schätzung, gestapelt nach Modell)",
    xLabel: "Tag",
    yLabel: unit === "tokens" ? "Tokens" : "USD",
    format: unit === "tokens" ? "int" : "eur",
    stacked: true,
    series: series.slice(0, 5), // chart-spec max 5 Serien
  };
}

function shortDay(isoDay: string): string {
  // "2026-05-18" → "18.05."
  const m = isoDay.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDay;
  return `${m[3]}.${m[2]}.`;
}

function prettyModelLabel(modelKey: string): string {
  const [provider, model] = modelKey.split(":");
  if (!provider || !model) return modelKey;
  // Anthropic-Datum-Suffixe wegblenden: claude-sonnet-4-5-20250929 → claude-sonnet-4-5
  const trimmed = model.replace(/-\d{8}$/, "");
  const providerShort: Record<string, string> = {
    anthropic: "Anthropic",
    openai: "OpenAI",
    google: "Google",
    mistral: "Mistral",
    ollama: "Ollama",
  };
  return `${providerShort[provider] ?? provider} · ${trimmed}`;
}

function formatUsd(v: number): string {
  if (v < 0.01) return `<$0,01`;
  return v.toLocaleString("de-DE", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

interface ModelRowAggregate {
  provider: LlmProviderKind;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedUsd: number | null;
}

function TopModelsTable({
  buckets,
  unit,
}: {
  buckets: UsageDailyBucket[];
  unit: Unit;
}) {
  const rows = useMemo<ModelRowAggregate[]>(() => {
    const map = new Map<string, ModelRowAggregate>();
    for (const b of buckets) {
      for (const m of b.byModel) {
        const key = `${m.provider}:${m.model}`;
        const cur = map.get(key);
        if (!cur) {
          map.set(key, {
            provider: m.provider,
            model: m.model,
            calls: m.calls,
            inputTokens: m.inputTokens,
            outputTokens: m.outputTokens,
            cacheReadTokens: m.cacheReadTokens,
            estimatedUsd: m.estimatedUsd,
          });
        } else {
          cur.calls += m.calls;
          cur.inputTokens += m.inputTokens;
          cur.outputTokens += m.outputTokens;
          cur.cacheReadTokens += m.cacheReadTokens;
          if (cur.estimatedUsd === null || m.estimatedUsd === null) {
            cur.estimatedUsd = null;
          } else {
            cur.estimatedUsd += m.estimatedUsd;
          }
        }
      }
    }
    return Array.from(map.values()).sort((a, b) => {
      const at = a.inputTokens + a.outputTokens;
      const bt = b.inputTokens + b.outputTokens;
      return bt - at;
    });
  }, [buckets]);

  if (rows.length === 0) return null;
  return (
    <div className="verbrauch-tab__table-wrap">
      <h4>Modelle im Zeitraum</h4>
      <table className="verbrauch-tab__table">
        <thead>
          <tr>
            <th>Modell</th>
            <th>Anfragen</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cache-Read</th>
            <th>{unit === "tokens" ? "Tokens gesamt" : "USD (Schätzung)"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.provider}:${r.model}`}>
              <td>{prettyModelLabel(`${r.provider}:${r.model}`)}</td>
              <td>{r.calls.toLocaleString("de-DE")}</td>
              <td>{r.inputTokens.toLocaleString("de-DE")}</td>
              <td>{r.outputTokens.toLocaleString("de-DE")}</td>
              <td>{r.cacheReadTokens.toLocaleString("de-DE")}</td>
              <td>
                {unit === "tokens"
                  ? (
                      r.inputTokens +
                      r.outputTokens +
                      r.cacheReadTokens
                    ).toLocaleString("de-DE")
                  : r.estimatedUsd === null
                    ? "Abo"
                    : formatUsd(r.estimatedUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
