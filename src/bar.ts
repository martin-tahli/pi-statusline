export type Rgb = [number, number, number];
export type ColorStops = readonly [Rgb, Rgb, Rgb];

export interface BarStyle {
  fill: (text: string, rgb: Rgb) => string;
  track: (text: string) => string;
}

export const DEFAULT_STOPS: ColorStops = [
  [92, 255, 170], // light neon green
  [255, 140, 32], // vivid orange
  [145, 0, 32], // deep blood red
];

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [0, 1, 2].map((channel) => Math.max(0, Math.round(a[channel] + (b[channel] - a[channel]) * t))) as Rgb;
}

export function usageColor(fraction: number, stops: ColorStops = DEFAULT_STOPS): Rgb {
  const value = Math.min(1, Math.max(0, fraction));
  if (value <= 0.6) return stops[0];
  if (value <= 0.85) return mix(stops[0], stops[1], (value - 0.6) / 0.25);
  return mix(stops[1], stops[2], (value - 0.85) / 0.15);
}

export function renderBar(fraction: number, width: number, style: BarStyle, stops: ColorStops = DEFAULT_STOPS): string {
  const value = Math.min(1, Math.max(0, fraction));
  const length = Math.max(2, Math.floor(width));
  const filled = Math.round(value * length);
  const line = filled === 0
    ? style.track(`╶${"─".repeat(length - 2)}╴`)
    : filled === length
      ? style.fill(`╺${"━".repeat(length - 2)}╸`, usageColor(value, stops))
      : style.fill(`╺${"━".repeat(filled - 1)}`, usageColor(value, stops))
        + style.track(`${"─".repeat(length - filled - 1)}╴`);

  return `${line} ${Math.round(value * 100)}%`;
}
