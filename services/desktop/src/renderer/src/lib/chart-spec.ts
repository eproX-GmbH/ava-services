// C1 — Chart-Spec-Schema + Streaming-Fence-Helper.
//
// Definiert das vom Agent emittierbare Diagramm-JSON, validiert es per
// `yup` und liefert den Streaming-Fence-State, mit dem `renderChatContent`
// halb-geschriebene ```chart-Blöcke als Platzhalter rendert, statt sie als
// kaputtes Diagramm zu zeigen.
//
// Siehe `PLANS_chart_skill.md` §2 + §4.3 für das Design.

import * as yup from "yup";

export type ChartKind = "bar" | "hbar" | "line" | "area" | "pie" | "scatter";
// v0.1.207 — `int` is the discrete-count format. Same display as `num`
// but the renderer forces integer-only Y-axis ticks (no "81,52" /
// "163,04" labels on an employee-count chart). The LLM is instructed
// to pick it for whole-number quantities (Mitarbeiter, Stellenanzeigen,
// Publikationen, …) where a fractional axis is nonsensical. Renderer
// also auto-detects integer-only data when `num` is specified, so old
// specs still display reasonably.
export type ChartFormat =
  | "eur"
  | "num"
  | "int"
  | "pct"
  | "date"
  | "shortdate";

/** Hartes Limit auf die rohe Spec-Größe (vor JSON.parse, damit Zip-Bombs
 *  im String-Inhalt nichts ausrichten können). */
export const MAX_SPEC_BYTES = 8 * 1024;

const dataPoint = yup
  .object({
    x: yup.lazy((v) =>
      typeof v === "number"
        ? yup
            .number()
            .required()
            .test("finite", "x muss endlich sein", (n) =>
              Number.isFinite(n as number),
            )
        : yup.string().required().max(80),
    ),
    y: yup
      .number()
      .required()
      .test("finite", "y muss endlich sein", (n) =>
        Number.isFinite(n as number),
      ),
  })
  .noUnknown();

const series = yup
  .object({
    name: yup.string().required().max(60),
    data: yup.array().of(dataPoint).min(2).max(100).required(),
  })
  .noUnknown();

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
      .oneOf(["eur", "num", "int", "pct", "date", "shortdate"])
      .default("num"),
    // v0.1.210 — Stapelung für mehrere Serien. Default `false`
    // (alte Specs gruppieren weiter Side-by-side). Nur für `bar`
    // und `hbar` sinnvoll — andere Kinds ignorieren das Feld.
    // Verbrauchs-Tab nutzt das für „Tokens pro Tag, gestapelt
    // nach Modell".
    stacked: yup.boolean().default(false),
    series: yup.array().of(series).min(1).max(5).required(),
    annotations: yup
      .array()
      .of(
        yup
          .object({
            x: yup.mixed().required(),
            label: yup.string().required().max(40),
          })
          .noUnknown(),
      )
      .max(5)
      .optional(),
  })
  .noUnknown()
  .test(
    "pie-one-series",
    "pie-Diagramme müssen genau eine Serie haben",
    (v) => (v?.kind === "pie" ? v.series?.length === 1 : true),
  )
  .test(
    "pie-segment-cap",
    "pie-Diagramme dürfen maximal 6 Segmente haben",
    (v) =>
      v?.kind === "pie" ? (v.series?.[0]?.data?.length ?? 0) <= 6 : true,
  )
  .test(
    "scatter-x-numeric",
    "scatter-Diagramme brauchen numerische x-Werte",
    (v) =>
      v?.kind === "scatter"
        ? (v.series ?? []).every((s) =>
            (s?.data ?? []).every((p) => typeof p?.x === "number"),
          )
        : true,
  )
  .test("series-name-unique", "Serien-Namen müssen eindeutig sein", (v) => {
    const names = (v?.series ?? []).map((s) => s?.name ?? "");
    return new Set(names).size === names.length;
  });

export type ChartSpec = yup.InferType<typeof chartSpecSchema>;

export type ParseResult =
  | { ok: true; spec: ChartSpec }
  | { ok: false; reason: string; raw: string };

export function parseAndValidate(raw: string): ParseResult {
  if (raw.length > MAX_SPEC_BYTES) {
    return { ok: false, reason: "Spec überschreitet 8 KB", raw };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      reason: `JSON-Parse: ${(e as Error).message}`,
      raw,
    };
  }
  try {
    const spec = chartSpecSchema.validateSync(sanitizeSpec(json), {
      abortEarly: true,
      strict: true,
    });
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, raw };
  }
}

/**
 * v0.1.438 — Überlange Beschriftungen KAPPEN statt das ganze Diagramm zu
 * verwerfen. Ausloeser aus der Praxis: die Serie „Forderungen und sonstige
 * Vermögensgegenstände" (45 Zeichen) liess die komplette Spec am
 * 40-Zeichen-Limit scheitern — der Nutzer sah Rohdaten statt Diagramm.
 * Legitime deutsche (Bilanz-)Begriffe sprengen solche Limits leicht; ein
 * gekürzter Legendentext ist das kleinere Übel. Nur bekannte String-Felder
 * werden angefasst; alles andere prüft weiterhin das Schema.
 */
function sanitizeSpec(json: unknown): unknown {
  if (!json || typeof json !== "object" || Array.isArray(json)) return json;
  const clamp = (v: unknown, max: number): unknown =>
    typeof v === "string" && v.length > max ? `${v.slice(0, max - 1)}…` : v;

  const spec = { ...(json as Record<string, unknown>) };
  spec.title = clamp(spec.title, 120);
  spec.xLabel = clamp(spec.xLabel, 60);
  spec.yLabel = clamp(spec.yLabel, 60);
  if (Array.isArray(spec.series)) {
    spec.series = spec.series.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const e = { ...(entry as Record<string, unknown>) };
      e.name = clamp(e.name, 60);
      return e;
    });
  }
  if (Array.isArray(spec.annotations)) {
    spec.annotations = spec.annotations.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      const e = { ...(entry as Record<string, unknown>) };
      e.label = clamp(e.label, 40);
      return e;
    });
  }
  return spec;
}

/** Streaming-Fence-State.
 *
 *  Vom Bubble-Renderer aufgerufen, bevor wir die Tokenizer-Schleife laufen
 *  lassen. „open" → eine ```chart-Öffnung wurde geschrieben, aber noch
 *  nicht geschlossen → wir rendern bis zum Öffner normal und danach einen
 *  Platzhalter. „complete" → alle Fences sind geschlossen, normaler Pfad.
 *  „none" → es gibt gar keinen Chart-Fence im Text.
 */
export function chartFenceState(
  text: string,
): "complete" | "open" | "none" {
  const opens = [...text.matchAll(/```chart\b/g)].length;
  const closes = [...text.matchAll(/^```$/gm)].length;
  if (opens === 0) return "none";
  return closes >= opens ? "complete" : "open";
}
