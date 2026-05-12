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
export type ChartFormat = "eur" | "num" | "pct" | "date" | "shortdate";

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
    name: yup.string().required().max(40),
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
      .oneOf(["eur", "num", "pct", "date", "shortdate"])
      .default("num"),
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
    const spec = chartSpecSchema.validateSync(json, {
      abortEarly: true,
      strict: true,
    });
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, raw };
  }
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
