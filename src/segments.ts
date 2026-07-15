import { truncateToWidth } from "@earendil-works/pi-tui";

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
  render: () => string;
}

export function createSegments(
  enabled: Record<SegmentId, boolean>,
  renderers: Record<SegmentId, () => string>,
): Segment[] {
  return SEGMENT_ORDER.map((id) => ({ id, enabled: enabled[id], render: renderers[id] }));
}

export function composeSegments(segments: Segment[], width: number): string {
  if (width <= 0) return "";
  const line = segments.flatMap((segment) => {
    if (!segment.enabled) return [];
    const value = segment.render();
    return value ? [value] : [];
  }).join(" · ");
  return truncateToWidth(line, width, "");
}
