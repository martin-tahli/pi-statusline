import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig } from "./defaults.ts";
import { buildEmojisScreen, routeEmojisKey } from "./emojis-screen.ts";
import { renderPreview } from "./preview.ts";
import type { ResolutionContext } from "./resolve.ts";
import type { RenderTheme } from "../render.ts";
import { buildSeparatorsScreen, routeSeparatorsKey, DISPLAY_GROUPS, displayGroup } from "./separators-screen.ts";
import { isTextInput, editText } from "./text.ts";
import { sanitizeDisplayString } from "./validation.ts";
import { resetProvider } from "./state.ts";
import {
  buildProviderDetail,
  buildProviderScreen,
  cycleActiveModelOverride,
  moveProvider,
  requestProviderRefresh,
  toggleProvider,
  toggleProviderTracking,
  toggleStatusline,
  updateProviderWindow,
  setProviderRefreshOverrides,
  setProviderMissingDataPolicy,
  type ProviderDetailView,
  type ProviderUiContext,
  type ProviderUiEffect,
} from "./provider-ui.ts";
import type {
  PreviewMode,
  SegmentId,
  StatuslineSettings,
  WindowConfiguration,
} from "./schema.ts";

export const ROOT_ROWS = [
  { id: "providers", label: "Statusline & Providers" },
  { id: "separators", label: "Display" },
  { id: "emojis", label: "Icons" },
  { id: "reset", label: "Reset all settings to default" },
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
  section?: string;
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
  | { type: "active"; segment: SegmentId; label: string }
  | { type: "refresh-now"; label: string }
  | { type: "policy"; field: string; label: string }
  | { type: "account"; id: string; field: "enabled" | "label"; label: string }
  | { type: "window"; key: string; field: DetailField; label: string }
  | { type: "reset"; label: string };

function detailRows(
  state: SettingsUiState,
  providers: ProviderUiContext,
  detail: ProviderDetailView,
): DetailRow[] {
  const providerId = state.selectedProviderId!;
  const configuredOverrides = state.draft.providers.records[providerId]?.supportedOverrides;
  const supported = configuredOverrides?.length
    ? configuredOverrides
    : Object.keys(detail.activeModel) as SegmentId[];
  const rows: DetailRow[] = supported.map((segment): DetailRow => ({
    type: "active", segment, label: `Show ${segment} for this provider: ${detail.activeModel[segment]}`,
  }));

  if (detail.quotaAvailable) {
    rows.push({ type: "policy", field: "missingDataPolicy", label: `Missing data: ${detail.missingDataPolicy}` });
    for (const [field, label] of Object.entries({ intervalMs: "Refresh interval (ms)", maxAgeMs: "Maximum cache age (ms)", useCache: "Use cache", keepAfterFailure: "Keep cache after failure", refreshWhileActive: "Refresh active provider", refreshDisabledProvider: "Refresh disabled provider" })) {
      if (providers.accounts?.[providerId] && field !== "maxAgeMs") continue; // The addon owns polling and authentication.
      rows.push({ type: "policy", field, label: `${label}: ${detail.refresh[field as keyof typeof detail.refresh]}` });
    }
    rows.push({ type: "refresh-now", label: providers.accounts?.[providerId] ? "Reload account snapshots (refresh usage in your addon)" : "Refresh usage now" });
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
        ["width", `Width: ${settings.width}`],
        ["showZero", `Show at zero: ${settings.showZero ? "On" : "Off"}`],
        ...(window.unit === "USD" ? [
          ["showUsed", `Used amount: ${settings.showUsed ? "On" : "Off"}`],
          ["showRemaining", `Remaining amount: ${settings.showRemaining ? "On" : "Off"}`],
        ] as Array<[DetailField, string]> : []),
      ];
      rows.push(...fields.map(([field, label]) => ({ type: "window" as const, key: window.key!, field, label: `${prefix} ${label}` })));
    }
  }
  for (const account of providers.accounts?.[providerId]?.accounts ?? []) {
    const config = state.draft.providers.records[providerId]?.accounts?.[account.id];
    rows.push({ type: "account", id: account.id, field: "enabled", label: `${account.label}${account.active ? " (active)" : ""}: ${config?.enabled === false ? "Hidden" : "Selected"}` },
      { type: "account", id: account.id, field: "label", label: `Display label: ${config?.label || account.label}` });
  }
  rows.push({ type: "reset", label: "Reset provider to default" });
  return rows.filter((row) => !state.section || (row.type === "active" ? state.section === "active"
    : row.type === "account" ? state.section === "accounts"
    : row.type === "window" ? state.section === `window:${row.key}`
    : row.type === "reset" ? state.section === "reset" : state.section === "refresh"));
}

/** Small menus reveal controls only after a category is opened. */
function sections(state: SettingsUiState, providers?: ProviderUiContext): Array<{ id: string; label: string }> {
  if (state.openRow === "separators") return [...DISPLAY_GROUPS];
  if (state.openRow === "emojis") return [
    { id: "symbols", label: "Style & segment symbols" },
    ...[...new Set([...(providers?.descriptors.map((p) => p.id) ?? []), ...Object.keys(state.draft.icons.providers)])]
      .map((id) => ({ id, label: `${id} icon` })),
  ];
  if (state.selectedProviderId && providers) {
    const detail = buildProviderDetail(state.draft, providers, state.selectedProviderId);
    if (!detail) return [];
    return [
      { id: "active", label: "Visible information for this provider" },
      ...(providers.accounts?.[state.selectedProviderId] ? [{ id: "accounts", label: "Accounts (display only)" }] : []),
      ...(detail.quotaAvailable ? [{ id: "refresh", label: "Refresh & missing data" }, ...detail.quotaWindows.map((w) => ({ id: `window:${w.key}`, label: `Quota: ${w.label}` }))] : []),
      { id: "reset", label: "Reset provider to default" },
    ];
  }
  return [];
}

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
  const editingLabel = (rows[state.selected]?.type === "window" || rows[state.selected]?.type === "account") && (rows[state.selected] as { field?: string }).field === "label" && isTextInput(key);
  if (!editingLabel && (key === "ArrowUp" || key === "k")) return { state: { ...state, selected: Math.max(0, state.selected - 1) }, action: "none" };
  if (!editingLabel && (key === "ArrowDown" || key === "j")) return { state: { ...state, selected: Math.min(rows.length - 1, state.selected + 1) }, action: "none" };
  if (key === "Home") return { state: { ...state, selected: 0 }, action: "none" };
  if (key === "End") return { state: { ...state, selected: Math.max(0, rows.length - 1) }, action: "none" };

  const row = rows[state.selected];
  if (!row) return { state, action: "none" };
  const backwards = key === "ArrowLeft" || key === "h";
  const forwards = key === "ArrowRight" || key === "l" || key === "Enter" || key === " " || key === "Space";
  const draft = structuredClone(state.draft);

  if (row.type === "account") {
    const record = draft.providers.records[providerId] ??= createProviderConfig();
    const accounts = record.accounts ??= {};
    const current = accounts[row.id] ?? { enabled: true, label: "" };
    if (row.field === "enabled" && (forwards || backwards)) accounts[row.id] = { ...current, enabled: !current.enabled };
    else if (row.field === "label" && isTextInput(key)) accounts[row.id] = { ...current, label: sanitizeDisplayString(editText(current.label, key)) };
    else return { state, action: "none" };
    return { state: { ...state, draft }, action: "none" };
  }
  if (row.type === "policy" && (forwards || backwards)) {
    if (row.field === "missingDataPolicy") setProviderMissingDataPolicy(draft, providerId, cycle(["cached", "hide", "na", "warning", "provider-name"] as const, detail.missingDataPolicy, backwards));
    else {
      const value = detail.refresh[row.field as keyof typeof detail.refresh];
      const field = row.field === "intervalMs" ? "refreshIntervalMs" : row.field === "maxAgeMs" ? "maxCacheAgeMs" : row.field;
      setProviderRefreshOverrides(draft, providerId, { ...draft.providers.records[providerId]?.refresh, [field]: typeof value === "boolean" ? !value : value + (backwards ? -10_000 : 10_000) });
    }
    return { state: { ...state, draft }, action: "none" };
  }
  if (row.type === "refresh-now" && forwards) {
    return { state, action: "none", effect: providers.accounts?.[providerId] ? { type: "refresh-provider", providerId } : requestProviderRefresh(draft, providerId, providers.capabilities[providerId], providers.activeProvider === providerId) };
  }
  if (row.type === "reset" && forwards) {
    resetProvider(draft, providerId);
    const resetDetail = buildProviderDetail(draft, providers, providerId);
    const resetRows = resetDetail ? detailRows({ ...state, draft }, providers, resetDetail) : [];
    return { state: { ...state, draft, selected: Math.max(0, resetRows.length - 1) }, action: "none" };
  }
  if (row.type === "active" && (forwards || backwards)) {
    cycleActiveModelOverride(draft, providerId, row.segment);
    if (backwards) cycleActiveModelOverride(draft, providerId, row.segment);
  } else if (row.type === "window") {
    const settings = detail.quotaWindows.find((window) => window.key === row.key)?.settings;
    if (!settings) return { state, action: "none" };
    if (row.field === "label" && isTextInput(key)) {
      updateProviderWindow(draft, providerId, row.key, { ...settings, label: editText(settings.label, key) });
    } else if (row.field === "width" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { ...settings, width: settings.width + (backwards ? -1 : 1) });
    } else if (row.field === "resetFormat" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { ...settings, resetFormat: cycle(RESET_FORMATS, settings.resetFormat, backwards) });
    } else if (typeof settings[row.field] === "boolean" && (forwards || backwards)) {
      updateProviderWindow(draft, providerId, row.key, { ...settings, [row.field]: !settings[row.field] });
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
  if (key === "Ctrl+S") return { state: { ...state, confirmClose: true }, action: "confirm-close" };
  if (key === "PageUp" || key === "PageDown") {
    let result: NavigationResult = { state, action: "none" };
    for (let i = 0; i < 8; i++) result = routeSettingsKey(result.state, key === "PageUp" ? "ArrowUp" : "ArrowDown", providers);
    return result;
  }

  if (key === "Escape") {
    if (state.section) {
      const index = sections(state, providers).findIndex((section) => section.id === state.section);
      return { state: { ...state, section: undefined, selected: Math.max(0, index) }, action: "none" };
    }
    if (state.selectedProviderId && providers) {
      const index = buildProviderScreen(state.draft, providers).rows.findIndex((row) => row.id === state.selectedProviderId);
      return { state: { ...state, selectedProviderId: undefined, selected: Math.max(0, index + 2) }, action: "none" };
    }
    if (state.openRow) return { state: { ...state, openRow: undefined, selected: 0 }, action: "none" };
    return isDirty(state)
      ? { state: { ...state, confirmClose: true }, action: "confirm-close" }
      : { state, action: "close" };
  }

  const menu = sections(state, providers);
  if (menu.length && !state.section) {
    let selected = Math.min(state.selected, menu.length - 1);
    if (key === "ArrowUp" || key === "k") selected = Math.max(0, selected - 1);
    if (key === "ArrowDown" || key === "j") selected = Math.min(menu.length - 1, selected + 1);
    if (key === "Home") selected = 0;
    if (key === "End") selected = menu.length - 1;
    if (key === "Enter" || key === "ArrowRight") return { state: { ...state, section: menu[selected].id, selected: 0 }, action: "open" };
    return { state: { ...state, selected }, action: "none" };
  }

  if (state.openRow === "separators") {
    const routed = routeSeparatorsKey(state.draft, state.selected, key, state.section);
    return { state: { ...state, ...routed }, action: "none" };
  }

  if (state.openRow === "emojis") {
    const providerIds = providers?.descriptors.map(({ id }) => id) ?? [];
    const routed = routeEmojisKey(state.draft, state.selected, key, providerIds, state.section);
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
  if (row.id === "reset") return { state: resetDraft(state), action: "none" };
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
  /** Live session snapshot for the "current" preview mode, so the in-app preview reflects the real footer. */
  current?: ResolutionContext;
  /** Caller-owned discovery/capability snapshot; rendering never performs discovery or refresh. */
  providers?: ProviderUiContext;
  /** Available terminal rows; when set, the body scrolls to keep the selected row visible. */
  viewportRows?: number;
  /** Live terminal theme, so the preview line matches the footer's colors. */
  theme?: RenderTheme;
}

/** Key bindings in effect for the active screen, shown as a legend inside the window. */
function keyLegend(state: SettingsUiState): string {
  if (state.confirmClose) return "S Save  ·  D Discard  ·  Esc Cancel";
  if ((sections(state).length || state.selectedProviderId) && !state.section) return "↑↓ Move  ·  Enter Open  ·  Ctrl+S Save  ·  Esc Back";
  if (state.selectedProviderId) return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Esc Back";
  if (state.openRow === "providers") return "↑↓ Move  ·  Space Toggle  ·  Enter Details  ·  Ctrl↑↓ Reorder  ·  Esc Back";
  if (state.openRow === "separators") return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Ctrl↑↓ Reorder  ·  Esc Back";
  if (state.openRow === "emojis") return "↑↓ Move  ·  ←→/Enter Change  ·  Type chars  ·  ⌫ Delete  ·  Esc Back";
  return "↑↓ Move  ·  Enter Open / Reset  ·  Ctrl+S Save  ·  Esc Quit";
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
  const viewportRows = options.viewportRows ?? 0;
  if (options.width < 4 || (viewportRows > 0 && viewportRows < 4)) {
    return [truncateToWidth("Statusline", Math.max(0, options.width), "")];
  }
  const width = options.width;
  const inner = width - 2;
  const rendered = renderSettingsUi(state, { ...options, width: inner });
  const previewStart = rendered.indexOf("");
  const body = previewStart < 0 ? rendered : rendered.slice(0, previewStart);
  let preview = previewStart < 0 ? [] : rendered.slice(previewStart + 1);
  let legend = wrapLegend(keyLegend(state), inner);
  if (viewportRows > 0 && 3 + legend.length >= viewportRows) legend = [keyLegend(state)];
  const baseChrome = 3 + legend.length; // top border + legend separator + bottom border + legend
  if (viewportRows > 0) preview = preview.slice(0, Math.max(0, viewportRows - baseChrome - 2));
  const previewRows = preview.length ? preview.length + 1 : 0; // pinned preview plus its separator

  let view = body;
  let scrollNote: string | undefined;
  if (viewportRows > 0 && body.length + previewRows + baseChrome > viewportRows) {
    const available = Math.max(0, viewportRows - previewRows - baseChrome);
    const showScrollNote = available >= 2;
    const viewport = Math.max(0, available - (showScrollNote ? 1 : 0));
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
    if (showScrollNote) scrollNote = parts.join("  ·  ");
  }

  const title = truncateToWidth(" Statusline ", Math.max(0, inner - 1), "");
  const titleFill = Math.max(0, inner - 1 - visibleWidth(title));
  const out: string[] = [
    "┌─" + title + "─".repeat(titleFill) + "┐",
    ...view.map((line) => `│${fitLine(line.startsWith("> ") && options.theme?.fg ? options.theme.fg("accent", line) : line, inner)}│`),
  ];
  if (scrollNote) out.push(`│${fitLine(scrollNote, inner)}│`);
  if (preview.length) out.push("├" + "─".repeat(inner) + "┤", ...preview.map((line) => `│${fitLine(line, inner)}│`));
  out.push("├" + "─".repeat(inner) + "┤", ...legend.map((hint) => `│${fitLine(hint, inner)}│`), "└" + "─".repeat(inner) + "┘");
  return out;
}

/** Pure component rendering; previews use the production footer renderer. */
export function renderSettingsUi(state: SettingsUiState, options: RenderSettingsUiOptions): string[] {
  const lines = [`Statusline settings${isDirty(state) ? " — unsaved" : ""}`];
  if (state.confirmClose) return ["Save changes? S Save / D Discard / Esc Cancel", ...(state.error ? [`Save failed: ${state.error}`] : [])];
  const menu = sections(state, options.providers);
  if (menu.length && !state.section) {
    lines.push(state.selectedProviderId ? `Provider: ${state.selectedProviderId}` : state.openRow === "emojis" ? "Icons" : "Display");
    for (const [index, row] of menu.entries()) lines.push(`${state.selected === index ? ">" : " "} ${row.label} >`);
  } else if (state.openRow === "separators") {
    lines.push(`Display > ${DISPLAY_GROUPS.find((group) => group.id === state.section)?.label ?? "Controls"}`);
    for (const [index, row] of buildSeparatorsScreen(state.draft).filter((row) => !state.section || displayGroup(row.id) === state.section).entries()) {
      lines.push(`${state.selected === index ? ">" : " "} ${row.label}`);
    }
  } else if (state.openRow === "emojis") {
    lines.push(`Icons > ${state.section === "symbols" ? "Style & symbols" : state.section}`);
    const providerIds = options.providers?.descriptors.map(({ id }) => id) ?? [];
    for (const [index, row] of buildEmojisScreen(state.draft, providerIds).filter((row) => !state.section || (state.section === "symbols" ? !row.id.startsWith("icons.providers.") : row.id.startsWith(`icons.providers.${state.section}.`))).entries()) {
      lines.push(`${state.selected === index ? ">" : " "} ${row.label}`);
    }
  } else if (state.openRow === "providers" && options.providers) {
    const screen = buildProviderScreen(state.draft, options.providers);
    if (state.selectedProviderId) {
      const detail = buildProviderDetail(state.draft, options.providers, state.selectedProviderId);
      if (detail) {
        const health = options.providers.health?.[state.selectedProviderId];
        const accounts = options.providers.accounts?.[state.selectedProviderId];
        if (state.section === "accounts") lines.push("Add / sign in / switch accounts in your provider addon.", "Display > Order & provider rows > Accounts: selected shows all selected accounts.");
        lines.push(`Provider: ${detail.row.label}`,
          `Source: ${accounts ? accounts.source : health?.updatedAt ? health.cached ? "cached usage" : "provider usage" : "unavailable"}; ${detail.row.freshness}`,
          `Last success: ${health?.updatedAt ? new Date(health.updatedAt).toISOString() : "unavailable"}`);
        if (health?.reason) lines.push(health.reason);
        for (const window of detail.quotaWindows) {
          if (window.resetAt) lines.push(`${window.label} resets: ${new Date(window.resetAt).toISOString()}`);
        }
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
        lines.push(`${state.selected === index + 2 ? ">" : " "} ${row.enabled ? "[x]" : "[ ]"} ${row.label}${row.active ? " (active)" : ""} — ${row.quota === "Available" ? row.freshness : "quota unavailable"}`);
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
      current: options.current,
      providers: options.providers,
      selectedProviderId: state.selectedProviderId,
      theme: options.theme,
    }));
  }
  return lines;
}
