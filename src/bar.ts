export type BarLevel = "success" | "warning" | "error";
export type Rgb = [number, number, number];

export function barLevel(fraction: number): BarLevel {
  return fraction >= 0.9 ? "error" : fraction >= 0.75 ? "warning" : "success";
}

export interface BarStyle {
  fill: (text: string, rgb: Rgb) => string; // gradient-painted consumed cell
  track: (text: string) => string; // dim outline of the empty container
}

// "our colors" fallback when the theme's success/warning/error can't be read.
export const DEFAULT_STOPS: Rgb[] = [
  [46, 204, 113], // green
  [230, 145, 56], // orange
  [231, 76, 60], // red
];

// Constant-shape pill: ◖ + body + ◗. Thin heavy line filled, light line empty.
const CAP_LEFT = "◖";
const CAP_RIGHT = "◗";
const CELL_FILL = "━";
const CELL_EMPTY = "─";

// Linear interpolation across evenly-spaced rgb stops, t in [0, 1].
export function gradientAt(stops: Rgb[], t: number): Rgb {
  const clamped = Math.min(1, Math.max(0, t));
  const span = stops.length - 1;
  const pos = clamped * span;
  const i = Math.min(span - 1, Math.floor(pos));
  const f = pos - i;
  const [a, b] = [stops[i], stops[i + 1]];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f)) as Rgb;
}

// The bottle is always drawn full-length; usage only decides how much is filled.
export function renderBar(fraction: number, width: number, style: BarStyle, stops: Rgb[] = DEFAULT_STOPS): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const w = Math.max(1, width);
  const filled = Math.round(clamped * w);
  const colorAt = (i: number) => gradientAt(stops, w <= 1 ? clamped : i / (w - 1));

  const body = Array.from({ length: w }, (_, i) =>
    i < filled ? style.fill(CELL_FILL, colorAt(i)) : style.track(CELL_EMPTY),
  ).join("");
  const left = filled > 0 ? style.fill(CAP_LEFT, colorAt(0)) : style.track(CAP_LEFT);
  const right = filled >= w ? style.fill(CAP_RIGHT, colorAt(w - 1)) : style.track(CAP_RIGHT);

  return `${left}${body}${right} ${Math.round(clamped * 100)}%`;
}
