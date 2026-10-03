import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import statusline from "../extensions/statusline.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig } from "../src/settings/defaults.ts";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { renderMainLine, renderSessionWindows, renderProviderRows, arrangeFooterLines, missingUsageLabel } from "../src/render.ts";
import { composeSegments } from "../src/segments.ts";
import { isLocalEndpoint, deriveEffort } from "../src/derive.ts";
import { parseStoredRateLimits } from "../src/ratelimit.ts";
import { ProviderRefreshCoordinator } from "../src/providers.ts";
import { createSettingsUi, routeSettingsKey, renderSettingsUi, renderSettingsWindow } from "../src/settings/ui.ts";
import { buildEmojisScreen } from "../src/settings/emojis-screen.ts";
import { updateProviderWindow } from "../src/settings/provider-ui.ts";
import { providerRefreshEnabled } from "../src/settings/refresh.ts";
import { getAdapter } from "../src/settings/providers/adapters.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

const settings = () => structuredClone(DEFAULT_STATUSLINE_SETTINGS);
const quota = [{ key: "primary", label: "5h", used: .4 }];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("cloud generation never displays character-based token speed; local speed is approximate", () => {
  const s = settings(); s.segments.throughput = true;
  for (const subscription of [false, true]) {
    const snap = { cwd: "/tmp", model: { id: "model", baseUrl: "https://cloud.example" }, subscription, turnActive: true,
      meter: { outputRate: 50, avgInputRate: 1000, avgOutputRate: 50 }, totals: { input: 123, output: 45 } };
    assert.doesNotMatch(renderMainLine(s, snap, 500), /t\/s|~50/);
    assert.match(renderMainLine(s, { ...snap, model: { id: "local", baseUrl: "http://localhost:8000" } }, 500), /~50.*t\/s/);
  }
  assert.equal(isLocalEndpoint("https://10.not-local.example"), false);
  assert.equal(isLocalEndpoint("http://127.0.0.2:8000"), true);
  assert.equal(deriveEffort("high", { reasoning: false }), "");
  assert.equal(deriveEffort("high"), "");
});

test("configured window visibility, amounts, separators, layout and thresholds affect real rendering", () => {
  const s = settings(); s.bars.format = "detailed";
  s.providers.records.test = createProviderConfig();
  const win = { key: "budget", label: "budget", used: .2, unit: "USD" as const, usedAmount: 2, remainingAmount: 8 };
  updateProviderWindow(s, "test", "budget", { showUsed: false, showRemaining: true });
  const amounts = renderSessionWindows(s, "test", [win], undefined, 0);
  assert.doesNotMatch(amounts, /\$2.00/); assert.match(amounts, /\$8.00 left/);
  s.providers.records.test.windows.budget.showZero = false;
  assert.equal(renderSessionWindows(s, "test", [{ ...win, used: 0 }], undefined, 0), "");
  s.separators.window = " / "; s.separators.labelValue = ": ";
  assert.match(renderSessionWindows(s, "test", [win, { ...win, key: "other" }], undefined, 0), /budget: .* \/ budget:/);
  s.layout.providerRows = "inline"; s.separators.provider = " ++ "; s.layout.placement = "above";
  const rows = renderProviderRows(s, [{ provider: "one", windows: quota }, { provider: "two", windows: quota }], undefined, 0, 300);
  assert.equal(rows.length, 1); assert.match(rows[0], / \+\+ /);
  assert.equal(arrangeFooterLines(s, "main", rows).at(-1), "main");
  s.layout.maxWidth = 15;
  assert.ok(renderProviderRows(s, [{ provider: "one", windows: quota }], undefined, 0, 300).every((line) => visibleWidth(line) <= 15));
  s.providers.records.test.thresholds = { contextWarn: 10, contextCrit: 20 };
  assert.match(renderMainLine(s, { cwd: "/tmp", model: { id: "test", provider: "test" }, contextUsage: { tokens: 30, contextWindow: 100, percent: 30 } }, 300,
    { fg: (role, text) => `<${role}>${text}</${role}>` }), /<error>30.0%/);
});

test("quota compaction counts separator columns once", () => {
  const budgets: number[] = [];
  const line = composeSegments([
    { id: "model", enabled: true, render: () => "model" },
    { id: "context", enabled: true, render: () => "ctx" },
    { id: "session", enabled: true, render: (budget) => { if (budget !== undefined) budgets.push(budget); return budget === undefined ? "a long quota segment" : "quota"; } },
  ], 17, " | ", ["session"]);
  assert.deepEqual(budgets, [3]); // 5 + 3 text columns and two 3-column separators.
  assert.equal(line, "model | ctx");
});

test("settings and stored usage sanitize terminal injection and reserved dictionary keys", () => {
  const s = parseStatuslineSettings(JSON.parse('{"version":1,"providers":{"records":{"__pro\\u001b[0mto__":{"enabled":true}}},"icons":{"providers":{"__proto__":{"mode":"custom","value":"bad"}}}}')).settings;
  assert.equal(Object.hasOwn(s.providers.records, "__proto__"), false);
  assert.equal(Object.getPrototypeOf(s.providers.records), Object.prototype);
  assert.equal(Object.hasOwn(s.icons.providers, "__proto__"), false);
  const restored = parseStoredRateLimits([{ label: "\u001b[31mquota\t\n", used: .2, resetAt: 100_000 }]);
  assert.equal(restored[0].label, "quota"); assert.equal(restored[0].resetAt, 100_000);
});

test("small category menus, Unicode editing, save prompts and page navigation remain accessible", () => {
  let state = createSettingsUi(settings());
  state.selected = 1; state = routeSettingsKey(state, "Enter").state;
  assert.equal(renderSettingsUi(state, { width: 79 }).filter((line) => /^[ >] /.test(line)).length, 8);
  state = routeSettingsKey(state, "ArrowDown").state;
  state = routeSettingsKey(state, "Enter").state;
  assert.equal(state.section, "segments");
  state = routeSettingsKey(state, "Escape").state;
  assert.equal(state.selected, 1); assert.equal(state.section, undefined);
  state.openRow = "emojis"; state.section = "symbols";
  state.selected = buildEmojisScreen(state.draft).findIndex((row) => row.id === "icons.symbols.time");
  for (const key of ["A", "👩‍💻", "Backspace", "B"]) state = routeSettingsKey(state, key).state;
  assert.equal(state.draft.icons.symbols.time, "AB");
  state = routeSettingsKey(state, "Ctrl+S").state;
  for (const width of [40, 80, 120]) {
    const lines = renderSettingsWindow(state, { width, viewportRows: 8 });
    assert.ok(lines.length <= 8); assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.match(lines.join("\n"), /Save/); assert.match(lines.join("\n"), /Discard/);
  }
});

test("refresh eligibility honors disabled footer, active overrides and selected scope consistently", () => {
  const s = settings(); s.providers.enabled = false; s.segments.session = false;
  s.providers.records.test = createProviderConfig(); s.providers.records.test.activeModel.session = "on";
  assert.equal(providerRefreshEnabled(s, "test", true), true);
  s.enabled = false; assert.equal(providerRefreshEnabled(s, "test", true), false);
  s.enabled = true; s.providers.enabled = true;
  assert.equal(providerRefreshEnabled(s, "test", false), false);
  s.providers.scope = "selected"; assert.equal(providerRefreshEnabled(s, "test", false), true);
  for (const [policy, expected] of [["hide", ""], ["na", "N/A"], ["warning", "! usage unavailable"]] as const) {
    s.providers.defaults.missingDataPolicy = policy; assert.equal(missingUsageLabel(s, "test"), expected);
  }
});

test("a slow cached response cannot overwrite newer response-header usage", async () => {
  let resolve!: (value: any) => void;
  const coordinator = new ProviderRefreshCoordinator(new Map([["test", { refresh: () => new Promise<any>((done) => { resolve = done; }) }]]), () => {});
  const pending = coordinator.refresh("test");
  const now = Date.now(); coordinator.prime("test", { limits: quota }, now);
  resolve({ limits: [{ ...quota[0], used: .1 }], updatedAt: now - 1000, cached: true });
  await pending;
  const health = coordinator.get("test");
  assert.equal(health.state, "fresh");
  if (health.state === "fresh") assert.equal(health.usage.limits[0].used, .4);
});

test("Codex quota credentials only go to the fixed account origin", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      return new Response("{}");
    }) as typeof fetch;
    await getAdapter("openai-codex").refresh!({ baseUrl: "https://untrusted.example", accountId: "synthetic", getToken: async () => "synthetic" }, AbortSignal.timeout(1000));
  } finally { globalThis.fetch = original; }
});

function harness(config = settings()) {
  const dir = mkdtempSync(join(tmpdir(), "statusline-full-audit-"));
  const path = join(dir, "settings.json"); writeFileSync(path, JSON.stringify(config));
  const handlers = new Map<string, (...args: any[]) => any>();
  let footer: any;
  const model = { id: "model", provider: "anthropic", reasoning: true, baseUrl: "https://api.anthropic.com" };
  const ctx: any = {
    cwd: dir, mode: "tui", model,
    modelRegistry: { getAvailable: () => [model, { provider: "openrouter" }], isUsingOAuth: () => true, getApiKeyForProvider: async () => "synthetic" },
    sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined, hasPendingMessages: () => false,
    ui: { setFooter: (factory: any) => { footer?.dispose?.(); footer = factory?.({ requestRender() {} }, { fg: (_: string, text: string) => text }, { getGitBranch: () => null, onBranchChange: () => () => {} }); } },
  };
  const pending = new Map<string, (usage: any) => void>();
  const cache: any = { getFresh: () => undefined, refresh: (provider: string) => new Promise((resolve) => pending.set(provider.split(":")[0], resolve)) };
  statusline({ on: (name: string, fn: any) => handlers.set(name, fn), registerCommand() {}, appendEntry() {}, getThinkingLevel: () => "off", exec: async () => ({ code: 0, stdout: "" }) } as any, cache, path);
  return { handlers, ctx, pending, render: () => footer.render(500), close: () => { handlers.get("session_shutdown")!({}, ctx); footer?.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("unrelated provider refreshes cannot erase active response-header quotas", async () => {
  const s = settings(); s.providers.scope = "selected";
  const h = harness(s);
  try {
    await h.handlers.get("session_start")!({}, h.ctx);
    h.handlers.get("after_provider_response")!({ headers: { "anthropic-ratelimit-unified-5h-utilization": "0.4" } }, h.ctx);
    h.pending.get("openrouter")!(undefined); await flush();
    assert.match(h.render().join("\n"), /40% used/);
    h.pending.get("anthropic")!({ limits: [{ ...quota[0], used: .1 }], updatedAt: Date.now() - 10_000, cached: true }); await flush();
    assert.match(h.render().join("\n"), /40% used/);
  } finally { h.close(); }
});

test("partial session cost never presents an incomplete sum as a complete estimate", async () => {
  const s = settings(); s.extras.cost = true;
  const h = harness(s);
  try {
    h.ctx.model = { id: "api", provider: "api" };
    h.ctx.modelRegistry.isUsingOAuth = () => false;
    h.ctx.sessionManager.getBranch = () => [
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 10, cost: { total: .1 } } } },
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 10 } } },
    ];
    await h.handlers.get("session_start")!({}, h.ctx);
    assert.doesNotMatch(h.render().join("\n"), /~\$/);
  } finally { h.close(); }
});
