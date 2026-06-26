import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type {
  DailyTokenLimitStatus,
  LlmProviderKind,
  UsageDailyBucket,
} from "../../../../shared/types";
import { ChartBlock } from "../../components/ChartBlock";

// v0.1.210 — Settings → Verbrauch.
//
// Lokal-only, privat. Liest aus `window.api.usage.daily(days)` —
// PGlite im Mainprozess. Default-Zeitraum: 7 Tage.
//
// v0.1.245 — USD-Schätzung komplett entfernt. Sie war systematisch
// daneben (Faktor ~7 gegenüber dem echten OpenAI-Dashboard) und ohne
// die echten Abrechnungsgrundlagen der Provider (Prompt-Caching-
// Raten, Free-Tier-Toleranzen, etc.) nicht seriös zu rekonstruieren.
// Die Token-Schätzung bleibt — Token-Werte sind deterministisch und
// providerunabhängig nachvollziehbar.

type RangeOption = 7 | 30 | 90;

export function VerbrauchTab() {
  const qc = useQueryClient();
  const [rangeDays, setRangeDays] = useState<RangeOption>(7);

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
    () => buildStackedChartSpec(daily.data ?? []),
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

      <DailyLimitSetting />

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
          </div>

          <div className="verbrauch-tab__chart">
            {chartSpec ? (
              <ChartBlock raw={JSON.stringify(chartSpec)} />
            ) : (daily.data ?? []).length === 1 ? (
              // v0.1.215 — Edge-Case "frischer Tab, erst ein Tag
              // Daten": chart-spec verlangt mind. 2 Datenpunkte
              // (sonst ist ein Verlauf-Plot Unsinn). Wir zeigen die
              // Summary-Zahlen oben schon, hier nur kurz
              // erklärt, wann das Diagramm aufpoppt.
              <p className="muted">
                Erst ein Tag mit Daten erfasst — das Diagramm braucht
                mindestens zwei Tage, um eine Entwicklung zu zeigen.
                Sobald morgen die ersten Anfragen laufen, erscheint
                hier der Verlauf. Die Summe oben zählt schon mit.
              </p>
            ) : (
              <p className="muted">
                Noch keine Daten im gewählten Zeitraum. Schreib ein paar
                Nachrichten im Chat — die Aufzeichnung läuft automatisch.
              </p>
            )}
          </div>

          <TopModelsTable buckets={daily.data ?? []} />

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

// v0.1.405 — Konfigurierbares TAGES-Token-Limit (Chat + Agent zusammen).
// Standard: KEIN Limit. Numerisches Ganzzahl-Feld (keine Kommazahlen).
// Live-Status (heute verbraucht) kommt per Push aus dem Main-Prozess.
function DailyLimitSetting() {
  const qc = useQueryClient();
  const status = useQuery<DailyTokenLimitStatus>({
    queryKey: ["usage", "limitStatus"],
    queryFn: () => window.api.usage.limitStatus(),
    staleTime: 10_000,
  });

  // Eingabe-Puffer: leerer String = „kein Limit". Nur Ziffern erlaubt.
  const [draft, setDraft] = useState<string>("");
  const [touched, setTouched] = useState(false);

  // Server-Wert in den Puffer spiegeln, solange der Nutzer nicht tippt.
  useEffect(() => {
    if (touched) return;
    const lim = status.data?.limit ?? null;
    setDraft(lim === null ? "" : String(lim));
  }, [status.data?.limit, touched]);

  // Live-Push abonnieren: Banner-relevanter Status ändert sich nach jedem
  // Turn / jeder Limit-Änderung — Query-Cache aktualisieren.
  useEffect(() => {
    const unsub = window.api.usage.onDailyLimitStatus((s) => {
      qc.setQueryData(["usage", "limitStatus"], s);
    });
    return unsub;
  }, [qc]);

  const save = useMutation({
    mutationFn: (limit: number | null) => window.api.usage.setDailyLimit(limit),
    onSuccess: () => {
      setTouched(false);
      void qc.invalidateQueries({ queryKey: ["usage", "limitStatus"] });
    },
  });

  const parsed = draft.trim() === "" ? null : Number.parseInt(draft, 10);
  const valid = parsed === null || (Number.isInteger(parsed) && parsed > 0);
  const current = status.data?.limit ?? null;
  const usedToday = status.data?.usedToday ?? 0;
  const dirty = (current === null ? "" : String(current)) !== draft.trim();

  return (
    <section id="verbrauch-limit" className="verbrauch-tab__limit">
      <h4>Tägliches Token-Limit</h4>
      <p className="muted small">
        Gemeinsame Obergrenze für Chat und Agent pro Tag (zählt Input +
        Output + Cache, UTC-Tag). Standard: kein Limit. Die laufende Anfrage
        wird immer fertig — ist das Tageskontingent danach erreicht, pausiert
        AVA neue Anfragen, bis du das Limit erhöhst oder entfernst.
      </p>

      <div className="verbrauch-tab__limit-row">
        <input
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          placeholder="kein Limit"
          className="verbrauch-tab__limit-input"
          value={draft}
          onChange={(e) => {
            // Nur Ziffern — Kommazahlen / Minus / Exponent rausfiltern.
            const digits = e.target.value.replace(/[^\d]/g, "");
            setTouched(true);
            setDraft(digits);
          }}
          onKeyDown={(e) => {
            // Punkt/Komma/„e"/Vorzeichen hart blocken.
            if ([".", ",", "e", "E", "+", "-"].includes(e.key)) {
              e.preventDefault();
            }
          }}
        />
        <span className="muted small">Tokens / Tag</span>
        <button
          type="button"
          className="btn"
          disabled={!valid || !dirty || save.isPending}
          onClick={() => save.mutate(parsed)}
        >
          {save.isPending ? "Speichert…" : "Speichern"}
        </button>
        {current !== null && (
          <button
            type="button"
            className="link"
            disabled={save.isPending}
            onClick={() => {
              setTouched(false);
              save.mutate(null);
            }}
          >
            Limit entfernen
          </button>
        )}
      </div>

      {!valid && (
        <p className="error small">
          Bitte eine ganze positive Zahl eingeben (oder Feld leeren für „kein
          Limit").
        </p>
      )}

      <p className="muted small">
        {current === null ? (
          <>Aktuell kein Limit aktiv.</>
        ) : (
          <>
            Heute verbraucht:{" "}
            <strong>{usedToday.toLocaleString("de-DE")}</strong> von{" "}
            <strong>{current.toLocaleString("de-DE")}</strong> Tokens
            {status.data?.exceeded ? " — Limit erreicht, Anfragen pausiert." : "."}
          </>
        )}
      </p>
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
}

function summarize(buckets: UsageDailyBucket[]): DailySummary {
  let calls = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const b of buckets) {
    for (const m of b.byModel) {
      calls += m.calls;
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheReadTokens += m.cacheReadTokens;
      cacheWriteTokens += m.cacheWriteTokens;
    }
  }
  return { calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

/** Baut die Spec für den gestapelten Tages-Balken. Stapeln nach
 *  Modell (alle Modelle eines Tages addieren sich zu einem Balken).
 *
 *  v0.1.215 — Wir geben null zurück, wenn weniger als 2 Tage Daten da
 *  sind. Das chart-spec-Schema verlangt min(2) Datenpunkte pro Serie;
 *  vorher schlug die Validierung mit der rohen yup-Meldung
 *  "series[0].data field must have at least 2 items" durch — der
 *  Tab muss diesen Frühstand selbst abfangen und einen freundlichen
 *  Hinweis zeigen ("Erst ab dem zweiten Tag sinnvoll plottbar"). */
function buildStackedChartSpec(
  buckets: UsageDailyBucket[],
): Record<string, unknown> | null {
  if (buckets.length < 2) return null;

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

  const series = modelOrder.map((modelKey) => ({
    name: prettyModelLabel(modelKey),
    data: buckets.map((b) => {
      const entry = b.byModel.find(
        (m) => `${m.provider}:${m.model}` === modelKey,
      );
      const y = entry
        ? entry.inputTokens + entry.outputTokens + entry.cacheReadTokens + entry.cacheWriteTokens
        : 0;
      return { x: shortDay(b.day), y };
    }),
  }));

  return {
    kind: "bar",
    title: "Tokens pro Tag (gestapelt nach Modell)",
    xLabel: "Tag",
    yLabel: "Tokens",
    format: "int",
    stacked: true,
    series: series.slice(0, 5),
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

interface ModelRowAggregate {
  provider: LlmProviderKind;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function TopModelsTable({ buckets }: { buckets: UsageDailyBucket[] }) {
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
          });
        } else {
          cur.calls += m.calls;
          cur.inputTokens += m.inputTokens;
          cur.outputTokens += m.outputTokens;
          cur.cacheReadTokens += m.cacheReadTokens;
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
            <th>Tokens gesamt</th>
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
                {(
                  r.inputTokens +
                  r.outputTokens +
                  r.cacheReadTokens
                ).toLocaleString("de-DE")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
