export function formatWindow(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatContextPercent(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

export function formatRate(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : `${Math.round(value)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTime(activeMs: number, elapsedMs?: number, lastTurnMs?: number): string {
  const extras = [
    elapsedMs === undefined ? "" : `elapsed ${formatDuration(elapsedMs)}`,
    lastTurnMs === undefined ? "" : `last ${formatDuration(lastTurnMs)}`,
  ].filter(Boolean);
  return `⏱ ${formatDuration(activeMs)}${extras.length ? ` (${extras.join(", ")})` : ""}`;
}
