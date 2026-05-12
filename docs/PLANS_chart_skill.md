# PLANS — Agent-Native Chart Rendering in Chat (v0.1.141)

Status: DESIGN ONLY. No code to be written from this document until it is reviewed and ratified. Intended target release: **v0.1.141**.

Companion file to `PLANS.md`. Once ratified, link this from `PLANS.md` as a new chapter "§5 — Agent-native charts".

---

## 0. Goal in one sentence

Give the AVA chat agent the ability to **autonomously** decide that a chart adds value, emit a tightly-validated chart spec inline in its reply, and have the renderer render it as crisp inline SVG — with **bulletproof fallbacks** so the user never sees a broken or empty chart.

User-stated invariants:
1. Agent picks WHEN, WHICH, and the spec — not the user.
2. "No broken graphs" is non-negotiable. Anything invalid falls back to a plain text table.

---

## 1. Design decisions (with rationale)

### 1.1 Chart-spec format → **Custom thin schema**

| Option | Verdict |
|---|---|
| Custom thin schema (yup-validated 10-field JSON) | **CHOSEN** |
| Vega-Lite via `vega-embed` | Rejected — ~250 KB dep, huge LLM surface to mess up, interaction-attack vectors |
| Chart.js via `react-chartjs-2` | Rejected — still 80 KB, still wide surface, no real win over a 6-kind subset |

**Why custom thin schema wins:**
- User invariant 2 explicitly says "no broken graphs". A narrow, fully enumerated schema is the only way to *prove* a spec is renderable before we mount it.
- Zero new runtime dep — we already render SVG in `BarChart` (`services/desktop/src/renderer/src/routes/CompanyDetail.tsx:883`) and have `yup` available for validation.
- The 6 supported chart kinds (bar, hbar, line, area, pie, scatter) cover every realistic AVA use case (financial-over-time, ranked-comparison, parts-of-whole, correlation).
- LLMs already produce this kind of JSON reliably when shown 2–3 examples — see Section 3.

### 1.2 Agent → renderer transport → **Fenced markdown block**

| Option | Verdict |
|---|---|
| Tool call `render_chart` → new `chart` UI-bridge frame | Rejected — orchestrator change, new frame type, complicates chat-history persistence |
| Inline ` ```chart … ``` ` fenced JSON in the assistant text | **CHOSEN** |

**Why fenced markdown wins:**
- Already routed through `renderChatContent` in `Chat.tsx` (line 2064). One react-markdown `code`-renderer override is all we need.
- Persists as plain text in chat history → exports and replays work for free.
- The streaming-ugly window (open fence, no close yet) is mitigated by a placeholder (Section 4 + 5).

### 1.3 Data flow

The agent already has JSON-returning tools (`company_profile`, `company_publications`, financial reports, etc.). The chart workflow is:

1. Agent calls one or more data-providing tools.
2. Agent shapes the JSON into a series spec (≤ 100 points per series, ≤ 5 series).
3. Agent emits a single ` ```chart ` fenced block in its reply at the position it wants the chart to appear.
4. Renderer parses → validates → renders SVG inline, or falls back to a text table.

**Hard rule:** the spec contains DATA inline. Tool references are forbidden in the spec. This keeps the renderer side-effect-free and offline-renderable from chat history.

For datasets > 100 points the agent must aggregate (sum-by-year, top-N, etc.) before emitting the chart.

---

## 2. Schema (yup)

File: `services/desktop/src/renderer/src/lib/chart-spec.ts` (new).

```ts
import * as yup from "yup";

export type ChartKind = "bar" | "hbar" | "line" | "area" | "pie" | "scatter";
export type ChartFormat = "eur" | "num" | "pct" | "date" | "shortdate";

const dataPoint = yup.object({
  x: yup.lazy((v) =>
    typeof v === "number"
      ? yup.number().required().test("finite", "x not finite", Number.isFinite)
      : yup.string().required().max(80),
  ),
  y: yup
    .number()
    .required()
    .test("finite", "y must be finite", (v) => Number.isFinite(v as number)),
}).noUnknown();

const series = yup.object({
  name: yup.string().required().max(40),
  data: yup.array().of(dataPoint).min(2).max(100).required(),
}).noUnknown();

export const chartSpecSchema = yup
  .object({
    kind: yup
      .mixed<ChartKind>()
      .oneOf(["bar", "hbar", "line", "area", "pie", "scatter"])
      .required(),
    title: yup.string().max(120).optional(),
    xLabel: yup.string().max(60).optional(),
    yLabel: yup.string().max(60).optional(),
    format: yup
      .mixed<ChartFormat>()
      .oneOf(["eur", "num", "pct", "date", "shortdate"])
      .default("num"),
    series: yup.array().of(series).min(1).max(5).required(),
    annotations: yup
      .array()
      .of(yup.object({ x: yup.mixed().required(), label: yup.string().required().max(40) }))
      .max(5)
      .optional(),
  })
  .noUnknown()
  .test("pie-one-series", "pie charts must have exactly one series", (v) =>
    v?.kind === "pie" ? v.series?.length === 1 : true,
  )
  .test("pie-segment-cap", "pie charts capped at 6 segments", (v) =>
    v?.kind === "pie" ? (v.series?.[0]?.data?.length ?? 0) <= 6 : true,
  )
  .test("scatter-x-numeric", "scatter x must be numeric", (v) =>
    v?.kind === "scatter"
      ? v.series?.every((s) => s.data?.every((p) => typeof p.x === "number"))
      : true,
  )
  .test("series-name-unique", "series names must be unique", (v) => {
    const names = (v?.series ?? []).map((s) => s.name);
    return new Set(names).size === names.length;
  });

export type ChartSpec = yup.InferType<typeof chartSpecSchema>;

export const MAX_SPEC_BYTES = 8 * 1024;

export function parseAndValidate(raw: string):
  | { ok: true; spec: ChartSpec }
  | { ok: false; reason: string; raw: string } {
  if (raw.length > MAX_SPEC_BYTES) return { ok: false, reason: "spec exceeds 8KB", raw };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `JSON parse: ${(e as Error).message}`, raw };
  }
  try {
    const spec = chartSpecSchema.validateSync(json, { abortEarly: true, strict: true });
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, raw };
  }
}
```

Key invariants enforced:
- `kind` is closed enum (6 values).
- 1–5 series, 2–100 points per series.
- All `y` values finite (no NaN/Infinity).
- pie: exactly 1 series, ≤ 6 segments.
- scatter: all `x` numeric.
- Unique series names.
- 8 KB hard cap on raw spec size (measured pre-parse, so bombs can't hide in strings).
- `noUnknown()` → unknown keys throw, preventing the LLM from sneaking in HTML, URLs, event handlers, etc.

---

## 3. System-prompt block (German)

Append to `services/desktop/src/main/agent/prompts.ts` under a new exported constant `CHART_INSTRUCTIONS` and include it in the main system prompt builder.

```
## Diagramme

Du kannst Diagramme direkt in deine Antwort einbetten, wenn Daten dadurch
deutlich besser verständlich werden. Diagramme sind KEIN Schmuck — nutze sie
nur, wenn sie echten Erkenntnisgewinn bringen.

### Wann ein Diagramm sinnvoll ist
- Finanzkennzahlen über mehrere Jahre (Umsatz, EBIT, Bilanzsumme …)
- Historische Verläufe (Mitarbeiterzahl, Veröffentlichungen pro Jahr …)
- Vergleiche von mindestens 3 vergleichbaren Einheiten (Top-N-Ranking)
- Anteile am Ganzen mit ≤ 6 Segmenten

### Wann KEIN Diagramm
- Weniger als 2 valide Datenpunkte → stattdessen Fließtext oder Tabelle
- Heterogene Daten ohne gemeinsame Achse
- Reine Aufzählungen ohne numerische Dimension
- Wenn du dir nicht 100 % sicher bist, dass jeder y-Wert aus einem Tool-Ergebnis stammt

### Welche Diagrammart
- `line` — Zeitreihe mit Trend (Jahre/Quartale auf x, Wert auf y)
- `area` — kumulative Zeitreihe
- `bar` — kategoriale Vergleichswerte (wenige Kategorien, horizontale x-Beschriftung)
- `hbar` — Rangliste / Top-N (Labels könnten lang sein)
- `pie` — Anteile am Ganzen, MAX 6 Segmente, GENAU eine Serie
- `scatter` — Korrelation zweier numerischer Größen

### Format (PFLICHT)
Emittiere das Diagramm als markdown-Codeblock mit Sprache `chart`. Inhalt ist
**ausschließlich** valides JSON nach folgendem Schema:

```chart
{
  "kind": "line",
  "title": "Umsatz Müller GmbH",
  "xLabel": "Jahr",
  "yLabel": "Umsatz",
  "format": "eur",
  "series": [
    { "name": "Umsatz",
      "data": [{"x":"2021","y":1240000},{"x":"2022","y":1410000},{"x":"2023","y":1605000}] }
  ]
}
```

### Harte Regeln
1. Alle y-Werte MÜSSEN aus tatsächlichen Tool-Ergebnissen kommen. Niemals
   Zahlen erfinden, schätzen oder interpolieren.
2. Mindestens 2 Datenpunkte pro Serie. Bei weniger → KEIN Diagramm, sondern
   normale Textantwort.
3. Maximal 5 Serien, maximal 100 Punkte pro Serie.
4. Spec MUSS self-contained sein — keine Verweise wie „siehe oben".
5. JSON MUSS gegen das Schema validieren. Bei Unsicherheit lieber Tabelle.
6. Maximal 3 Diagramme pro Antwort.
7. Lange Labels (> 16 Zeichen) bei `bar` vermeiden — nutze `hbar`.
8. Keine zusätzlichen Felder im JSON — alles Unbekannte wird abgelehnt.

### Beispiele

**Bar — Mitarbeiteranzahl im Jahresvergleich**

```chart
{
  "kind": "bar",
  "title": "Mitarbeiter Schmidt AG",
  "xLabel": "Jahr",
  "yLabel": "Anzahl",
  "format": "num",
  "series": [{ "name": "Mitarbeiter",
    "data": [{"x":"2020","y":42},{"x":"2021","y":48},{"x":"2022","y":61},{"x":"2023","y":74}] }]
}
```

**Line — Umsatz mit zwei Vergleichsserien**

```chart
{
  "kind": "line",
  "title": "Umsatzentwicklung",
  "format": "eur",
  "series": [
    { "name": "Müller GmbH",
      "data": [{"x":"2021","y":1240000},{"x":"2022","y":1410000},{"x":"2023","y":1605000}] },
    { "name": "Schmidt AG",
      "data": [{"x":"2021","y":890000},{"x":"2022","y":1020000},{"x":"2023","y":1180000}] }
  ]
}
```

**Hbar — Top-Veröffentlichungen pro Unternehmen**

```chart
{
  "kind": "hbar",
  "title": "Veröffentlichungen 2024 (Top 5)",
  "format": "num",
  "series": [{ "name": "Anzahl",
    "data": [
      {"x":"Müller GmbH","y":12},
      {"x":"Schmidt AG","y":9},
      {"x":"Weber KG","y":7},
      {"x":"Fischer GmbH","y":5},
      {"x":"Becker AG","y":4}
    ] }]
}
```
```

Word-budget for the prompt block: ~480 tokens. Justified — chart-emission needs explicit rails to be safe.

---

## 4. Renderer integration

### 4.1 New file: `services/desktop/src/renderer/src/components/ChatChart.tsx`

Responsibilities:
- Take a validated `ChartSpec`, render SVG.
- 6 kinds in one component (switch on `spec.kind`). Reuse layout primitives (axis renderer, gridline renderer, tooltip).
- Colours from CSS custom properties (`--color-brand-500`, `--color-cyan-600`, `--color-amber-500`, then 2 complementaries). Read via `getComputedStyle(document.documentElement).getPropertyValue(...)` so light/dark themes both work, mirroring the v0.1.135 audio-waveform fix.
- Responsive: `<svg viewBox>` with `width="100%"`. Container has `ResizeObserver` to recompute label-truncation thresholds when chat is in a narrow side-pane.
- Tooltip on hover (single `<div>` portalled into the chart container).
- Formatters:
  - `eur` → `new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 })`
  - `num` → `new Intl.NumberFormat("de-DE")`
  - `pct` → `new Intl.NumberFormat("de-DE", { style: "percent", maximumFractionDigits: 2 })`
  - `date` → `new Date(x).toLocaleDateString("de-DE")`
  - `shortdate` → `new Date(x).toLocaleDateString("de-DE", { month: "short", year: "2-digit" })`
- Label truncation at 16 chars with ellipsis + full label in tooltip.
- Wrapped in a renderer-side React `ErrorBoundary` (new helper `ChartErrorBoundary`) so a render-time exception (e.g. NaN slipping past validation) falls back to the raw spec block.

The existing `BarChart` in `CompanyDetail.tsx:883` is **not** reused — it's `div`-based with CSS bars and assumes a `{year, value}` shape. The new `ChatChart` lives next to chat. A later refactor can converge them; out of scope for v0.1.141.

### 4.2 Hook into react-markdown

In `services/desktop/src/renderer/src/routes/Chat.tsx`, `renderChatContent` already passes content through `react-markdown`. Add a `components.code` override:

```ts
code({ inline, className, children, ...rest }) {
  const lang = /language-(\w+)/.exec(className ?? "")?.[1];
  if (!inline && lang === "chart") {
    return <ChartBlock raw={String(children)} streamingIncomplete={false} />;
  }
  // existing default
  return <code className={className} {...rest}>{children}</code>;
}
```

`ChartBlock` does:
1. `parseAndValidate(raw)`.
2. If `ok`: render `<ChartErrorBoundary><ChatChart spec={spec} /></ChartErrorBoundary>`.
3. If not `ok`: render a fallback — a small `<div className="chart-fallback">` containing:
   - A muted line `Diagramm-Spec ungültig — Rohdaten anzeigen`.
   - A `<pre>` with the raw JSON (so the user still sees the data).
   - Internally `console.warn` with the validation reason so we can spot patterns in dev.

### 4.3 Streaming-incomplete fences

In the bubble renderer (assistant streaming path), before we hand the buffer to react-markdown, scan for unmatched ` ```chart ` openers:

```ts
function chartFenceState(text: string): "complete" | "open" | "none" {
  const opens = [...text.matchAll(/```chart\b/g)].length;
  const closes = [...text.matchAll(/^```$/gm)].length;
  if (opens === 0) return "none";
  return closes >= opens ? "complete" : "open";
}
```

When the streaming buffer is in state `open`, we replace the trailing partial fence with a placeholder `<div class="chart-placeholder">Diagramm wird gerendert …</div>` before passing to markdown. Once the close arrives we render normally on the next frame.

This avoids the "ugly half-JSON" window described in §1.2.

### 4.4 CSS (additions to chat stylesheet)

```css
.chat-chart { width: 100%; margin: 0.75rem 0; }
.chat-chart svg { display: block; width: 100%; height: auto; }
.chart-fallback { border: 1px dashed var(--color-border-muted); padding: 0.5rem; border-radius: 6px; }
.chart-fallback .hint { font-size: 12px; color: var(--color-text-muted); margin-bottom: 0.25rem; }
.chart-placeholder { font-size: 12px; color: var(--color-text-muted); padding: 0.5rem; }
```

---

## 5. Anti-broken-chart safeguards (defence in depth)

1. **Schema validation pre-render** — `parseAndValidate` is the only path to a mounted chart.
2. **Finite-number check** on every `y` (and on numeric `x` for scatter) — NaN/Infinity rejected.
3. **≥ 2 points per series** — single-point bar charts forbidden by `min(2)`.
4. **Series-name uniqueness** test.
5. **Pie: exactly one series, ≤ 6 segments** test.
6. **Caps**: 5 series, 100 points/series, 8 KB raw spec, 3 charts per assistant turn (count fences in markdown post-process; extras drop to fallback).
7. **`noUnknown()`** — unknown JSON keys reject the spec, blocking XSS/HTML smuggling.
8. **Streaming-fence detection** — half-streamed fences render as placeholder, never as broken chart.
9. **React `ErrorBoundary`** around `ChatChart` — any render-time throw falls back to raw-spec view.
10. **Honest-numbers prompt rule** (Section 3, rule 1) — only defence against fabricated values; renderer can't detect this.
11. **Label truncation** at 16 chars with full label in tooltip → no axis overflow.
12. **Always-fallback to readable JSON** — invalid specs never render as nothing; user always sees the data.

---

## 6. Implementation phasing

| Phase | Scope | Hours |
|---|---|---|
| **C1** | `chart-spec.ts` (schema + `parseAndValidate`) + `ChatChart.tsx` (generic SVG, 6 kinds) + `ChartBlock` markdown integration + `ChartErrorBoundary` + fallback rendering | 4–6 |
| **C2** | `CHART_INSTRUCTIONS` prompt block + wiring into `prompts.ts` + 3 starter examples | 1–2 |
| **C3** | Streaming-fence detection (`chartFenceState`) + placeholder rendering | 2 |
| **C4** | Test script `scripts/test-chart-spec.mjs`: 12 fixtures (6 valid, 6 invalid) against `parseAndValidate`. Assert each outcome. Hook into `pnpm -F @ava/desktop test`. | 1–2 |
| **C5** | `CHANGELOG.md` entry, `PLANS.md` §5 chapter pointer, `TOOLS.md` regenerate (no tool change but agent prompt changed → re-run `tools:doc`) | 1 |

**Total: 9–13 h. Single release v0.1.141.**

---

## 7. Stretch goals (NOT in v1)

- Pan/zoom interactions
- Per-chart "Export PNG" button (headless render to data URL)
- Side-by-side small-multiples
- Catalogue of chart presets the agent can pick by name
- Per-user chart-style preferences (colours, line thickness)
- Skill-system integration — a `finanz-diagramm` skill bundling a company-financials workflow
- Refactor `CompanyDetail.tsx:883` `BarChart` to also use `ChatChart`
- IntersectionObserver-based lazy render for very long chat histories

---

## 8. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | LLM fabricates numbers | Strict prompt rule (Section 3 rule 1); only-from-tool-results emphasised; renderer cannot detect this |
| R2 | Chart unreadable in dark mode | `getComputedStyle` + CSS custom properties for all colours; no hard-coded hex |
| R3 | Spec exceeds 8 KB and fence parsing degrades | Hard 8 KB cap pre-parse; prompt instructs to aggregate; fallback to JSON pre |
| R4 | Long axis labels overflow | 16-char truncate with ellipsis + tooltip; `hbar` recommendation for long labels in prompt |
| R5 | Multiple charts in one turn | Allowed up to 3; over the cap → drop extras to fallback |
| R6 | Streaming half-rendered fence | `chartFenceState` detection + placeholder |
| R7 | Chat-history export to PDF loses chart | Documented gap; PNG export is stretch goal C7-stretch |
| R8 | Performance regression with many charts in chat history | Each `ChatChart` is pure SVG, ~5 KB DOM; lazy-render via IntersectionObserver if profiling shows pain (stretch) |
| R9 | Renderer throws on edge-case data (e.g. all-zero series) | `ChartErrorBoundary` falls back to raw spec |
| R10 | Schema evolves and old chat history breaks | `parseAndValidate` failure already falls back to JSON pre — no regression visible to user; consider `schemaVersion` field in v2 |

---

## 9. Open questions for the user

1. **Sticky vs. opt-in:** should charts always render inline, or should the user have to click "Diagramm anzeigen" to expand? (Recommendation: always render. Charts the agent emits are by definition useful.)
2. **CRM-data charts allowed?** May the agent chart deal-pipeline values, contact-frequency-per-month, etc., or restrict to company master-data fields only?
3. **Minimum-data sparsity threshold:** at how many data points does a chart start to look too sparse to bother? Current proposal: 2-point minimum, but maybe 3 for line/area where 2 points are just a straight segment.
4. **Export to PNG in v1 or defer?** Adds ~2 h to C1; users likely want this for board reports.
5. **Should `format: "eur"` always use de-DE locale, or honour the eventual i18n setting we're planning for v0.2.x?** Recommendation: hard-code de-DE for v1, revisit when i18n lands.
6. **Multi-currency:** is `format: "eur"` enough or do we need `currency: "EUR" | "USD" | "CHF"`? (Almost all AVA data is EUR; recommend defer.)

---

## 10. Files touched (planned, not yet)

New:
- `services/desktop/src/renderer/src/lib/chart-spec.ts`
- `services/desktop/src/renderer/src/components/ChatChart.tsx`
- `services/desktop/src/renderer/src/components/ChartBlock.tsx`
- `services/desktop/src/renderer/src/components/ChartErrorBoundary.tsx`
- `services/desktop/scripts/test-chart-spec.mjs`

Modified:
- `services/desktop/src/renderer/src/routes/Chat.tsx` (markdown `code` override, `chartFenceState` streaming guard, CSS class hooks)
- `services/desktop/src/main/agent/prompts.ts` (new `CHART_INSTRUCTIONS` constant, included in system-prompt builder)
- `services/desktop/src/renderer/src/styles/chat.css` (or equivalent — three new selectors per §4.4)
- `CHANGELOG.md`
- `PLANS.md` (link to §5)

Untouched:
- All agent tools — no tool changes needed (chart is a prompt-level capability, not a tool call).
- Orchestrator and UI bridge — no new frame type.
- Database, gateway, schemas — no persistence change.
