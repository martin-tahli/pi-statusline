import { renderBar, DEFAULT_STOPS, type BarStyle, type ColorStops } from "./bar.ts";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import { composeSegments, createSegments, SEGMENT_ORDER, type SegmentId } from "./segments.ts";
import {
  billingMode,
  deriveContext,
  deriveEffort,
  deriveModel,
  deriveProject,
  isLocalEndpoint,
  type ContextUsage,
} from "./derive.ts";
import { formatRate, formatResetCountdown, formatTime, formatWindow } from "./format.ts";
import { gitBranchSymbol, gitStatusTokens, type GitStatusState, type GitTokenKind } from "./git.ts";
import { estimateTokens, type ThroughputLevel } from "./throughput.ts";
import type { RateLimitWindow } from "./ratelimit.ts";
import type { ResetFormat, StatuslineSettings } from "./settings/schema.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/**
 * Single source of truth for the statusline's main line. Both the live footer
 * (extensions/statusline.ts) and the settings preview (settings/resolve.ts) render
 * through `renderMainLine`, so the preview can never drift from the real footer —
 * only the data (live vs fixture) and the theme (real vs none) differ.
 */

export interface RenderTheme {
  fg: (color: ThemeColor, text: string) => string;
  getColorMode?: () => string;
  getFgAnsi?: (color: ThemeColor) => string;
}

export interface MeterSnapshot {
  inputEstimated?: boolean;
  outputEstimated?: boolean;
  tools?: boolean;
  avgInputRate?: number;
  avgOutputRate?: number;
  outputRate?: number;
  outputLevel?: ThroughputLevel;
  inputLevel?: ThroughputLevel;
  waitingMs?: number;
  activeMs?: number;
  elapsedMs?: number;
  lastTurnMs?: number;
}

export interface FooterSnapshot {
  cwd: string;
  model?: { id: string; provider?: string; reasoning?: boolean; baseUrl?: string };
  thinkingLevel?: string;
  contextUsage?: ContextUsage;
  /** Branch name to show; only meaningful when extras.branch is on. */
  gitBranch?: string | null;
  gitStatus?: GitStatusState;
  pending?: boolean;
  /** True for subscription-billed providers (codex or oauth). */
  subscription?: boolean;
  turnActive?: boolean;
  meter?: MeterSnapshot;
  /** Last context char count, used to estimate the local prompt-processing rate. */
  lastContextChars?: number;
  /** Session token/cost totals, used for the cost extra and the API ledger. */
  totals?: { input: number; output: number; cost?: number; cacheRead?: number; cacheWrite?: number };
  /** Active provider's subscription quota windows (shown on the main line when no provider row does). */
  sessionWindows?: RateLimitWindow[];
  /** True when the active provider already shows its quota on a provider-tracking row. */
  activeProviderHasRow?: boolean;
  /** Placeholder shown for an eligible subscription provider before its windows load (e.g. "5h — wk —"). */
  sessionPlaceholder?: string;
  sessionFreshness?: string;
  now?: number;
}

const GIT_ROLES: Record<GitTokenKind, "accent" | "success" | "warning" | "error"> = {
  ahead: "accent",
  behind: "warning",
  dirty: "warning",
  clean: "success",
  error: "error",
};

const ICON_PRESETS: Record<StatuslineSettings["icons"]["style"], Record<string, string>> = {
  emoji: { project: "📁", model: "🤖", thinking: "🧠", context: "🪟", throughput: "⚡", time: "⏳", ledger: "🧾" },
  unicode: { project: "◆", model: "◇", thinking: "◌", context: "▣", throughput: "↕", time: "◷" },
  ascii: { project: "P", model: "M", thinking: "T", context: "C", throughput: "R", time: "@" },
  nerdfont: { project: "󰉋", model: "󰧑", thinking: "󰔟", context: "󰍛", throughput: "󰓅", time: "󰥔" },
  minimal: { project: "·", model: "·", thinking: "·", context: "·", throughput: "·", time: "·" },
  none: {},
  custom: {},
};

function icon(settings: StatuslineSettings, name: string): string {
  if (settings.icons.style === "none") return "";
  const override = settings.icons.symbols[name];
  if (override !== undefined) return override;
  return ICON_PRESETS[settings.icons.style][name] ?? "";
}

/** Provider icon: only when explicitly configured (no default glyph), matching the live footer. */
function providerIcon(settings: StatuslineSettings, providerId?: string): string {
  if (!providerId || settings.icons.style === "none") return "";
  const configured = settings.icons.providers[providerId];
  if (configured?.mode === "hidden") return "";
  if (configured?.mode === "custom") return configured.value;
  return "";
}

function barRole(settings: StatuslineSettings, used: number): ThemeColor {
  if (used * 100 >= settings.bars.critAt) return "error";
  if (used * 100 >= settings.bars.warnAt) return "warning";
  return "success";
}

function barStyleFactory(settings: StatuslineSettings, used: number, theme: RenderTheme | undefined, stops: ColorStops): BarStyle {
  if (settings.bars.truecolor && theme?.getColorMode?.() === "truecolor") {
    return {
      fill: (text) => {
        const rgb = stops[used * 100 >= settings.bars.critAt ? 2 : used * 100 >= settings.bars.warnAt ? 1 : 0];
        return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
      },
      track: (text) => `\x1b[38;2;58;63;70m${text}\x1b[39m`,
    };
  }
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  return {
    fill: (text) => paint(barRole(settings, used), text),
    track: (text) => paint("dim", text),
  };
}

function blockBar(used: number, settings: StatuslineSettings, theme: RenderTheme | undefined, width: number, showPercent: boolean): string {
  const w = Math.max(2, Math.floor(Number.isFinite(width) ? width : 12));
  const filled = Math.round(used * w);
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const bar = paint(barRole(settings, used), `${settings.bars.capLeft || "["}${(settings.bars.fill || "█").repeat(filled)}${(settings.bars.empty || "░").repeat(w - filled)}${settings.bars.capRight || "]"}`);
  return showPercent ? `${bar} ${Math.round(used * 100)}%` : bar;
}

function isLineBarStyle(style: string): boolean {
  return style === "rounded" || style === "line";
}

/** Resolved per-window display: per-provider `WindowConfiguration` overriding the global bar defaults. */
export interface ResolvedWindowDisplay {
  visible: boolean;
  label: string;
  showBar: boolean;
  showPercent: boolean;
  showReset: boolean;
  resetFormat: ResetFormat;
  width: number;
}

/** Resolve a quota window's effective display settings (per-window config wins over global bars). */
export function resolveWindowDisplay(
  settings: StatuslineSettings,
  provider: string | undefined,
  window: RateLimitWindow,
): ResolvedWindowDisplay {
  const windows = provider ? settings.providers.records[provider]?.windows : undefined;
  const cfg = { ...windows?.default, ...windows?.[window.key ?? ""] };
  const width = cfg?.width && cfg.width > 0 ? cfg.width : settings.bars.width;
  return {
    visible: cfg?.visible ?? true,
    label: cfg?.label ? cfg.label : window.label,
    showBar: cfg?.showBar ?? settings.bars.format !== "percent",
    showPercent: cfg?.showPercent ?? settings.bars.showPercent,
    showReset: cfg?.showReset ?? true,
    resetFormat: cfg?.resetFormat ?? "countdown",
    width,
  };
}

/** Format a reset timestamp according to the configured reset format. */
function formatReset(resetAt: number, format: ResetFormat, now: number): string {
  if (format === "exact-time" || format === "exact-date") {
    const d = new Date(resetAt);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return format === "exact-time" ? `${hh}:${mm}` : `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${hh}:${mm}`;
  }
  return formatResetCountdown(resetAt, now);
}

function renderSessionBar(settings: StatuslineSettings, provider: string | undefined, window: RateLimitWindow, theme: RenderTheme | undefined, now: number): string {
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const display = resolveWindowDisplay(settings, provider, window);
  const used = Math.max(0, Math.min(1, window.used));
  const bar = !display.showBar ? (display.showPercent ? `${Math.round(used * 100)}%` : "")
    : settings.icons.style === "ascii"
      ? `${"#".repeat(Math.round(used * display.width))}${"-".repeat(display.width - Math.round(used * display.width))}${display.showPercent ? ` ${Math.round(used * 100)}%` : ""}`
    : isLineBarStyle(settings.bars.style)
      ? renderBar(used, display.width, barStyleFactory(settings, used, theme, DEFAULT_STOPS), DEFAULT_STOPS, display.showPercent)
      : blockBar(used, settings, theme, display.width, display.showPercent);
  const reset = display.showReset && window.resetAt !== undefined ? paint("dim", ` ${settings.icons.style === "ascii" ? "reset" : "↻"} ${formatReset(window.resetAt, display.resetFormat, now)}`) : "";
  const detail = settings.bars.format === "detailed" && window.unit === "USD"
    ? ` $${window.usedAmount?.toFixed(2) ?? "?"} used / $${window.remainingAmount?.toFixed(2) ?? "?"} left` : "";
  if (!bar && !reset && !detail) return "";
  return `${paint("muted", `${display.label} `)}${bar}${display.showPercent ? " used" : ""}${reset}${detail}`.trim();
}

/** Compact no-bar form of one window: the numbers the reader actually needs (label, %, ↻ reset). */
function compactSessionBar(settings: StatuslineSettings, provider: string | undefined, window: RateLimitWindow, theme: RenderTheme | undefined, now: number): string {
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const display = resolveWindowDisplay(settings, provider, window);
  const used = Math.max(0, Math.min(1, window.used));
  const pct = display.showPercent ? `${Math.round(used * 100)}% used` : "";
  const reset = display.showReset && window.resetAt !== undefined ? paint("dim", ` ${settings.icons.style === "ascii" ? "reset" : "↻"} ${formatReset(window.resetAt, display.resetFormat, now)}`) : "";
  const body = `${pct}${reset}`.replace(/^\s+/, "");
  return body ? `${paint("muted", `${display.label} `)}${body}` : "";
}

const WINDOW_SEPARATOR = " >";

/**
 * Render a provider's quota windows to fit `budget` visible columns. Full bars when they fit;
 * under pressure drop bars before numbers, then keep the most-used window (including exhausted
 * limits) rather than guessing that the longest-duration window is always the limiting one.
 * Shared by the main-line session segment, the provider rows, and the settings preview.
 */
export function renderSessionWindows(
  settings: StatuslineSettings,
  provider: string | undefined,
  windows: readonly RateLimitWindow[],
  theme: RenderTheme | undefined,
  now: number,
  budget?: number,
): string {
  const sep = theme?.fg ? theme.fg("dim", WINDOW_SEPARATOR) : WINDOW_SEPARATOR;
  windows = windows.filter((window) => resolveWindowDisplay(settings, provider, window).visible);
  const full = windows.map((window) => renderSessionBar(settings, provider, window, theme, now)).filter(Boolean).join(sep);
  if (budget === undefined || visibleWidth(full) <= budget) return full;
  const ordered = [...windows].sort((a, b) => a.used - b.used || (b.resetAt ?? Infinity) - (a.resetAt ?? Infinity));
  const compact = () => ordered
    .map((window) => compactSessionBar(settings, provider, window, theme, now))
    .filter((bar) => bar.trim().length > 0)
    .join(sep);
  let result = compact();
  while (visibleWidth(result) > budget && ordered.length > 1) {
    ordered.shift();
    result = compact();
  }
  return result;
}

/** One provider's data for a tracking row (caller pre-filters order/enabled/health). */
export interface ProviderRowSource {
  provider: string;
  windows: readonly RateLimitWindow[];
  /** Static affordance shown before a subscription provider's windows load (e.g. "5h — wk —"). */
  placeholder?: string;
  freshness?: string;
}

/** True when a source would produce a row: at least one visible window, or a placeholder. */
export function sourceRenders(settings: StatuslineSettings, source: ProviderRowSource): boolean {
  if (renderSessionWindows(settings, source.provider, source.windows, undefined, Date.now()).trim()) return true;
  return Boolean(source.placeholder);
}

/** True when `provider` would show a tracking row (visible windows or placeholder), so the main line hides its quota. */
export function providerHasRow(
  settings: StatuslineSettings,
  sources: readonly ProviderRowSource[],
  provider: string | undefined,
): boolean {
  if (!settings.providers.enabled || !provider) return false;
  return sources.some((source) => source.provider === provider && sourceRenders(settings, source));
}

/**
 * Render the provider-tracking rows through the same per-window logic as the main-line session
 * segment, so the multi-line footer and the settings preview can never drift. Pure: no I/O.
 */
export function renderProviderRows(
  settings: StatuslineSettings,
  sources: readonly ProviderRowSource[],
  theme: RenderTheme | undefined,
  now: number,
  width?: number,
): string[] {
  if (!settings.providers.enabled) return [];
  const paint = (r: ThemeColor, text: string) => (theme?.fg ? theme.fg(r, text) : text);
  const sep = paint("dim", WINDOW_SEPARATOR);
  const lines: string[] = [];
  for (const source of sources) {
    if (settings.providers.records[source.provider]?.enabled === false) continue;
    const prefix = paint("muted", `${source.provider}${source.freshness ? ` (${source.freshness})` : ""} `);
    const visible = source.windows.filter((window) => resolveWindowDisplay(settings, source.provider, window).visible);
    if (visible.length) {
      // Width-aware: degrade in place (bars, then extra windows) instead of being chopped mid-bar.
      const budget = width === undefined ? undefined : Math.max(0, width - visibleWidth(prefix));
      const rendered = renderSessionWindows(settings, source.provider, visible, theme, now, budget);
      if (rendered.trim().length > 0) lines.push(`${prefix}${rendered}`);
    } else if (source.placeholder) {
      lines.push(paint("muted", `${source.provider} ${source.placeholder}`));
    }
  }
  return width === undefined ? lines : lines.map((line) => truncateToWidth(line, width, ""));
}

/** Render the single main statusline line. Pure: no I/O, no mutation. */
export function renderMainLine(
  settings: StatuslineSettings,
  snap: FooterSnapshot,
  width: number,
  theme?: RenderTheme,
): string {
  const paint = (role: ThemeColor, text: string) => (theme?.fg ? theme.fg(role, text) : text);
  const now = snap.now ?? Date.now();
  const extras = settings.extras;

  const context = deriveContext(snap.contextUsage);
  const contextRole = (ctx: { percent: number; tokens: number | null }): ThemeColor => {
    if (ctx.percent >= settings.thresholds.contextCrit) return "error";
    if (ctx.percent >= settings.thresholds.contextWarn) return "warning";
    return "success";
  };
  const branch = extras.branch ? snap.gitBranch : undefined;
  const branchSymbol = gitBranchSymbol(settings.icons.style === "nerdfont");
  const gitToken = (text: string) => settings.icons.style === "ascii" ? text.replace("✓", "clean").replace("●", "dirty").replace("↑", "ahead ").replace("↓", "behind ") : text;
  const git = branch
    ? [
      paint("accent", `${branchSymbol ? `${branchSymbol} ` : ""}${branch}`),
      ...(snap.gitStatus ? gitStatusTokens(snap.gitStatus).map((token) => paint(GIT_ROLES[token.kind], gitToken(token.text))) : []),
    ].join(" ")
    : "";
  const pending = extras.pending && snap.pending;
  const model = deriveModel(snap.model);
  const effort = deriveEffort(snap.thinkingLevel ?? "off", snap.model);
  const localModel = isLocalEndpoint(snap.model?.baseUrl);
  const mode = billingMode(localModel, snap.subscription ?? false);
  const needTotals = extras.cost || (mode === "api" && !snap.turnActive);
  const totals = needTotals ? snap.totals : undefined;
  const cost = extras.cost ? totals?.cost : undefined;

  const m = snap.meter ?? {};
  const liveOutputRate = snap.turnActive && m.outputRate !== undefined ? m.outputRate : undefined;
  const down = settings.icons.style === "ascii" ? "out " : "↓";
  const up = settings.icons.style === "ascii" ? "in " : "↑";
  const outputRate = liveOutputRate ?? m.avgOutputRate;
  const outputRateLabel = () => outputRate === undefined ? "" : paint(m.outputLevel ?? "muted", `${down}${m.outputEstimated ? "~" : ""}${formatRate(outputRate)}`);
  const throughputIcon = icon(settings, "throughput");
  // The ⚡ segment adapts to the billing model (see README "Throughput and time").
  const throughput = (() => {
    if (mode === "local") {
      const promptRate = m.waitingMs && snap.lastContextChars ? estimateTokens(snap.lastContextChars) / (m.waitingMs / 1_000) : undefined;
      const inputRate = promptRate ?? m.avgInputRate;
      const input = inputRate === undefined ? "" : paint(m.inputLevel ?? "muted", `${up}${promptRate !== undefined || m.inputEstimated ? "~" : ""}${formatRate(inputRate)}`);
      if (m.tools) return "tools";
      const rates = [input, outputRateLabel()].filter(Boolean).join(" ");
      return rates ? `${paint("muted", throughputIcon)}${rates}${paint("muted", " t/s")}` : "";
    }
    if (snap.turnActive) return m.tools ? "tools" : outputRateLabel() ? `${paint("muted", throughputIcon)}${outputRateLabel()}${paint("muted", " t/s")}` : "";
    if (mode === "subscription") return "";
    if (!totals || (!totals.input && !totals.output)) return "";
    const cache = settings.bars.format === "detailed" ? ` cache r${formatWindow(totals.cacheRead ?? 0)} w${formatWindow(totals.cacheWrite ?? 0)}` : "";
    return paint("muted", `${icon(settings, "ledger")} ${up}${formatWindow(totals.input)} ${down}${formatWindow(totals.output)}${totals.cost === undefined ? "" : ` ~$${totals.cost.toFixed(3)}`}${cache}`.trim());
  })();

  const activeMs = m.activeMs ?? 0;
  const time = activeMs > 0 || m.lastTurnMs !== undefined || (extras.sessionElapsed && m.elapsedMs !== undefined)
    ? formatTime(activeMs, extras.sessionElapsed ? m.elapsedMs : undefined, extras.lastTurn ? m.lastTurnMs : undefined, icon(settings, "time"))
    : "";

  const sessionWindows = snap.activeProviderHasRow ? [] : (snap.sessionWindows ?? []);
  const sessionProvider = snap.model?.provider;
  const visibleSessionWindows = sessionWindows.filter((window) => resolveWindowDisplay(settings, sessionProvider, window).visible);
  // Width-aware: composeSegments offers this renderer the leftover columns under width pressure,
  // so the quota degrades (bars, then extra windows) instead of being dropped or chopped mid-bar.
  const session = (budget?: number) => visibleSessionWindows.length
    ? `${snap.sessionFreshness ? `${snap.sessionFreshness} ` : ""}${renderSessionWindows(settings, sessionProvider, visibleSessionWindows, theme, now, budget === undefined ? undefined : Math.max(0, budget - (snap.sessionFreshness?.length ?? -1) - 1))}`
    : (snap.sessionPlaceholder ?? "");

  const withSpace = (name: string, value: string) => {
    const glyph = icon(settings, name);
    return glyph ? `${glyph} ${value}` : value;
  };

  const visibility = { ...settings.segments };
  const activeModel = snap.model?.provider ? settings.providers.records[snap.model.provider]?.activeModel : undefined;
  if (activeModel) {
    for (const id of SEGMENT_ORDER) {
      if (activeModel[id] === "on") visibility[id] = true;
      else if (activeModel[id] === "off") visibility[id] = false;
    }
  }
  const resolved = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, visibility[id] === "auto"
    ? id === "time" ? Boolean(snap.turnActive || extras.sessionElapsed || (extras.lastTurn && m.lastTurnMs !== undefined))
      : id === "throughput" ? Boolean(snap.turnActive)
      : id === "session" ? visibleSessionWindows.some((window) => window.used * 100 >= settings.bars.warnAt) : true
    : visibility[id]])) as Record<SegmentId, boolean>;
  const orderRank = new Map(settings.layout.segmentOrder.map((id, index) => [id, index] as const));
  const segments = createSegments(resolved, {
    project: () => {
      const head = paint("muted", withSpace("project", deriveProject(snap.cwd)));
      const tail = `${git ? `${paint("dim", settings.separators.projectGit)}${git}` : ""}${pending ? ` ${paint("muted", "queued")}` : ""}`;
      return `${head}${tail}`;
    },
    model: () => {
      if (!model) return "";
      const provider = providerIcon(settings, snap.model?.provider);
      const label = provider ? `${provider}${model}` : model;
      return paint("muted", `${withSpace("model", label)}${cost === undefined ? "" : ` ~$${cost.toFixed(3)}`}`);
    },
    effort: () => effort ? paint("muted", withSpace("thinking", effort)) : "",
    context: () => {
      if (!context) return "";
      const glyph = icon(settings, "context");
      const head = paint("muted", glyph ? `${glyph}  ` : "");
      return `${head}${paint(contextRole(context), context.label)}`;
    },
    session,
    throughput: () => throughput,
    // formatTime already carries its own ⏳ glyph; no icon prefix.
    time: () => time ? paint("muted", time) : "",
  }).sort((a, b) => (orderRank.get(a.id) ?? SEGMENT_ORDER.length) - (orderRank.get(b.id) ?? SEGMENT_ORDER.length));
  const inner = Math.max(0, width - Math.min(settings.separators.trailingSpacing, Math.max(0, width)));
  const separator = `${settings.separators.padding}${" ".repeat(settings.separators.spacingBefore)}${settings.separators.main}${" ".repeat(settings.separators.spacingAfter)}`;
  const line = composeSegments(segments, inner, paint("dim", separator), settings.layout.narrowPriority);
  const trailing = Math.min(settings.separators.trailingSpacing, Math.max(0, width));
  return line + " ".repeat(trailing);
}
