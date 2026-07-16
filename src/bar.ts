export type BarLevel = "success" | "warning" | "error";

export function barLevel(fraction: number): BarLevel {
  return fraction >= 0.9 ? "error" : fraction >= 0.75 ? "warning" : "success";
}

export function renderBar(
  fraction: number,
  width = 8,
  styleFill: (text: string) => string = (text) => text,
): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  if (clamped === 0 || width <= 0) return `${Math.round(clamped * 100)}%`;

  const cells = clamped * width;
  const full = Math.floor(cells);
  const partial = full === width ? "" : "▏▎▍▌▋▊▉"[Math.ceil((cells - full) * 8) - 1] ?? "";
  return `${styleFill(`${"█".repeat(full)}${partial}`)} ${Math.round(clamped * 100)}%`;
}
