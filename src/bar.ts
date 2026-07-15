export function renderBar(
  fraction: number,
  width = 8,
  styleFill: (text: string) => string = (text) => text,
): string {
  const clamped = Math.min(1, Math.max(0, fraction));
  const filled = Math.round(clamped * width);
  return `[${styleFill("█".repeat(filled))}${"░".repeat(width - filled)}] ${Math.round(clamped * 100)}%`;
}
