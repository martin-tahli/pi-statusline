import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import {
  ROOT_ROWS,
  createSettingsUi,
  isDirty,
  renderSettingsUi,
  replaceDraft,
  resetDraft,
  resolveDirtyChoice,
  routeSettingsKey,
} from "../src/settings/ui.ts";
import {
  buildProviderDetail,
  buildProviderScreen,
  cycleActiveModelOverride,
  moveProvider,
  reconcileProviderWindows,
  requestProviderRefresh,
  setProviderDisplayMode,
  setProviderIcon,
  setProviderMissingDataPolicy,
  setProviderRefreshOverrides,
  toggleProvider,
  updateProviderWindow,
  type ProviderUiContext,
} from "../src/settings/provider-ui.ts";
import type { ProviderCapability } from "../src/settings/providers/capabilities.ts";
import { buildSeparatorsScreen } from "../src/settings/separators-screen.ts";
import { buildEmojisScreen, ICON_SYMBOLS } from "../src/settings/emojis-screen.ts";

test("root rows and keyboard routing are exact and deterministic", () => {
  assert.deepEqual(ROOT_ROWS.map(({ label }) => label), ["Providers", "Separators", "Emojis"]);

  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(routeSettingsKey(initial, "ArrowUp").state.selected, 0);
  assert.equal(routeSettingsKey(initial, "End").state.selected, ROOT_ROWS.length - 1);
  assert.equal(routeSettingsKey(initial, "x").state, initial);
  const moved = routeSettingsKey(initial, "ArrowDown").state;
  assert.equal(moved.selected, 1);
  assert.equal(routeSettingsKey(initial, "Enter").state.openRow, "providers");
  assert.equal(routeSettingsKey({ ...moved, openRow: "providers" }, "Escape").state.openRow, undefined);
  assert.deepEqual(initial, createSettingsUi(DEFAULT_STATUSLINE_SETTINGS));
});

test("draft creation, replacement, and reset are structured-cloned", () => {
  const source = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  const state = createSettingsUi(source);
  state.draft.layout.segmentOrder.reverse();
  assert.notDeepEqual(state.draft.layout.segmentOrder, source.layout.segmentOrder);

  const replacement = structuredClone(source);
  replacement.enabled = false;
  const replaced = replaceDraft(state, replacement);
  replacement.layout.segmentOrder.reverse();
  assert.notDeepEqual(replaced.draft.layout.segmentOrder, replacement.layout.segmentOrder);
  assert.equal(isDirty(replaced), true);

  replaced.draft.__unknown = { nested: { kept: true } };
  const reset = resetDraft(replaced);
  assert.deepEqual(reset.draft.layout, DEFAULT_STATUSLINE_SETTINGS.layout);
  assert.deepEqual(reset.draft.__unknown, { nested: { kept: true } });
  assert.notEqual(reset.draft.__unknown, replaced.draft.__unknown);
});

test("render uses production preview fixtures and hides preview when narrow without mutation", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const before = structuredClone(state);
  const wide = renderSettingsUi(state, { width: 100, previewMode: "local" });
  assert.ok(wide.includes("Local model preview"));
  assert.ok(wide.length > ROOT_ROWS.length + 1);

  const narrow = renderSettingsUi(state, { width: 79, previewMode: "local" });
  assert.equal(narrow.includes("Local model preview"), false);
  assert.equal(narrow.length, ROOT_ROWS.length + 1);
  assert.deepEqual(state, before);
});

test("dirty Save, Discard, and Cancel preserve state correctly", async () => {
  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const dirty = replaceDraft(initial, { ...initial.draft, enabled: false });
  const prompted = routeSettingsKey(dirty, "Escape").state;
  assert.equal(prompted.confirmClose, true);

  const cancelled = await resolveDirtyChoice(prompted, "cancel", () => assert.fail("must not save"));
  assert.equal(cancelled.action, "none");
  assert.equal(cancelled.state.draft.enabled, false);

  const discarded = await resolveDirtyChoice(prompted, "discard", () => assert.fail("must not save"));
  assert.equal(discarded.action, "close");
  assert.equal(discarded.state.draft.enabled, true);
  assert.notEqual(discarded.state.draft, discarded.state.original);

  const failed = await resolveDirtyChoice(prompted, "save", async (value) => {
    value.enabled = true;
    throw new Error("disk full");
  });
  assert.equal(failed.action, "confirm-close");
  assert.equal(failed.state.confirmClose, true);
  assert.equal(failed.state.error, "disk full");
  assert.equal(failed.state.draft.enabled, false);
  assert.equal(isDirty(failed.state), true);

  let saved: typeof initial.draft | undefined;
  const succeeded = await resolveDirtyChoice(prompted, "save", (value) => { saved = value; });
  assert.equal(succeeded.action, "close");
  assert.equal(succeeded.state.confirmClose, false);
  assert.equal(isDirty(succeeded.state), false);
  assert.notEqual(saved, succeeded.state.draft);
});

const supportedCapability: ProviderCapability = {
  available: true, authenticated: true, modelCount: 1, billing: "subscription",
  quotaSupport: "official", quotaReliability: "high", localSpeed: false,
  hostedSpeed: true, tokenLedger: false, costLedger: false,
};
const unavailableCapability: ProviderCapability = {
  available: false, authenticated: false, modelCount: 0, billing: "unknown",
  quotaSupport: "none", quotaReliability: "none", localSpeed: false,
  hostedSpeed: false, tokenLedger: false, costLedger: false,
  unavailableReason: "usage unavailable\u001b[31m",
};
const providerContext: ProviderUiContext = {
  descriptors: [
    { id: "dynamic-a", displayName: "Dynamic A", provenance: ["available"], available: true, authenticated: true, models: [{ provider: "dynamic-a" }] },
    { id: "stored-x", displayName: "Stored X", provenance: ["stored"], available: false, authenticated: false, models: [] },
  ],
  capabilities: { "dynamic-a": supportedCapability, "stored-x": unavailableCapability },
  health: { "dynamic-a": { state: "fresh" }, "stored-x": { state: "unknown" } },
  windows: { "dynamic-a": [{ key: "short", label: "Renamed", used: 0.2 }] },
  activeProvider: "dynamic-a",
};

test("provider screen key routing edits the shared draft and persists provider order", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";

  state = routeSettingsKey(state, "Space", providerContext).state;
  assert.equal(state.draft.enabled, false);
  state = routeSettingsKey(state, "ArrowDown", providerContext).state;
  state = routeSettingsKey(state, " ", providerContext).state;
  assert.equal(state.draft.providers.enabled, false);
  state = routeSettingsKey(state, "ArrowDown", providerContext).state;
  state = routeSettingsKey(state, "Space", providerContext).state;
  assert.equal(state.draft.providers.records["dynamic-a"].enabled, false);
  state = routeSettingsKey(state, "Ctrl+ArrowDown", providerContext).state;
  assert.deepEqual(state.draft.providers.order, ["stored-x", "dynamic-a"]);
  assert.equal(state.selected, 3);
  assert.deepEqual(buildProviderScreen(state.draft, providerContext).rows.map((row) => row.id), ["stored-x", "dynamic-a"]);
});

test("provider screen is truthful, capability-gated, and integrated without I/O", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";
  const screen = buildProviderScreen(state.draft, providerContext);
  assert.equal(screen.statuslineEnabled, true);
  assert.equal(screen.providerTrackingEnabled, true);
  assert.deepEqual(screen.rows.map((row) => row.id), ["dynamic-a", "stored-x"]);
  assert.equal(screen.rows[1].quota, "Not available: usage unavailable");
  setProviderDisplayMode(state.draft, "dynamic-a", "custom", providerContext.windows!["dynamic-a"]);
  cycleActiveModelOverride(state.draft, "dynamic-a", "context");
  setProviderIcon(state.draft, "dynamic-a", { mode: "custom", value: "D" });
  setProviderMissingDataPolicy(state.draft, "dynamic-a", "warning");
  setProviderRefreshOverrides(state.draft, "dynamic-a", {
    refreshIntervalMs: 20_000,
    maxCacheAgeMs: 40_000,
    useCache: false,
    keepAfterFailure: false,
    refreshWhileActive: true,
    refreshDisabledProvider: true,
  });
  updateProviderWindow(state.draft, "dynamic-a", "short", {
    visible: false,
    label: "Mine",
    showBar: false,
    showPercent: false,
    showReset: true,
    resetFormat: "exact-date",
    showUsed: false,
    showRemaining: false,
    showZero: true,
    width: 18,
  });
  const detail = buildProviderDetail(state.draft, providerContext, "dynamic-a")!;
  assert.equal(detail.displayMode, "custom");
  assert.equal(detail.activeModel.context, "off");
  assert.deepEqual(detail.providerIcon, { mode: "custom", value: "D" });
  assert.equal(detail.missingDataPolicy, "warning");
  assert.deepEqual(detail.refresh, {
    intervalMs: 20_000, maxAgeMs: 40_000, useCache: false, keepAfterFailure: false,
    refreshWhileActive: true, refreshDisabledProvider: true,
  });
  assert.equal(detail.refreshNowEligible, true);
  assert.equal(detail.hostedThroughput, true);
  assert.equal(detail.localThroughput, false);
  assert.equal(detail.tokenLedger, false);
  assert.deepEqual(detail.quotaWindows[0].settings, {
    visible: false, label: "Mine", showBar: false, showPercent: false, showReset: true,
    resetFormat: "exact-date", showUsed: false, showRemaining: false, showZero: true, width: 18,
  });
  state.selectedProviderId = "dynamic-a";
  state.selected = 0;
  const lines = renderSettingsUi(state, { width: 79, providers: providerContext });
  assert.ok(lines.some((line) => line === "Provider: Dynamic A"));
  assert.ok(lines.some((line) => line === "> Display mode: custom"));
  assert.ok(lines.some((line) => line === "  Provider icon: custom"));
  assert.ok(lines.some((line) => line === "  Provider icon value: D"));
  assert.ok(lines.some((line) => line === "  Missing data: warning"));
  assert.ok(lines.some((line) => line === "  Refresh now"));
  assert.ok(lines.some((line) => line === "  Mine Reset format: exact-date"));
  assert.ok(lines.some((line) => line === "  Mine Width: 18"));
});

test("provider draft actions retain configuration, stable order, overrides, and icon path", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.providers.order = ["dynamic-a", "stored-x"];
  toggleProvider(draft, "dynamic-a");
  assert.equal(draft.providers.records["dynamic-a"].enabled, false);
  moveProvider(draft, "stored-x", "up");
  assert.deepEqual(draft.providers.order, ["stored-x", "dynamic-a"]);
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Short", used: 0.2 }]);
  assert.ok(draft.providers.records["dynamic-a"].windows.short);
  cycleActiveModelOverride(draft, "dynamic-a", "context");
  assert.equal(draft.providers.records["dynamic-a"].activeModel.context, "off");
  setProviderIcon(draft, "dynamic-a", { mode: "custom", value: "D" });
  assert.deepEqual(draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" });
});

test("display mode and window reconciliation fail closed on invalid adapter keys", () => {
  const empty = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderDisplayMode(empty, "dynamic-a", "custom", [{ key: "", label: "Bad", used: 0 }]);
  assert.equal(empty.providers.records["dynamic-a"], undefined);

  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Old", used: 0.1 }]);
  const beforeProvider = structuredClone(draft.providers.records["dynamic-a"]);
  setProviderDisplayMode(draft, "dynamic-a", "default");
  setProviderDisplayMode(draft, "dynamic-a", "custom", [
    { key: "same", label: "A", used: 0 }, { key: "same", label: "B", used: 0 },
  ]);
  assert.equal(draft.providers.records["dynamic-a"].displayMode, "default");
  assert.deepEqual(draft.providers.records["dynamic-a"].windows, beforeProvider.windows);

  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [{ key: "short", label: "Old", used: 0.1 }]).ok, true);
  updateProviderWindow(draft, "dynamic-a", "short", { label: "Mine", width: 500 });
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [
    { key: "monthly", label: "Month", used: 0.3 }, { key: "short", label: "New", used: 0.2 },
  ]).ok, true);
  assert.equal(draft.providers.records["dynamic-a"].windows.short.label, "Mine");
  assert.equal(draft.providers.records["dynamic-a"].windows.short.width, 200);
  assert.equal(draft.providers.records["dynamic-a"].windows.monthly.width, 12);
  const before = structuredClone(draft.providers.records["dynamic-a"].windows);
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [{ key: "", label: "Bad", used: 0 }]).ok, false);
  assert.equal(reconcileProviderWindows(draft, "dynamic-a", [
    { key: "same", label: "A", used: 0 }, { key: "same", label: "B", used: 0 },
  ]).ok, false);
  assert.deepEqual(draft.providers.records["dynamic-a"].windows, before);
});

test("refresh/cache draft edits are bounded and reject non-finite ages", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  setProviderRefreshOverrides(draft, "dynamic-a", {
    refreshIntervalMs: 5_000,
    maxCacheAgeMs: 1,
    useCache: false,
  });
  assert.deepEqual(draft.providers.records["dynamic-a"].refresh, {
    refreshIntervalMs: 10_000,
    maxCacheAgeMs: 10_000,
    useCache: false,
  });
  setProviderRefreshOverrides(draft, "dynamic-a", { maxCacheAgeMs: Number.NaN });
  assert.deepEqual(draft.providers.records["dynamic-a"].refresh, {});
});

test("refresh-now is only an explicit effect for eligible providers", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  assert.deepEqual(requestProviderRefresh(draft, "dynamic-a", supportedCapability), { type: "refresh-provider", providerId: "dynamic-a" });
  assert.equal(requestProviderRefresh(draft, "stored-x", unavailableCapability), undefined);
});

test("provider detail navigation routes every editable control through the shared draft", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.openRow = "providers";
  state.selected = 2;
  let routed = routeSettingsKey(state, "Enter", providerContext);
  state = routed.state;
  assert.equal(state.selectedProviderId, "dynamic-a");

  const select = (text: string) => {
    const lines = renderSettingsUi(state, { width: 79, providers: providerContext });
    const line = lines.findIndex((value) => value.includes(text));
    assert.ok(line >= 2, `missing detail row: ${text}`);
    state = { ...state, selected: line - 2 };
  };
  const edit = (text: string, key = "Enter") => {
    select(text);
    routed = routeSettingsKey(state, key, providerContext);
    state = routed.state;
  };

  edit("Display mode:");
  assert.equal(state.draft.providers.records["dynamic-a"].displayMode, "custom");
  edit("Active model context:");
  assert.equal(state.draft.providers.records["dynamic-a"].activeModel.context, "off");
  edit("Provider icon:");
  assert.equal(state.draft.icons.providers["dynamic-a"].mode, "custom");
  edit("Provider icon value:", "D");
  assert.equal(state.draft.icons.providers["dynamic-a"].value, "D");
  edit("Missing data:");
  assert.equal(state.draft.providers.records["dynamic-a"].missingDataPolicy, "na");
  edit("Refresh interval:");
  assert.equal(state.draft.providers.records["dynamic-a"].refresh?.refreshIntervalMs, 20_000);
  edit("Use cache:");
  assert.equal(state.draft.providers.records["dynamic-a"].refresh?.useCache, false);
  edit("Refresh now");
  assert.deepEqual(routed.effect, { type: "refresh-provider", providerId: "dynamic-a" });
  edit("Renamed Visible:");
  assert.equal(state.draft.providers.records["dynamic-a"].windows.short.visible, false);
  edit("Renamed Width:", "ArrowRight");
  assert.equal(state.draft.providers.records["dynamic-a"].windows.short.width, 13);

  state = routeSettingsKey(state, "Escape", providerContext).state;
  assert.equal(state.selectedProviderId, undefined);
  assert.equal(state.selected, 2);
});

test("provider detail renders only capability-applicable rows", () => {
  const renderDetail = (context: ProviderUiContext) => {
    const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
    state.openRow = "providers";
    state.selectedProviderId = context.descriptors[0].id;
    return renderSettingsUi(state, { width: 79, providers: context });
  };
  const subscription = renderDetail(providerContext);
  assert.ok(subscription.includes("  Streaming output: Available"));
  assert.ok(subscription.some((line) => line.includes("Refresh interval:")));
  assert.equal(subscription.some((line) => /Local throughput|API token|API cost|Not available/.test(line)), false);

  const contextFor = (id: string, capability: ProviderCapability): ProviderUiContext => ({
    descriptors: [{ id, displayName: id, provenance: ["available"], available: true, authenticated: true, models: [{ provider: id }] }],
    capabilities: { [id]: capability },
  });
  const local = renderDetail(contextFor("local", {
    ...supportedCapability, billing: "local", quotaSupport: "none", quotaReliability: "none",
    localSpeed: true, hostedSpeed: false,
  }));
  assert.ok(local.includes("  Local throughput: Available"));
  assert.equal(local.some((line) => /Streaming output|API token|API cost|Refresh interval|Not available/.test(line)), false);

  const api = renderDetail(contextFor("api", {
    ...supportedCapability, billing: "api", quotaSupport: "none", quotaReliability: "none",
    tokenLedger: true, costLedger: true,
  }));
  assert.ok(api.includes("  Streaming output: Available"));
  assert.ok(api.includes("  API token ledger: Available"));
  assert.ok(api.includes("  API cost ledger: Available"));
  assert.equal(api.some((line) => /Local throughput|Refresh interval|Not available/.test(line)), false);
});

test("R19-R25 separators screen makes every schema-backed presentation domain reachable", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 1;
  state = routeSettingsKey(state, "Enter", providerContext).state;
  assert.equal(state.openRow, "separators");

  const ids = buildSeparatorsScreen(state.draft).map(({ id }) => id);
  for (const id of [
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.segments).map((key) => `segments.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.extras).map((key) => `extras.${key}`),
    "layout.segmentOrder.project", "layout.narrowPriority.time", "layout.providerRows", "layout.placement", "layout.maxWidth",
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.separators).map((key) => `separators.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.bars).map((key) => `bars.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.thresholds).map((key) => `thresholds.${key}`),
    ...Object.keys(DEFAULT_STATUSLINE_SETTINGS.timing).map((key) => `timing.${key}`),
  ]) assert.ok(ids.includes(id), `missing settings row ${id}`);

  const select = (id: string) => ({ ...state, selected: buildSeparatorsScreen(state.draft).findIndex((row) => row.id === id) });
  state = routeSettingsKey(select("segments.project"), "Space", providerContext).state;
  assert.equal(state.draft.segments.project, false);
  assert.equal(DEFAULT_STATUSLINE_SETTINGS.segments.project, true);

  state = routeSettingsKey(select("layout.segmentOrder.model"), "Ctrl+ArrowUp", providerContext).state;
  assert.deepEqual(state.draft.layout.segmentOrder.slice(0, 2), ["model", "project"]);
  state = routeSettingsKey(select("layout.narrowPriority.throughput"), "Ctrl+ArrowUp", providerContext).state;
  assert.deepEqual(state.draft.layout.narrowPriority.slice(0, 2), ["throughput", "time"]);

  state = routeSettingsKey(select("separators.main"), "X", providerContext).state;
  assert.equal(state.draft.separators.main, " · X");
  assert.equal(state.draft.separators.provider, "\n", "editing one field must not normalize another");
  state.draft.bars.width = 99;
  state = routeSettingsKey(select("reset.separators"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.separators, DEFAULT_STATUSLINE_SETTINGS.separators);
  assert.equal(state.draft.bars.width, 99, "section reset must be isolated");

  const original = structuredClone(state.original);
  state = routeSettingsKey(state, "Escape", providerContext).state;
  state = routeSettingsKey(state, "Escape", providerContext).state;
  assert.equal(state.confirmClose, true);
  assert.deepEqual(state.original, original);
});

test("text rows accept printable navigation letters and space before key actions", () => {
  let separators = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  separators.openRow = "separators";
  separators.selected = buildSeparatorsScreen(separators.draft).findIndex(({ id }) => id === "separators.main");
  const separatorRow = separators.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    separators = routeSettingsKey(separators, key, providerContext).state;
    assert.equal(separators.selected, separatorRow);
  }
  assert.equal(separators.draft.separators.main, " · hjkl ");

  let emojis = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  emojis.openRow = "emojis";
  const select = (id: string) => buildEmojisScreen(emojis.draft, providerContext.descriptors.map(({ id }) => id)).findIndex((row) => row.id === id);
  emojis.selected = select("icons.symbols.project");
  const symbolRow = emojis.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.selected, symbolRow);
  }
  assert.equal(emojis.draft.icons.symbols.project, "hjkl ");

  emojis.selected = select("icons.providers.dynamic-a.value");
  const providerValueRow = emojis.selected;
  for (const key of ["h", "j", "k", "l", " "]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.selected, providerValueRow);
  }
  assert.deepEqual(emojis.draft.icons.providers["dynamic-a"], { mode: "custom", value: "hjkl " });
});

test("text rows normalize the Space key and reject named command keys", () => {
  let separators = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  separators.openRow = "separators";
  separators.selected = buildSeparatorsScreen(separators.draft).findIndex(({ id }) => id === "separators.main");
  const sepRow = separators.selected;
  const sepBefore = separators.draft.separators.main;
  for (const key of ["Tab", "F1", "Ctrl+ArrowUp", "Ctrl+Down"]) {
    separators = routeSettingsKey(separators, key, providerContext).state;
    assert.equal(separators.draft.separators.main, sepBefore, `${key} must not append as text`);
    assert.equal(separators.selected, sepRow, `${key} must not move selection on a text row`);
  }
  separators = routeSettingsKey(separators, "Space", providerContext).state;
  separators = routeSettingsKey(separators, " ", providerContext).state;
  assert.equal(separators.draft.separators.main, sepBefore + "  ", "both Space key forms append a single space");

  let emojis = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  emojis.openRow = "emojis";
  const ids = providerContext.descriptors.map(({ id }) => id);
  const pick = (id: string) => buildEmojisScreen(emojis.draft, ids).findIndex((row) => row.id === id);
  emojis.selected = pick("icons.symbols.project");
  for (const key of ["Tab", "F1", "Ctrl+ArrowUp"]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.equal(emojis.draft.icons.symbols.project ?? "", "", `${key} must not append as text on a symbol row`);
  }
  emojis = routeSettingsKey(emojis, "Space", providerContext).state;
  emojis = routeSettingsKey(emojis, " ", providerContext).state;
  assert.equal(emojis.draft.icons.symbols.project, "  ", "both Space key forms append a single space on a symbol row");

  emojis.selected = pick("icons.providers.dynamic-a.value");
  for (const key of ["Tab", "Ctrl+ArrowUp"]) {
    emojis = routeSettingsKey(emojis, key, providerContext).state;
    assert.deepEqual(emojis.draft.icons.providers["dynamic-a"] ?? { mode: "default", value: "" }, { mode: "default", value: "" }, `${key} must not append as text on a provider-value row`);
  }
  emojis = routeSettingsKey(emojis, "Space", providerContext).state;
  assert.deepEqual(emojis.draft.icons.providers["dynamic-a"], { mode: "custom", value: " " }, "named Space normalizes to a single space on a provider-value row");

  // a single hostile char that passes the allowlist is still stripped by validation (UI -> validation sanitization)
  emojis.selected = pick("icons.symbols.model");
  emojis = routeSettingsKey(emojis, "\u202e", providerContext).state;
  assert.equal(emojis.draft.icons.symbols.model ?? "", "", "bidi override stripped by validation");
});

test("R26 emojis routes styles, named symbols, and dynamic provider icons through one draft path", () => {
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 2;
  state = routeSettingsKey(state, "Enter", providerContext).state;
  assert.equal(state.openRow, "emojis");
  const initialRows = buildEmojisScreen(state.draft, providerContext.descriptors.map(({ id }) => id));
  const ids = initialRows.map(({ id }) => id);
  for (const symbol of ICON_SYMBOLS) assert.ok(ids.includes(`icons.symbols.${symbol}`));
  for (const providerId of ["dynamic-a", "stored-x"]) {
    assert.ok(ids.includes(`icons.providers.${providerId}.mode`));
    assert.ok(ids.includes(`icons.providers.${providerId}.value`));
  }

  const select = (id: string) => ({
    ...state,
    selected: buildEmojisScreen(state.draft, providerContext.descriptors.map(({ id }) => id)).findIndex((row) => row.id === id),
  });
  state = routeSettingsKey(select("icons.style"), "ArrowLeft", providerContext).state;
  assert.equal(state.draft.icons.style, "custom");
  state = routeSettingsKey(select("icons.symbols.project"), "P", providerContext).state;
  assert.equal(state.draft.icons.symbols.project, "P");
  state = routeSettingsKey(select("icons.providers.dynamic-a.mode"), "Enter", providerContext).state;
  assert.equal(state.draft.icons.providers["dynamic-a"].mode, "global");
  state = routeSettingsKey(select("icons.providers.dynamic-a.value"), "D", providerContext).state;
  assert.deepEqual(state.draft.icons.providers["dynamic-a"], { mode: "custom", value: "D" });

  const detail = buildProviderDetail(state.draft, providerContext, "dynamic-a")!;
  assert.deepEqual(detail.providerIcon, state.draft.icons.providers["dynamic-a"]);
  state = routeSettingsKey(select("reset.icons"), "Enter", providerContext).state;
  assert.deepEqual(state.draft.icons, DEFAULT_STATUSLINE_SETTINGS.icons);
});

test("default to custom snapshots every effective provider and window value", () => {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.segments.context = false;
  draft.bars.showPercent = false;
  draft.bars.width = 21;
  draft.providers.defaults = {
    ...draft.providers.defaults,
    missingDataPolicy: "warning",
    refreshIntervalMs: 20_000,
    maxCacheAgeMs: 40_000,
    useCache: false,
    keepAfterFailure: false,
    refreshWhileActive: false,
    refreshDisabledProvider: true,
  };
  setProviderDisplayMode(draft, "dynamic-a", "custom", [{ key: "short", label: "Effective", used: 0.2 }]);
  const record = draft.providers.records["dynamic-a"];
  assert.equal(record.displayMode, "custom");
  assert.equal(record.activeModel.context, "off");
  assert.equal(record.activeModel.project, "on");
  assert.equal(record.missingDataPolicy, "warning");
  assert.deepEqual(record.refresh, {
    refreshIntervalMs: 20_000, maxCacheAgeMs: 40_000, useCache: false,
    keepAfterFailure: false, refreshWhileActive: false, refreshDisabledProvider: true,
  });
  assert.deepEqual(draft.icons.providers["dynamic-a"], { mode: "global", value: "" });
  assert.deepEqual(record.windows.short, {
    visible: true, label: "Effective", showBar: true, showPercent: false, showReset: true,
    resetFormat: "countdown", showUsed: true, showRemaining: true, showZero: false, width: 21,
  });
});

test("preview reflects draft mutations and updates when the draft changes", () => {
  // Wide render includes the preview section; any mutation to the draft must change it.
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const before = renderSettingsUi(state, { width: 100, previewMode: "local" });
  // The preview renders using state.draft; toggling a visible segment changes the footer output.
  const mutated = replaceDraft(state, { ...state.draft, segments: { ...state.draft.segments, model: false } });
  const after = renderSettingsUi(mutated, { width: 100, previewMode: "local" });
  assert.ok(before.length > 1 && after.length > 1, "preview must be non-empty");
  const previewBefore = before.slice(before.indexOf("") + 1).join("\n");
  const previewAfter = after.slice(after.indexOf("") + 1).join("\n");
  assert.notEqual(previewBefore, previewAfter, "preview must change when the draft changes");
});

test("long-list navigation: End jumps to last row, Home returns to first; selection stays in bounds", () => {
  // Separators screen has many rows (segments + extras + layout + separators + bars + thresholds + timing).
  let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  state.selected = 1; // Separators
  state = routeSettingsKey(state, "Enter").state;
  assert.equal(state.openRow, "separators");

  const totalRows = buildSeparatorsScreen(state.draft).length;
  assert.ok(totalRows > 10, "separators screen must be a long list");

  // End key jumps to the last row.
  state = routeSettingsKey(state, "End").state;
  assert.equal(state.selected, totalRows - 1, "End key must select the last row");

  // ArrowDown past the end must stay clamped at the last row.
  state = routeSettingsKey(state, "ArrowDown").state;
  assert.equal(state.selected, totalRows - 1, "ArrowDown at last row must stay clamped");

  // Home key returns to the first row.
  state = routeSettingsKey(state, "Home").state;
  assert.equal(state.selected, 0, "Home key must select the first row");

  // ArrowUp at the first row must stay clamped at zero.
  state = routeSettingsKey(state, "ArrowUp").state;
  assert.equal(state.selected, 0, "ArrowUp at first row must stay clamped");
});
