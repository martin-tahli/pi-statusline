import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export const SEGMENT_ORDER = [
  "project",
  "model",
  "effort",
  "context",
  "session",
  "throughput",
  "time",
] as const;

export type SegmentId = (typeof SEGMENT_ORDER)[number];

export interface Segment {
  id: SegmentId;
  enabled: boolean;
  /**
   * Render the segment's value. Width-aware segments (the quota windows) accept the number of
   * visible columns available and degrade their rendering to fit; plain segments ignore it.
   */
  render: (budget?: number) => string;
}

export function createSegments(
  enabled: Record<SegmentId, boolean>,
  renderers: Record<SegmentId, (budget?: number) => string>,
): Segment[] {
  return SEGMENT_ORDER.map((id) => ({ id, enabled: enabled[id], render: renderers[id] }));
}

const COMPACT_ORDER: SegmentId[] = ["context", "session", "model", "effort", "project", "throughput", "time"];
const DROP_ORDER = COMPACT_ORDER.slice(1).reverse();

export function composeSegments(
  segments: Segment[],
  width: number,
  separator = " · ",
  dropOrder: readonly SegmentId[] = DROP_ORDER,
): string {
  if (width <= 0) return "";
  let parts = segments.flatMap((segment) => {
    if (!segment.enabled) return [];
    const value = segment.render();
    return value ? [{ id: segment.id, render: segment.render, value }] : [];
  });
  const line = (ps: typeof parts) => ps.map((part) => part.value).join(separator);
  const fits = (ps: typeof parts) => visibleWidth(line(ps)) <= width;
  if (fits(parts)) return line(parts);

  // Width pressure: before dropping a segment, offer it the columns the rest of the line leaves.
  // Width-aware segments (quota windows) degrade in place instead of vanishing or being
  // hard-truncated mid-bar — the weekly % and reset stay readable on narrow screens.
  const shrink = (ps: typeof parts, id: SegmentId) => {
    const part = ps.find((p) => p.id === id);
    if (!part) return;
    const rest = visibleWidth(ps.filter((p) => p.id !== id).map((p) => p.value).join(separator))
      + visibleWidth(separator) * Math.max(0, ps.length - 1);
    const shrunk = part.render(width - rest);
    if (shrunk) part.value = shrunk;
  };

  for (const id of dropOrder) {
    shrink(parts, id);
    if (fits(parts)) return line(parts);
    parts = parts.filter((part) => part.id !== id);
    if (fits(parts)) return line(parts);
  }
  // Segments outside the configured drop order still get one shrink offer before truncation.
  for (const part of parts) shrink(parts, part.id);
  if (fits(parts)) return line(parts);
  return truncateToWidth(line(parts), width, "");
}
