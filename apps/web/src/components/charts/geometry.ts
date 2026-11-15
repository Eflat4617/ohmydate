/**
 * Geometry of the hand-written SVG charts (HOLO-01). Pure numbers in, plain
 * coordinates out: no DOM, no chart library. Anything that is not a finite
 * number is "no data" and never becomes a mark.
 */

export type ChartValue = number | null | undefined;

function present(value: ChartValue): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface BarGeometry {
  /** Drawn height in px; 0 draws no bar (only the track). */
  readonly height: number;
  /** Top of the bar inside a plot of `plotHeight`. */
  readonly y: number;
  /** No data for this slot (null, undefined, NaN): the track is drawn dashed. */
  readonly missing: boolean;
}

/**
 * Bars of one set share one scale: the tallest value fills `plotHeight`. A
 * value above zero is never shorter than `minBar`, so a few minutes still
 * read as "something"; zero and missing draw no bar.
 */
export function barGeometry(values: readonly ChartValue[], plotHeight: number, minBar = 8): BarGeometry[] {
  const max = values.reduce<number>((top, value) => (present(value) && value > top ? value : top), 0);
  return values.map((value) => {
    if (!present(value)) return { height: 0, y: plotHeight, missing: true };
    if (value <= 0 || max <= 0) return { height: 0, y: plotHeight, missing: false };
    const height = Math.min(plotHeight, Math.max(minBar, (value / max) * plotHeight));
    return { height, y: plotHeight - height, missing: false };
  });
}

/** Centre of slot `index` of `count`, as a percentage of the plot's width. */
export function slotCenter(index: number, count: number): number {
  return count <= 0 ? 50 : ((index + 0.5) / count) * 100;
}

export interface RingArc {
  /** Index of the value this arc draws (zero and missing values have none). */
  readonly index: number;
  /** Degrees clockwise from twelve o'clock. */
  readonly start: number;
  readonly sweep: number;
}

/**
 * Arcs of a ring, clockwise from the top in the order given, with `gapDeg`
 * between neighbours. One value alone is a closed ring; values that are zero,
 * negative or missing take no arc.
 */
export function ringArcs(values: readonly ChartValue[], gapDeg = 10): RingArc[] {
  const parts = values
    .map((value, index) => ({ index, value: present(value) && value > 0 ? value : 0 }))
    .filter((part) => part.value > 0);
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (parts.length === 0 || total <= 0) return [];
  if (parts.length === 1) return [{ index: parts[0]?.index ?? 0, start: 0, sweep: 360 }];
  const gap = Math.max(0, Math.min(gapDeg, 360 / parts.length / 2));
  const available = 360 - gap * parts.length;
  let cursor = gap / 2;
  return parts.map((part) => {
    const sweep = (part.value / total) * available;
    const arc = { index: part.index, start: cursor, sweep };
    cursor += sweep + gap;
    return arc;
  });
}

export interface RingStroke {
  readonly index: number;
  /** `stroke-dasharray` of a circle of `radius`: the dash, then the rest of the circumference. */
  readonly dash: number;
  readonly rest: number;
  /** Rotation of the circle in degrees (0 = the dash starts at three o'clock). */
  readonly rotate: number;
}

/**
 * The arcs as dashes on circles with round caps. A round cap adds half the
 * stroke at each end, so the dash is shortened by one stroke width and moved
 * half a stroke along: the visible arc is the one asked for.
 */
export function ringStrokes(arcs: readonly RingArc[], radius: number, strokeWidth: number): RingStroke[] {
  const circumference = 2 * Math.PI * radius;
  const perDegree = circumference / 360;
  return arcs.map((arc) => {
    if (arc.sweep >= 360) return { index: arc.index, dash: circumference, rest: 0, rotate: -90 };
    const length = arc.sweep * perDegree;
    const dash = Math.max(0.01, length - strokeWidth);
    const lead = Math.min(strokeWidth, length) / 2 / perDegree;
    return { index: arc.index, dash, rest: circumference - dash, rotate: arc.start - 90 + lead };
  });
}

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Points of a trend line in a `width` × `height` box, left to right, missing
 * values dropped. The scale spans the values (and `reference`, when given) so
 * the line uses the box; equal values sit on the middle line. One value is one
 * point in the middle; none is an empty list.
 */
export function trendPoints(
  values: readonly ChartValue[],
  width: number,
  height: number,
  options: { readonly pad?: number; readonly reference?: number | null } = {},
): ChartPoint[] {
  const pad = options.pad ?? 6;
  const numbers = values.filter(present);
  if (numbers.length === 0) return [];
  const scale = scaleOf(numbers, options.reference);
  const yOf = (value: number): number =>
    scale.max === scale.min ? height / 2 : pad + (1 - (value - scale.min) / (scale.max - scale.min)) * (height - 2 * pad);
  if (numbers.length === 1) return [{ x: width / 2, y: yOf(numbers[0] ?? 0) }];
  return numbers.map((value, index) => ({ x: (index / (numbers.length - 1)) * width, y: yOf(value) }));
}

function scaleOf(numbers: readonly number[], reference: number | null | undefined): { min: number; max: number } {
  const all = typeof reference === 'number' && Number.isFinite(reference) ? [...numbers, reference] : numbers;
  return { min: Math.min(...all), max: Math.max(...all) };
}

/** Where a reference value sits on the same scale as `trendPoints` (null without data). */
export function referenceY(
  values: readonly ChartValue[],
  reference: number,
  height: number,
  pad = 6,
): number | null {
  const numbers = values.filter(present);
  if (numbers.length === 0 || !Number.isFinite(reference)) return null;
  const scale = scaleOf(numbers, reference);
  if (scale.max === scale.min) return height / 2;
  return pad + (1 - (reference - scale.min) / (scale.max - scale.min)) * (height - 2 * pad);
}

const round = (value: number): number => Math.round(value * 100) / 100;

export function linePath(points: readonly ChartPoint[]): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${round(point.x)} ${round(point.y)}`).join(' ');
}

/** The line closed down to the bottom of the box. */
export function areaPath(points: readonly ChartPoint[], height: number): string {
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined || points.length < 2) return '';
  return `${linePath(points)} L${round(last.x)} ${round(height)} L${round(first.x)} ${round(height)} Z`;
}

export interface RatioSpan {
  /** Where "as estimated" (1) stands on the scale, in % from the left. */
  readonly tick: number;
  /** The bar: from the mark toward the ratio (to the right when above 1, to the left when below). */
  readonly left: number;
  readonly width: number;
}

/**
 * A ratio against "as estimated" (HOLO-03A, AI 분석): the bar grows from the
 * mark at 1 toward the ratio on a scale from 0 to `max`, so longer-than-
 * estimated and shorter-than-estimated read as opposite directions. A ratio
 * beyond the scale stops at its edge; no ratio is no bar.
 */
export function ratioSpan(ratio: ChartValue, max: number): RatioSpan | null {
  if (!present(ratio)) return null;
  const top = present(max) && max > 1 ? max : 2;
  const tick = (1 / top) * 100;
  const position = (Math.min(top, Math.max(0, ratio)) / top) * 100;
  return { tick, left: Math.min(tick, position), width: Math.abs(position - tick) };
}
