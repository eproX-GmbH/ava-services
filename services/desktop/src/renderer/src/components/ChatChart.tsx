// C1 — Reiner SVG-Renderer für die sechs Diagramm-Typen.
//
// Bewusst frei von Abhängigkeiten (kein Chart.js / Vega-Lite); reicht für
// das im Chat tatsächlich gewünschte Spektrum (Zeitreihen, Rankings,
// Anteile, Korrelation). Theme-Aware via CSS Custom Properties – siehe
// Audio-Waveform-Fix v0.1.135 für das Muster.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ChartSpec, ChartFormat, ChartKind } from "../lib/chart-spec";

const WIDTH = 640;
const HEIGHT = 320;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PAD_TOP = 32;
const PAD_BOTTOM = 44;

const PALETTE_VARS = [
  "--color-brand-500",
  "--color-cyan-600",
  "--color-amber-500",
  "--color-fg-muted",
  "--color-indigo-300",
] as const;

const PALETTE_FALLBACK = [
  "#00c0a7",
  "#0891b2",
  "#f59e0b",
  "#94a3b8",
  "#a5b4fc",
] as const;

function readPalette(): string[] {
  if (typeof window === "undefined") return [...PALETTE_FALLBACK];
  const root = document.documentElement;
  const styles = window.getComputedStyle(root);
  return PALETTE_VARS.map((v, i) => {
    const raw = styles.getPropertyValue(v).trim();
    return raw.length > 0 ? raw : PALETTE_FALLBACK[i] ?? "#00c0a7";
  });
}

function colorAt(palette: string[], index: number): string {
  return palette[index % palette.length] ?? PALETTE_FALLBACK[0];
}

function formatY(v: number, format: ChartFormat): string {
  switch (format) {
    case "eur":
      return new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
        maximumFractionDigits: 0,
      }).format(v);
    case "pct":
      return new Intl.NumberFormat("de-DE", {
        style: "percent",
        maximumFractionDigits: 2,
      }).format(v);
    case "num":
    default:
      return new Intl.NumberFormat("de-DE").format(v);
  }
}

function formatX(x: number | string, format: ChartFormat): string {
  if (typeof x === "number") {
    if (format === "date") {
      return new Date(x).toLocaleDateString("de-DE");
    }
    if (format === "shortdate") {
      return new Date(x).toLocaleDateString("de-DE", {
        month: "short",
        year: "2-digit",
      });
    }
    return new Intl.NumberFormat("de-DE").format(x);
  }
  return x;
}

function truncate(label: string, max = 16): string {
  if (label.length <= max) return label;
  return label.slice(0, max - 1) + "…";
}

type Hover = { x: number; y: number; label: string } | null;

export function ChatChart({ spec }: { spec: ChartSpec }) {
  const ref = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<string[]>(() => [...PALETTE_FALLBACK]);
  const [hover, setHover] = useState<Hover>(null);

  useEffect(() => {
    setPalette(readPalette());
  }, []);

  const title = spec.title;
  const format = (spec.format ?? "num") as ChartFormat;

  const body = useMemo(() => {
    return renderByKind(spec.kind as ChartKind, spec, palette, format, setHover);
  }, [spec, palette, format]);

  return (
    <div className="chat-chart" ref={ref} role="img" aria-label={title ?? "Diagramm"}>
      {title && <div className="chat-chart-title">{title}</div>}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseLeave={() => setHover(null)}
      >
        {body}
      </svg>
      {spec.series.length > 1 && (
        <div className="chat-chart-legend">
          {spec.series.map((s, i) => (
            <span key={s.name} className="chat-chart-legend-item">
              <span
                className="chat-chart-legend-swatch"
                style={{ background: colorAt(palette, i) }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {hover && (
        <div
          className="chat-chart-tooltip"
          style={{ left: `${(hover.x / WIDTH) * 100}%`, top: `${(hover.y / HEIGHT) * 100}%` }}
        >
          {hover.label}
        </div>
      )}
    </div>
  );
}

function renderByKind(
  kind: ChartKind,
  spec: ChartSpec,
  palette: string[],
  format: ChartFormat,
  setHover: (h: Hover) => void,
) {
  switch (kind) {
    case "bar":
      return renderBar(spec, palette, format, setHover, false);
    case "hbar":
      return renderBar(spec, palette, format, setHover, true);
    case "line":
      return renderLineOrArea(spec, palette, format, setHover, false);
    case "area":
      return renderLineOrArea(spec, palette, format, setHover, true);
    case "pie":
      return renderPie(spec, palette, format, setHover);
    case "scatter":
      return renderScatter(spec, palette, format, setHover);
    default: {
      // TS-Exhaustiveness — sollte vom Schema verhindert werden.
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function yRange(spec: ChartSpec): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const s of spec.series) {
    for (const p of s.data) {
      const v = p.y as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    return min === 0
      ? { min: 0, max: 1 }
      : { min: Math.min(0, min), max: max + Math.abs(max) * 0.1 };
  }
  // Etwas Headroom oben.
  return { min: Math.min(0, min), max: max + (max - min) * 0.08 };
}

function gridlines(min: number, max: number, format: ChartFormat) {
  const lines: { y: number; label: string }[] = [];
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const v = min + ((max - min) * i) / steps;
    lines.push({ y: v, label: formatY(v, format) });
  }
  return lines;
}

function axisTextColor() {
  return "var(--color-fg-muted, #94a3b8)";
}

function gridColor() {
  return "var(--color-border, rgba(148,163,184,0.25))";
}

// ─── bar / hbar ───────────────────────────────────────────────────────

function renderBar(
  spec: ChartSpec,
  palette: string[],
  format: ChartFormat,
  setHover: (h: Hover) => void,
  horizontal: boolean,
) {
  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const { min, max } = yRange(spec);
  const seriesCount = spec.series.length;
  // x-Kategorien aus der ersten Serie ziehen; weitere Serien werden gruppiert
  const categories = (spec.series[0]?.data ?? []).map((p) => p.x);
  const gridLines = gridlines(min, max, format);

  if (!horizontal) {
    const groupW = innerW / categories.length;
    const barW = (groupW * 0.7) / seriesCount;
    return (
      <>
        {gridLines.map((g, i) => {
          const y =
            PAD_TOP + innerH - ((g.y - min) / (max - min || 1)) * innerH;
          return (
            <g key={`grid-${i}`}>
              <line
                x1={PAD_LEFT}
                x2={WIDTH - PAD_RIGHT}
                y1={y}
                y2={y}
                stroke={gridColor()}
                strokeWidth={1}
              />
              <text
                x={PAD_LEFT - 6}
                y={y + 4}
                fontSize={10}
                textAnchor="end"
                fill={axisTextColor()}
              >
                {g.label}
              </text>
            </g>
          );
        })}
        {spec.series.map((s, si) =>
          s.data.map((p, pi) => {
            const v = p.y as number;
            const h = ((v - min) / (max - min || 1)) * innerH;
            const x =
              PAD_LEFT +
              pi * groupW +
              (groupW * 0.15) +
              si * barW;
            const y = PAD_TOP + innerH - h;
            const label = `${s.name}: ${formatY(v, format)} (${formatX(p.x, format)})`;
            return (
              <rect
                key={`b-${si}-${pi}`}
                x={x}
                y={y}
                width={barW}
                height={Math.max(1, h)}
                fill={colorAt(palette, si)}
                onMouseEnter={() => setHover({ x: x + barW / 2, y, label })}
              />
            );
          }),
        )}
        {categories.map((c, ci) => {
          const cx = PAD_LEFT + ci * groupW + groupW / 2;
          return (
            <text
              key={`xl-${ci}`}
              x={cx}
              y={HEIGHT - PAD_BOTTOM + 16}
              fontSize={10}
              textAnchor="middle"
              fill={axisTextColor()}
            >
              {truncate(String(formatX(c, format)))}
            </text>
          );
        })}
      </>
    );
  }

  // Horizontale Balken (hbar): typisch ein-serielle Top-N-Listen.
  const rowH = innerH / categories.length;
  const barH = rowH * 0.65;
  return (
    <>
      {gridLines.map((g, i) => {
        const x =
          PAD_LEFT + ((g.y - min) / (max - min || 1)) * innerW;
        return (
          <g key={`vg-${i}`}>
            <line
              x1={x}
              x2={x}
              y1={PAD_TOP}
              y2={PAD_TOP + innerH}
              stroke={gridColor()}
              strokeWidth={1}
            />
            <text
              x={x}
              y={HEIGHT - PAD_BOTTOM + 16}
              fontSize={10}
              textAnchor="middle"
              fill={axisTextColor()}
            >
              {g.label}
            </text>
          </g>
        );
      })}
      {spec.series.map((s, si) =>
        s.data.map((p, pi) => {
          const v = p.y as number;
          const w = ((v - min) / (max - min || 1)) * innerW;
          const y =
            PAD_TOP + pi * rowH + (rowH - barH) / 2 + si * (barH / seriesCount);
          const x = PAD_LEFT;
          const label = `${formatX(p.x, format)}: ${formatY(v, format)}`;
          return (
            <rect
              key={`hb-${si}-${pi}`}
              x={x}
              y={y}
              width={Math.max(1, w)}
              height={barH / seriesCount}
              fill={colorAt(palette, si)}
              onMouseEnter={() => setHover({ x: x + w, y, label })}
            />
          );
        }),
      )}
      {categories.map((c, ci) => {
        const cy = PAD_TOP + ci * rowH + rowH / 2 + 4;
        return (
          <text
            key={`yl-${ci}`}
            x={PAD_LEFT - 6}
            y={cy}
            fontSize={10}
            textAnchor="end"
            fill={axisTextColor()}
          >
            {truncate(String(formatX(c, format)))}
          </text>
        );
      })}
    </>
  );
}

// ─── line / area ──────────────────────────────────────────────────────

function renderLineOrArea(
  spec: ChartSpec,
  palette: string[],
  format: ChartFormat,
  setHover: (h: Hover) => void,
  area: boolean,
) {
  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const { min, max } = yRange(spec);
  const gridLines = gridlines(min, max, format);
  // x-Achse: gemeinsame Kategorien aus erster Serie (Index-basiert).
  const categories = (spec.series[0]?.data ?? []).map((p) => p.x);
  const xCount = Math.max(1, categories.length - 1);

  return (
    <>
      {gridLines.map((g, i) => {
        const y =
          PAD_TOP + innerH - ((g.y - min) / (max - min || 1)) * innerH;
        return (
          <g key={`g-${i}`}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y}
              y2={y}
              stroke={gridColor()}
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 6}
              y={y + 4}
              fontSize={10}
              textAnchor="end"
              fill={axisTextColor()}
            >
              {g.label}
            </text>
          </g>
        );
      })}
      {spec.series.map((s, si) => {
        const color = colorAt(palette, si);
        const pts = s.data.map((p, pi) => {
          const x = PAD_LEFT + (pi / xCount) * innerW;
          const y =
            PAD_TOP +
            innerH -
            (((p.y as number) - min) / (max - min || 1)) * innerH;
          return { x, y, raw: p };
        });
        const pathLine = pts
          .map((pt, i) => `${i === 0 ? "M" : "L"}${pt.x},${pt.y}`)
          .join(" ");
        const last = pts[pts.length - 1];
        const first = pts[0];
        const areaPath =
          last && first
            ? pathLine +
              ` L${last.x},${PAD_TOP + innerH} L${first.x},${PAD_TOP + innerH} Z`
            : pathLine;
        return (
          <g key={`s-${si}`}>
            {area && (
              <path d={areaPath} fill={color} fillOpacity={0.2} stroke="none" />
            )}
            <path d={pathLine} fill="none" stroke={color} strokeWidth={2} />
            {pts.map((pt, pi) => (
              <circle
                key={`p-${si}-${pi}`}
                cx={pt.x}
                cy={pt.y}
                r={3}
                fill={color}
                onMouseEnter={() =>
                  setHover({
                    x: pt.x,
                    y: pt.y,
                    label: `${s.name}: ${formatY(pt.raw.y as number, format)} (${formatX(pt.raw.x, format)})`,
                  })
                }
              />
            ))}
          </g>
        );
      })}
      {categories.map((c, ci) => {
        const cx = PAD_LEFT + (ci / xCount) * innerW;
        return (
          <text
            key={`xc-${ci}`}
            x={cx}
            y={HEIGHT - PAD_BOTTOM + 16}
            fontSize={10}
            textAnchor="middle"
            fill={axisTextColor()}
          >
            {truncate(String(formatX(c, format)))}
          </text>
        );
      })}
    </>
  );
}

// ─── pie ──────────────────────────────────────────────────────────────

function renderPie(
  spec: ChartSpec,
  palette: string[],
  format: ChartFormat,
  setHover: (h: Hover) => void,
) {
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const r = Math.min(WIDTH, HEIGHT) / 2 - PAD_TOP;
  const data = spec.series[0]?.data ?? [];
  const total = data.reduce((acc, p) => acc + (p.y as number), 0);
  let start = -Math.PI / 2; // 12 Uhr
  return (
    <>
      {data.map((p, i) => {
        const v = p.y as number;
        const frac = total > 0 ? v / total : 0;
        const end = start + frac * Math.PI * 2;
        const large = end - start > Math.PI ? 1 : 0;
        const x1 = cx + Math.cos(start) * r;
        const y1 = cy + Math.sin(start) * r;
        const x2 = cx + Math.cos(end) * r;
        const y2 = cy + Math.sin(end) * r;
        const d = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
        const mid = (start + end) / 2;
        const labelX = cx + Math.cos(mid) * r * 0.6;
        const labelY = cy + Math.sin(mid) * r * 0.6;
        const segLabel = `${formatX(p.x, format)}: ${formatY(v, format)}`;
        start = end;
        return (
          <g key={`pie-${i}`}>
            <path
              d={d}
              fill={colorAt(palette, i)}
              onMouseEnter={() => setHover({ x: labelX, y: labelY, label: segLabel })}
            />
            <text
              x={labelX}
              y={labelY}
              fontSize={10}
              textAnchor="middle"
              fill="white"
              pointerEvents="none"
            >
              {truncate(String(formatX(p.x, format)), 12)}
            </text>
          </g>
        );
      })}
    </>
  );
}

// ─── scatter ──────────────────────────────────────────────────────────

function renderScatter(
  spec: ChartSpec,
  palette: string[],
  format: ChartFormat,
  setHover: (h: Hover) => void,
) {
  const innerW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const innerH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  let xMin = Infinity,
    xMax = -Infinity,
    yMin = Infinity,
    yMax = -Infinity;
  for (const s of spec.series) {
    for (const p of s.data) {
      const xv = p.x as number;
      const yv = p.y as number;
      if (xv < xMin) xMin = xv;
      if (xv > xMax) xMax = xv;
      if (yv < yMin) yMin = yv;
      if (yv > yMax) yMax = yv;
    }
  }
  if (!Number.isFinite(xMin)) {
    xMin = 0;
    xMax = 1;
  }
  if (xMin === xMax) xMax = xMin + 1;
  if (!Number.isFinite(yMin)) {
    yMin = 0;
    yMax = 1;
  }
  if (yMin === yMax) yMax = yMin + 1;

  const gridLines = gridlines(yMin, yMax, format);
  const xTicks = gridlines(xMin, xMax, "num");

  return (
    <>
      {gridLines.map((g, i) => {
        const y =
          PAD_TOP + innerH - ((g.y - yMin) / (yMax - yMin)) * innerH;
        return (
          <g key={`sg-${i}`}>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={y}
              y2={y}
              stroke={gridColor()}
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 6}
              y={y + 4}
              fontSize={10}
              textAnchor="end"
              fill={axisTextColor()}
            >
              {g.label}
            </text>
          </g>
        );
      })}
      {xTicks.map((g, i) => {
        const x = PAD_LEFT + ((g.y - xMin) / (xMax - xMin)) * innerW;
        return (
          <text
            key={`sx-${i}`}
            x={x}
            y={HEIGHT - PAD_BOTTOM + 16}
            fontSize={10}
            textAnchor="middle"
            fill={axisTextColor()}
          >
            {new Intl.NumberFormat("de-DE").format(g.y)}
          </text>
        );
      })}
      {spec.series.map((s, si) =>
        s.data.map((p, pi) => {
          const xv = p.x as number;
          const yv = p.y as number;
          const x = PAD_LEFT + ((xv - xMin) / (xMax - xMin)) * innerW;
          const y =
            PAD_TOP + innerH - ((yv - yMin) / (yMax - yMin)) * innerH;
          return (
            <circle
              key={`sc-${si}-${pi}`}
              cx={x}
              cy={y}
              r={4}
              fill={colorAt(palette, si)}
              fillOpacity={0.75}
              onMouseEnter={() =>
                setHover({
                  x,
                  y,
                  label: `${s.name}: (${new Intl.NumberFormat("de-DE").format(xv)}, ${formatY(yv, format)})`,
                })
              }
            />
          );
        }),
      )}
    </>
  );
}
