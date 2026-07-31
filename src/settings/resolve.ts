import { SEGMENT_ORDER, createSegments, composeSegments, type SegmentId } from "../segments.ts";
import { deriveProject, deriveModel, deriveEffort, deriveContext, type ContextUsage } from "../derive.ts";
import { formatRate, formatPercent, formatTime } from "../format.ts";
import type { StatuslineSettings, ActiveModelToggle } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";
import type { RateLimitWindow } from "../ratelimit.ts";

/** Immutable runtime inputs the renderer reads (footer uses live state, preview uses a fixture). */
export interface RuntimeSnapshot {
  cwd?: string;
  model?: { id: string; provider?: string; reasoning?: boolean };
  /** Active provider id, used to resolve per-provider activeModel tri-state overrides. */
  activeProvider?: string;
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  throughput?: { inputRate?: number; outputRate?: number };
  /** Active subscription quota windows, when the active provider reports them. */
  sessionWindows?: RateLimitWindow[];
  activeMs?: number;
  elapsedMs?: number;
  lastTurnMs?: number;
  pending?: boolean;
  now?: number;
}

export interface ResolutionContext {
  capability?: ProviderCapability;
  runtime: RuntimeSnapshot;
}

function isApplicable(id: SegmentId, ctx: ResolutionContext): boolean {
  const { runtime, capability } = ctx;
  switch (id) {
    case "effort":
      // Non-reasoning models have no effort level to show.
      return runtime.model?.reasoning === true;
    case "context":
      // Hide when no context usage (or right after compaction, where percent is null).
      return Boolean(runtime.contextUsage && runtime.contextUsage.percent !== null);
    case "session":
      // Session quota only for providers whose adapter reports windows.
      return Boolean(capability && capability.quotaSupport !== "none" && runtime.sessionWindows?.length);
    case "throughput": {
      // Throughput needs at least one measured rate.
      const t = runtime.throughput;
      return Boolean(t && (t.inputRate !== undefined || t.outputRate !== undefined));
    }
    default:
      return true;
  }
}

/**
 * Resolve per-segment visibility (R8): global enable ANDed with the active provider's
 * tri-state activeModel override ('on'/'off' win; 'default' inherits global), then
 * applicability self-hide (an inapplicable segment is never shown, even if forced 'on').
 */
export function resolveSegmentVisibility(
  settings: StatuslineSettings,
  ctx: ResolutionContext,
): Record<SegmentId, boolean> {
  const activeRec = ctx.runtime.activeProvider
    ? settings.providers.records[ctx.runtime.activeProvider]
    : undefined;
  const overrides = activeRec?.activeModel ?? ({} as Partial<Record<SegmentId, ActiveModelToggle>>);

  const result = {} as Record<SegmentId, boolean>;
  for (const id of SEGMENT_ORDER) {
    let enabled = settings.segments[id] !== false;
    const override = overrides[id];
    if (override === "on") enabled = true;
    else if (override === "off") enabled = false;
    // Applicability can only hide, never force-show.
    if (!isApplicable(id, ctx)) enabled = false;
    result[id] = enabled;
  }
  return result;
}

/** Resolve and validate segment order / narrow priority against the known segment set. */
export function resolveOrder(settings: StatuslineSettings): {
  segmentOrder: SegmentId[];
  narrowPriority: SegmentId[];
} {
  const valid = new Set<string>(SEGMENT_ORDER);
  const order = settings.layout.segmentOrder.filter((id) => valid.has(id));
  const narrow = settings.layout.narrowPriority.filter((id) => valid.has(id));
  return {
    segmentOrder: order.length ? order : ([...SEGMENT_ORDER] as SegmentId[]),
    narrowPriority: narrow.length ? narrow : ([...settings.layout.narrowPriority] as SegmentId[]),
  };
}

function throughputLabel(runtime: RuntimeSnapshot): string {
  const { inputRate, outputRate } = runtime.throughput ?? {};
  const parts: string[] = [];
  if (inputRate !== undefined) parts.push(`↑ ${formatRate(inputRate)}`);
  if (outputRate !== undefined) parts.push(`↓ ${formatRate(outputRate)}`);
  return parts.join(" ");
}

function sessionLabel(runtime: RuntimeSnapshot): string {
  const windows = runtime.sessionWindows ?? [];
  return windows
    .map((window) => `${window.label} ${formatPercent(window.used)}`)
    .join(" ");
}

/** Resolved bar configuration derived (and bounded) from settings.bars. */
export interface ResolvedBar {
  width: number;
  fill: string;
  empty: string;
  capLeft: string;
  capRight: string;
  showPercent: boolean;
  style: StatuslineSettings["bars"]["style"];
}

/** Resolve and bound the bar config from settings (width clamped >= 2, chars defaulted). */
export function resolveBarConfig(settings: StatuslineSettings): ResolvedBar {
  const bars = settings.bars;
  return {
    width: Math.max(2, Math.floor(Number.isFinite(bars.width) ? bars.width : 12)),
    fill: bars.fill || "█",
    empty: bars.empty || "░",
    capLeft: bars.capLeft || "╟",
    capRight: bars.capRight || "╢",
    showPercent: bars.showPercent,
    style: bars.style,
  };
}

/**
 * Compose the single main statusline line through the existing production path
 * (createSegments + composeSegments), driven entirely by resolved settings.
 * KTD3: footer and preview share this one function so they cannot drift.
 */
export function composeFooterLine(
  settings: StatuslineSettings,
  ctx: ResolutionContext,
  width: number,
): string {
  const visibility = resolveSegmentVisibility(settings, ctx);
  const { runtime } = ctx;
  const renderers = {
    project: () => deriveProject(runtime.cwd ?? ""),
    model: () => deriveModel(runtime.model),
    effort: () => deriveEffort(runtime.thinkingLevel ?? "off", runtime.model),
    context: () => deriveContext(runtime.contextUsage)?.label ?? "",
    session: () => sessionLabel(runtime),
    throughput: () => throughputLabel(runtime),
    time: () => formatTime(runtime.activeMs ?? 0, runtime.elapsedMs, runtime.lastTurnMs),
  } as const;
  const segments = createSegments(visibility, renderers);
  return composeSegments(segments, width, settings.separators.main || " · ");
}
