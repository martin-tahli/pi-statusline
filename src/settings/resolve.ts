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

function icon(settings: StatuslineSettings, name: string): string {
  const override = settings.icons.symbols[name];
  if (override !== undefined) return override;
  const presets: Record<StatuslineSettings["icons"]["style"], Record<string, string>> = {
    emoji: { project: "📁", model: "🤖", thinking: "💭", context: "🪟", session: "📊", throughput: "⚡", time: "⏱", provider: "🔌" },
    unicode: { project: "◆", model: "◇", thinking: "◌", context: "▣", session: "▥", throughput: "↕", time: "◷", provider: "●" },
    ascii: { project: "P", model: "M", thinking: "T", context: "C", session: "Q", throughput: "R", time: "@", provider: "*" },
    nerdfont: { project: "󰉋", model: "󰧑", thinking: "󰔟", context: "󰍛", session: "󰄬", throughput: "󰓅", time: "󰥔", provider: "󰒋" },
    minimal: { project: "·", model: "·", thinking: "·", context: "·", session: "·", throughput: "·", time: "·", provider: "·" },
    none: {},
    custom: {},
  };
  return presets[settings.icons.style][name] ?? "";
}

function withIcon(settings: StatuslineSettings, name: string, value: string): string {
  const symbol = icon(settings, name);
  return symbol ? `${symbol}${settings.separators.iconLabel}${value}` : value;
}

function providerIcon(settings: StatuslineSettings, providerId: string | undefined): string {
  if (!providerId) return "";
  const configured = settings.icons.providers[providerId];
  if (configured?.mode === "hidden") return "";
  if (configured?.mode === "custom") return configured.value;
  return icon(settings, "provider");
}

function sessionLabel(settings: StatuslineSettings, runtime: RuntimeSnapshot): string {
  const windows = runtime.sessionWindows ?? [];
  const bar = resolveBarConfig(settings);
  const separator = settings.layout.providerRows === "newline" ? settings.separators.provider : settings.separators.window;
  return windows.map((window) => {
    const used = Math.max(0, Math.min(1, window.used));
    const filled = Math.round(used * bar.width);
    const track = `${bar.capLeft}${bar.fill.repeat(filled)}${bar.empty.repeat(bar.width - filled)}${bar.capRight}`;
    return `${window.label}${settings.separators.labelValue}${track}${bar.showPercent ? settings.separators.labelValue + formatPercent(used) : ""}`;
  }).join(separator);
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
    project: () => withIcon(settings, "project", deriveProject(runtime.cwd ?? "")),
    model: () => {
      const value = deriveModel(runtime.model);
      const provider = providerIcon(settings, runtime.activeProvider);
      return withIcon(settings, "model", provider ? `${provider}${settings.separators.iconLabel}${value}` : value);
    },
    effort: () => withIcon(settings, "thinking", deriveEffort(runtime.thinkingLevel ?? "off", runtime.model)),
    context: () => {
      const derived = deriveContext(runtime.contextUsage)?.label ?? "";
      const rawPercent = runtime.contextUsage?.percent;
      const percent = typeof rawPercent === "number" && rawPercent <= 1 ? rawPercent * 100 : rawPercent;
      const state = typeof percent === "number" && percent >= settings.thresholds.contextCrit ? "!!"
        : typeof percent === "number" && percent >= settings.thresholds.contextWarn ? "!" : "";
      return withIcon(settings, "context", `${derived}${state}`);
    },
    session: () => withIcon(settings, "session", sessionLabel(settings, runtime)),
    throughput: () => withIcon(settings, "throughput", throughputLabel(runtime)),
    time: () => withIcon(settings, "time", formatTime(runtime.activeMs ?? 0, runtime.elapsedMs, runtime.lastTurnMs)),
  } as const;
  const order = resolveOrder(settings).segmentOrder;
  const rank = new Map(order.map((id, index) => [id, index]));
  const segments = createSegments(visibility, renderers).sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
  const separator = `${settings.separators.padding}${" ".repeat(settings.separators.spacingBefore)}${settings.separators.main || " · "}${" ".repeat(settings.separators.spacingAfter)}`;
  const trailingSpacing = Math.min(settings.separators.trailingSpacing, Math.max(0, width));
  return composeSegments(segments, width - trailingSpacing, separator) + " ".repeat(trailingSpacing);
}
