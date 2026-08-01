import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import { buildEmojisScreen, routeEmojisKey } from "./emojis-screen.ts";
import { renderPreview } from "./preview.ts";
import { buildSeparatorsScreen, routeSeparatorsKey } from "./separators-screen.ts";
import {
  buildProviderDetail,
  buildProviderScreen,
  cycleActiveModelOverride,
  moveProvider,
  requestProviderRefresh,
  setProviderDisplayMode,
  setProviderIcon,
  setProviderMissingDataPolicy,
  setProviderRefreshOverrides,
  toggleProvider,
  toggleProviderTracking,
  toggleStatusline,
  updateProviderWindow,
  type ProviderDetailView,
  type ProviderUiContext,
  type ProviderUiEffect,
} from "./provider-ui.ts";
import type {
  MissingDataPolicy,
  PreviewMode,
  SegmentId,
  StatuslineSettings,
  WindowConfiguration,
} from "./schema.ts";

export const ROOT_ROWS = [
  { id: "providers", label: "Providers" },
  { id: "separators", label: "Separators" },
  { id: "emojis", label: "Emojis" },
] as const;

export type RootRowId = (typeof ROOT_ROWS)[number]["id"];
export type DirtyChoice = "save" | "discard" | "cancel";
export type UiAction = "none" | "open" | "close" | "confirm-close";

export interface SettingsUiState {
  original: StatuslineSettings;
  draft: StatuslineSettings;
  selected: number;
  openRow?: RootRowId;
  selectedProviderId?: string;
  confirmClose: boolean;
  error?: string;
}

export interface NavigationResult {
  state: SettingsUiState;
  action: UiAction;
  effect?: ProviderUiEffect;
}

export function createSettingsUi(settings: StatuslineSettings): SettingsUiState {
  return {
    original: structuredClone(settings),
    draft: structuredClone(settings),
    selected: 0,
    confirmClose: false,
  };
}

export function isDirty(state: SettingsUiState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.original);
}

export function replaceDraft(state: SettingsUiState, draft: StatuslineSettings): SettingsUiState {
  return { ...state, draft: structuredClone(draft), error: undefined };
}

export function resetDraft(state: SettingsUiState): SettingsUiState {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.version = state.draft.version;
  draft.__unknown = structuredClone(state.draft.__unknown);
  return { ...state, draft, error: undefined };
}

type DetailField = keyof WindowConfiguration;
type DetailRow =
  | { type: "display"; label: string }
  | { type: "active"; segment: SegmentId; label: string }
  | { type: "icon-mode" | "icon-value" | "missing" | "capability"; label: string }
  | { type: "refresh-number"; field: "refreshIntervalMs" | "maxCacheAgeMs"; label: string }
  | { type: "refresh-toggle"; field: "useCache" | "keepAfterFailure" | "refreshWhileActive" | "refreshDisabledProvider"; label: string }
  | { type: "refresh-now"; label: string }
  | { type: "window"; key: string; field: DetailField; label: string };

function detailRows(
  state: SettingsUiState,
  providers: ProviderUiContext,
  detail: ProviderDetailView,
): DetailRow[] {
  const providerId = state.selectedProviderId!;
  const capability = providers.capabilities[providerId];
  const supported = state.draft.providers.records[providerId]?.supportedOverrides
    ?? Object.keys(detail.activeModel) as SegmentId[];
  const rows: DetailRow[] = [
    { type: "display", label: `Display mode: ${detail.displayMode}` },
    ...supported.map((segment): DetailRow => ({
      type: "active", segment, label: `Active model ${segment}: ${detail.activeModel[segment]}`,
    })),
    { type: "icon-mode", label: `Provider icon: ${detail.providerIcon.mode}` },
    { type: "icon-value", label: `Provider icon value: ${detail.providerIcon.value || "(empty)"}` },
    { type: "missing", label: `Missing data: ${detail.missingDataPolicy}` },
  ];

  if (capability.billing === "local" && detail.localThroughput) {
    rows.push({ type: "capability", label: "Local throughput: Available" });
  }
  if (capability.billing !== "local" && detail.hostedThroughput) {
    rows.push({ type: "capability", label: "Streaming output: Available" });
  }
  if (capability.billing === "api" && detail.tokenLedger) {
    rows.push({ type: "capability", label: "API token ledger: Available" });
  }
  if (capability.billing === "api" && detail.costLedger) {
    rows.push({ type: "capability", label: "API cost ledger: Available" });
  }

  if (capability.billing === "subscription" && detail.quotaAvailable) {
    rows.push(
      { type: "refresh-number", field: "refreshIntervalMs", label: `Refresh interval: ${detail.refresh.intervalMs}ms` },
      { type: "refresh-number", field: "maxCacheAgeMs", label: `Maximum cache age: ${detail.refresh.maxAgeMs}ms` },
      { type: "refresh-toggle", field: "useCache", label: `Use cache: ${detail.refresh.useCache ? "On" : "Off"}` },
      { type: "refresh-toggle", field: "keepAfterFailure", label: `Keep after failure: ${detail.refresh.keepAfterFailure ? "On" : "Off"}` },
      { type: "refresh-toggle", field: "refreshWhileActive", label: `Refresh while active: ${detail.refresh.refreshWhileActive ? "On" : "Off"}` },
      { type: "refresh-toggle", field: "refreshDisabledProvider", label: `Refresh disabled provider: ${detail.refresh.refreshDisabledProvider ? "On" : "Off"}` },
      { type: "refresh-now", label: "Refresh now" },
    );
    for (const window of detail.quotaWindows) {
      const settings = window.settings;
      const prefix = settings.label || window.label;
      const fields: Array<[DetailField, string]> = [
        ["visible", `Visible: ${settings.visible ? "On" : "Off"}`],
        ["label", `Label: ${settings.label || window.label}`],
        ["showBar", `Bar: ${settings.showBar ? "On" : "Off"}`],
        ["showPercent", `Percent: ${settings.showPercent ? "On" : "Off"}`],
        ["showReset", `Reset: ${settings.showReset ? "On" : "Off"}`],
        ["resetFormat", `Reset format: ${settings.resetFormat}`],
        ["showUsed", `Used: ${settings.showUsed ? "On" : "Off"}`],
        ["showRemaining", `Remaining: ${settings.showRemaining ? "On" : "Off"}`],
        ["showZero", `Show zero: ${settings.showZero ? "On" : "Off"}`],
        ["width", `Width: ${settings.width}`],
      ];
      rows.push(...fields.map(([field, label]) => ({ type: "window" as const, key: window.key!, field, label: `${prefix} ${label}` })));
    }
  }
  return rows;
}

const MISSING_POLICIES: readonly MissingDataPolicy[] = ["hide", "cached", "na", "warning", "provider-name"];
const ICON_MODES = ["default", "global", "custom", "hidden"] as const;
const RESET_FORMATS = ["countdown", "exact-time", "exact-date"] as const;

function cycle<T>(values: readonly T[], current: T, backwards: boolean): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + (backwards ? values.length - 1 : 1)) % values.length];
}

function routeProviderDetail(
  state: SettingsUiState,
  key: string,
  providers: ProviderUiContext,
): NavigationResult {
  const providerId = state.selectedProviderId!;
  const detail = buildProviderDetail(state.draft, providers, providerId);
  if (!detail) return { state: { ...state, selectedProviderId: undefined, selected: 0 }, action: "none" };
  const rows = detailRows(state, providers, detail);
  if (key === "ArrowUp" || key === "k") return { state: { ...state, selected: Math.max(0, state.selected - 1) }, action: "none" };
  if (key === "ArrowDown" || key === "j") return { state: { ...state, selected: Math.min(rows.length - 1, state.selected + 1) }, action: "none" };
  if (key === "Home") return { state: { ...state, selected: 0 }, action: "none" };
  if (key === "End") return { state: { ...state, selected: Math.max(0, rows.length - 1) }, action: "none" };

  const row = rows[state.selected];
  if (!row) return { state, action: "none" };
  const backwards = key === "ArrowLeft" || key === "h";
  const forwards = key === "ArrowRight" || key === "l" || key === "Enter" || key === " " || key === "Space";
  const draft = structuredClone(state.draft);

  if (row.type === "refresh-now" && forwards) {
    return { state, action: "none", effect: requestProviderRefresh(draft, providerId, providers.capabilities[providerId], providers.activeProvider === providerId) };
  }
  if (row.type === "display" && (forwards || backwards)) {
    setProviderDisplayMode(draft, providerId, detail.displayMode === "default" ? "custom" : "default", providers.windows?.[providerId]);
  } else if (row.type === "active" && (forwards || backwards)) {
    cycleActiveModelOverride(draft, providerId, row.segment);
    if (backwards) cycleActiveModelOverride(draft, providerId, row.segment);
  } else if (row.type === "icon-mode" && (forwards || backwards)) {
    setProviderIcon(draft, providerId, { ...detail.providerIcon, mode: cycle(ICON_MODES, detail.providerIcon.mode, backwards) });
  } else if (row.type === "icon-value" && (key === "Backspace" || key.length === 1)) {
    const value = key === "Backspace" ? detail.providerIcon.value.slice(0, -1) : detail.providerIcon.value + key;
    setProviderIcon(draft, providerId, { mode: "custom", value });
  } else if (row.type === "missing" && (forwards || backwards)) {
    setProviderMissingDataPolicy(draft, providerId, cycle(MISSING_POLICIES, detail.missingDataPolicy, backwards));
  } else if (row.type === "refresh-number" && (forwards || backwards)) {
    const current = row.field === "refreshIntervalMs" ? detail.refresh.intervalMs : detail.refresh.maxAgeMs;
    setProviderRefreshOverrides(draft, providerId, {
      ...state.draft.providers.records[providerId]?.refresh,
      [row.field]: current + (backwards ? -10_000 : 10_000),
    });
  } else if (row.type === "refresh-toggle" && (forwards || backwards)) {
    const current = detail.refresh[row.field];
    setProviderRefreshOverrides(draft, providerId, {
      ...state.draft.providers.records[providerId]?.refresh,
      [row.field]: !current,
    });
  } else if (row.type === "window") {
    const settings = detail.quotaWindows.find((window) => window.key === row.key)?.settings;
    if (!settings) return { state, action: "none" };
    if (row.field === "label" && (key === "Backspace" || key.length === 1)) {
      updateProviderWindow(draft, providerId, row.key, { label: key === "Backspace" ? settings.label.slice(0, -1) : settings.label + key });
    } else if (row.field === "width" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { width: settings.width + (backwards ? -1 : 1) });
    } else if (row.field === "resetFormat" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { resetFormat: cycle(RESET_FORMATS, settings.resetFormat, backwards) });
    } else if (typeof settings[row.field] === "boolean" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { [row.field]: !settings[row.field] });
    } else {
      return { state, action: "none" };
    }
  } else {
    return { state, action: "none" };
  }
  return { state: { ...state, draft }, action: "none" };
}

/** Pure, deterministic routing. I/O is represented as an action/effect for the caller. */
export function routeSettingsKey(
  state: SettingsUiState,
  key: string,
  providers?: ProviderUiContext,
): NavigationResult {
  if (state.confirmClose) return { state, action: "confirm-close" };

  if (key === "Escape") {
    if (state.selectedProviderId && providers) {
      const index = buildProviderScreen(state.draft, providers).rows.findIndex((row) => row.id === state.selectedProviderId);
      return { state: { ...state, selectedProviderId: undefined, selected: Math.max(0, index + 2) }, action: "none" };
    }
    if (state.openRow) return { state: { ...state, openRow: undefined, selected: 0 }, action: "none" };
    return isDirty(state)
      ? { state: { ...state, confirmClose: true }, action: "confirm-close" }
      : { state, action: "close" };
  }

  if (state.openRow === "separators") {
    const routed = routeSeparatorsKey(state.draft, state.selected, key);
    return { state: { ...state, ...routed }, action: "none" };
  }

  if (state.openRow === "emojis") {
    const providerIds = providers?.descriptors.map(({ id }) => id) ?? [];
    const routed = routeEmojisKey(state.draft, state.selected, key, providerIds);
    return { state: { ...state, ...routed }, action: "none" };
  }

  if (state.openRow === "providers" && providers) {
    if (state.selectedProviderId) return routeProviderDetail(state, key, providers);
    const providerRows = buildProviderScreen(state.draft, providers).rows;
    const lastRow = providerRows.length + 1;
    if (key === "ArrowUp" || key === "k") return { state: { ...state, selected: Math.max(0, state.selected - 1) }, action: "none" };
    if (key === "ArrowDown" || key === "j") return { state: { ...state, selected: Math.min(lastRow, state.selected + 1) }, action: "none" };
    if (key === "Home") return { state: { ...state, selected: 0 }, action: "none" };
    if (key === "End") return { state: { ...state, selected: lastRow }, action: "none" };

    const provider = providerRows[state.selected - 2];
    if (key === "Enter" && provider) {
      return { state: { ...state, selectedProviderId: provider.id, selected: 0 }, action: "open" };
    }
    if (key === " " || key === "Space") {
      const draft = structuredClone(state.draft);
      if (state.selected === 0) toggleStatusline(draft);
      else if (state.selected === 1) toggleProviderTracking(draft);
      else if (provider) toggleProvider(draft, provider.id);
      return { state: { ...state, draft }, action: "none" };
    }

    const direction = key === "Ctrl+ArrowUp" || key === "Ctrl+Up" ? "up"
      : key === "Ctrl+ArrowDown" || key === "Ctrl+Down" ? "down"
      : undefined;
    if (direction && provider) {
      const draft = structuredClone(state.draft);
      for (const descriptor of providers.descriptors) {
        if (!draft.providers.order.includes(descriptor.id)) draft.providers.order.push(descriptor.id);
      }
      const before = draft.providers.order.indexOf(provider.id);
      moveProvider(draft, provider.id, direction);
      const after = draft.providers.order.indexOf(provider.id);
      return {
        state: { ...state, draft, selected: after === before ? state.selected : state.selected + (direction === "up" ? -1 : 1) },
        action: "none",
      };
    }
    return { state, action: "none" };
  }

  if (state.openRow) return { state, action: "none" };

  let selected = state.selected;
  if (key === "ArrowUp" || key === "k") selected = Math.max(0, selected - 1);
  if (key === "ArrowDown" || key === "j") selected = Math.min(ROOT_ROWS.length - 1, selected + 1);
  if (key === "Home") selected = 0;
  if (key === "End") selected = ROOT_ROWS.length - 1;
  if (selected !== state.selected) return { state: { ...state, selected }, action: "none" };

  if (key !== "Enter") return { state, action: "none" };
  const row = ROOT_ROWS[selected];
  return { state: { ...state, openRow: row.id, selected: 0 }, action: "open" };
}

/** Resolve the dirty-close prompt. Save is the only function allowed to perform I/O. */
export async function resolveDirtyChoice(
  state: SettingsUiState,
  choice: DirtyChoice,
  save: (settings: StatuslineSettings) => void | Promise<void>,
): Promise<NavigationResult> {
  if (choice === "cancel") return { state: { ...state, confirmClose: false }, action: "none" };
  if (choice === "discard") {
    return {
      state: { ...state, draft: structuredClone(state.original), confirmClose: false, error: undefined },
      action: "close",
    };
  }

  try {
    await save(structuredClone(state.draft));
    const saved = structuredClone(state.draft);
    return {
      state: { ...state, original: saved, draft: structuredClone(saved), confirmClose: false, error: undefined },
      action: "close",
    };
  } catch (error) {
    return {
      state: { ...state, confirmClose: true, error: error instanceof Error ? error.message : String(error) },
      action: "confirm-close",
    };
  }
}

export interface RenderSettingsUiOptions {
  width: number;
  previewMode?: PreviewMode;
  /** Caller-owned discovery/capability snapshot; rendering never performs discovery or refresh. */
  providers?: ProviderUiContext;
  /** Available terminal rows; when set, the body scrolls to keep the selected row visible. */
  viewportRows?: number;
}

/** Key bindings in effect for the active screen, shown as a legend inside the window. */
function keyLegend(state: SettingsUiState): string {
  if (state.confirmClose) return "S Save  ·  D Discard  ·  Esc Cancel";
  if (state.selectedProviderId) return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Esc Back";
  if (state.openRow === "providers") return "↑↓ Move  ·  Space Toggle  ·  Enter Details  ·  Ctrl↑↓ Reorder  ·  Esc Back";
  if (state.openRow === "separators") return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Ctrl↑↓ Reorder  ·  Esc Back";
  if (state.openRow === "emojis") return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Esc Back";
  return "↑↓ Move  ·  Enter Open  ·  Esc Quit";
}

/** Greedy word wrap on the "·" separator so long legends never break the box. */
function wrapLegend(text: string, width: number): string[] {
  if (visibleWidth(text) <= width) return [text];
  const lines: string[] = [];
  let cur = "";
  for (const part of text.split("  ·  ")) {
    const candidate = cur ? `${cur}  ·  ${part}` : part;
    if (visibleWidth(candidate) <= width) cur = candidate;
    else {
      if (cur) lines.push(cur);
      cur = part;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function fitLine(line: string, inner: number): string {
  const truncated = visibleWidth(line) > inner ? truncateToWidth(line, inner, "") : line;
  return truncated + " ".repeat(Math.max(0, inner - visibleWidth(truncated)));
}

/** Render the settings app as a centered, bordered window with a per-screen key legend.
 *  When `viewportRows` is set and the content overflows, the body scrolls to keep the
 *  selected row (the `> ` line) in view, with a `↑N above · ↓M below` indicator. */
export function renderSettingsWindow(state: SettingsUiState, options: RenderSettingsUiOptions): string[] {
  const width = Math.max(44, options.width);
  const inner = width - 2;
  const body = renderSettingsUi(state, { ...options, width: inner });
  const legend = wrapLegend(keyLegend(state), inner);
  const baseChrome = 3 + legend.length; // top border + separator + bottom border + legend
  const viewportRows = options.viewportRows ?? 0;

  let view = body;
  let scrollNote: string | undefined;
  if (viewportRows > 0 && body.length + baseChrome > viewportRows) {
    const viewport = Math.max(5, viewportRows - baseChrome - 1); // -1 reserves the scroll-note row
    const cursor = body.findIndex((line) => line.startsWith("> "));
    let start = (cursor >= 0 ? cursor : 0) - Math.floor(viewport / 2);
    start = Math.max(0, Math.min(start, Math.max(0, body.length - viewport)));
    const end = start + viewport;
    const above = start;
    const below = Math.max(0, body.length - end);
    view = body.slice(start, end);
    const parts: string[] = [];
    if (above > 0) parts.push(`↑${above} above`);
    if (below > 0) parts.push(`↓${below} below`);
    scrollNote = parts.join("  ·  ");
  }

  const title = " Statusline ";
  const titleFill = Math.max(0, inner - 1 - visibleWidth(title));
  const out: string[] = [
    "┌─" + title + "─".repeat(titleFill) + "┐",
    ...view.map((line) => `│${fitLine(line, inner)}│`),
  ];
  if (scrollNote) out.push(`│${fitLine(scrollNote, inner)}│`);
  out.push("├" + "─".repeat(inner) + "┤", ...legend.map((hint) => `│${fitLine(hint, inner)}│`), "└" + "─".repeat(inner) + "┘");
  return out;
}

/** Pure component rendering; previews use the production footer renderer. */
export function renderSettingsUi(state: SettingsUiState, options: RenderSettingsUiOptions): string[] {
  const lines = ["Statusline settings"];
  if (state.openRow === "separators") {
    lines.push("Separators");
    for (const [index, row] of buildSeparatorsScreen(state.draft).entries()) {
      lines.push(`${state.selected === index ? ">" : " "} ${row.label}`);
    }
  } else if (state.openRow === "emojis") {
    lines.push("Emojis");
    const providerIds = options.providers?.descriptors.map(({ id }) => id) ?? [];
    for (const [index, row] of buildEmojisScreen(state.draft, providerIds).entries()) {
      lines.push(`${state.selected === index ? ">" : " "} ${row.label}`);
    }
  } else if (state.openRow === "providers" && options.providers) {
    const screen = buildProviderScreen(state.draft, options.providers);
    if (state.selectedProviderId) {
      const detail = buildProviderDetail(state.draft, options.providers, state.selectedProviderId);
      if (detail) {
        lines.push(`Provider: ${detail.row.label}`);
        for (const [index, row] of detailRows(state, options.providers, detail).entries()) {
          lines.push(`${state.selected === index ? ">" : " "} ${row.label}`);
        }
      }
    } else {
      lines.push(
        `${state.selected === 0 ? ">" : " "} Statusline: ${screen.statuslineEnabled ? "Enabled" : "Disabled"}`,
        `${state.selected === 1 ? ">" : " "} Provider tracking: ${screen.providerTrackingEnabled ? "Enabled" : "Disabled"}`,
      );
      for (let index = 0; index < screen.rows.length; index++) {
        const row = screen.rows[index];
        lines.push(`${state.selected === index + 2 ? ">" : " "} ${row.enabled ? "[x]" : "[ ]"} ${row.label} — ${row.availability}; ${row.authentication}; ${row.billing}; ${row.reliability}; ${row.freshness}; quota ${row.quota}`);
      }
    }
  } else {
    for (let index = 0; index < ROOT_ROWS.length; index++) {
      const row = ROOT_ROWS[index];
      lines.push(`${index === state.selected ? ">" : " "} ${row.label}`);
    }
  }
  if (options.width >= 80) {
    lines.push("", ...renderPreview({
      settings: state.draft,
      mode: options.previewMode ?? state.draft.preview.mode,
      width: options.width,
    }));
  }
  if (state.confirmClose) lines.push("", "Unsaved changes: Save / Discard / Cancel");
  if (state.error) lines.push(`Save failed: ${state.error}`);
  return lines;
}
