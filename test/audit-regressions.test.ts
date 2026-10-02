import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig } from "../src/settings/defaults.ts";
import { applyPreset } from "../src/settings/presets.ts";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { migrateLegacySettings } from "../src/settings/migrations.ts";
import { renderMainLine, renderProviderRows, renderSessionWindows } from "../src/render.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { ProviderRefreshCoordinator, RateLimitedError } from "../src/providers.ts";
import { TurnMeter } from "../src/throughput.ts";
import { isLocalEndpoint } from "../src/derive.ts";
import { parseGitStatus, gitStatusTokens } from "../src/git.ts";
import { parseOpenRouterUsage, parseAnthropicUsage } from "../src/ratelimit.ts";
import { getAdapter } from "../src/settings/providers/adapters.ts";
import { createSettingsUi, renderSettingsUi } from "../src/settings/ui.ts";
import { discoverProviders } from "../src/settings/providers/discovery.ts";
import { deriveCapability } from "../src/settings/providers/capabilities.ts";

const defaults = () => structuredClone(DEFAULT_STATUSLINE_SETTINGS);
const windows = [{ key: "five-hour", label: "5h", used: 1, resetAt: 3_600_000 }, { key: "seven-day", label: "wk", used: .12, resetAt: 86_400_000 }];

test("old, denied and malformed cache entries cannot become fresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-cache-regression-"));
  let now = 1_000_000;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => now);
  try {
    await cache.refresh("test", async () => ({ limits: windows }));
    now += 20_000;
    const coordinator = new ProviderRefreshCoordinator(new Map([["test", { refresh: () => cache.refresh("test", async () => undefined) }]]), () => {});
    await coordinator.refresh("test");
    const cached = coordinator.get("test", now);
    assert.equal(cached.state, "fresh");
    if (cached.state === "fresh") { assert.equal(cached.updatedAt, 1_000_000); assert.equal(cached.usage.cached, true); }
    now += 86_400_000;
    await coordinator.refresh("test");
    assert.equal(coordinator.get("test", now).state, "hidden");
    assert.equal(cache.getFresh("test"), undefined);
    writeFileSync(join(dir, `${Buffer.from("test").toString("base64url")}.json`), "null");
    assert.equal(cache.get("test"), undefined);
    assert.ok(await cache.refresh("test", async () => ({ limits: windows })));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cache policies and cross-module 429 signals govern real refreshes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "statusline-policy-"));
  let now = 1_000_000, calls = 0;
  const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => now);
  try {
    await cache.refresh("test", async () => ({ limits: windows }));
    now += 11_000;
    assert.equal(await cache.refresh("test", async () => undefined, { intervalMs: 10_000, maxAgeMs: 300_000, useCache: true, keepAfterFailure: false }), undefined);
    await cache.refresh("test", async () => { calls++; throw Object.assign(new Error("foreign module"), { name: "RateLimitedError" }); });
    assert.equal(RateLimitedError.is(Object.assign(new Error(), { name: "RateLimitedError" })), true);
    now += 11_000;
    await cache.refresh("test", async () => { calls++; return { limits: windows }; });
    assert.equal(calls, 1, "foreign error instance still sets shared backoff");
    now += 61_000;
    await cache.refresh("test", async () => { calls++; return { limits: windows }; }, { intervalMs: 10_000, maxAgeMs: 300_000, useCache: false, keepAfterFailure: true });
    assert.equal(calls, 2);
    let eligible = false;
    const coordinator = new ProviderRefreshCoordinator(new Map([["test", { refresh: async () => { calls++; return { limits: windows }; } }]]), () => {}, undefined, undefined,
      () => ({ eligible, intervalMs: 60_000, maxAgeMs: 300_000, keepAfterFailure: false }));
    await coordinator.refresh("test"); assert.equal(calls, 2);
    eligible = true;
    await coordinator.refresh("test"); assert.equal(calls, 3);
    now += 11_000;
    await coordinator.refresh("test", false); assert.equal(calls, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("narrow quota keeps the exhausted window and percentages are independent", () => {
  const settings = defaults();
  settings.providers.records.anthropic = createProviderConfig();
  settings.providers.records.anthropic.windows["five-hour"] = { ...createWindowConfig(), showBar: false };
  assert.match(renderSessionWindows(settings, "anthropic", windows, undefined, 0, 22), /100%/);
  assert.match(renderSessionWindows(settings, "anthropic", [windows[0]], undefined, 0), /100%/);
  const legacy = parseStatuslineSettings(migrateLegacySettings({ providerTracking: { selected: { anthropic: true }, order: ["anthropic"], metrics: { usage: false, percent: false, reset: false } } })).settings;
  assert.deepEqual(renderProviderRows(legacy, [{ provider: "anthropic", windows }], undefined, 0), []);
  const theme = { fg: (_: string, text: string) => text, getColorMode: () => "truecolor" as const };
  const before = renderSessionWindows(settings, "test", [{ label: "5h", used: .5 }], theme, 0);
  settings.bars.warnAt = 10; settings.bars.critAt = 20;
  assert.notEqual(renderSessionWindows(settings, "test", [{ label: "5h", used: .5 }], theme, 0), before);
});

test("malformed/future settings render safely and unknown fields remain idempotent", () => {
  for (const input of [null, [], { version: 1, icons: { providers: { test: null } } }, { version: 999, layout: { providerRows: "newline" } }]) {
    const result = parseStatuslineSettings(input);
    assert.doesNotThrow(() => renderMainLine(result.settings, { cwd: "/tmp/demo" }, 80));
    if ((input as any)?.version === 999) assert.equal(result.readOnly, true);
  }
  let parsed = parseStatuslineSettings({ version: 1, futureOption: 123, providers: { records: { test: { future: true, windows: { test: { future: 1 } } } } } }).settings;
  const serialized = JSON.stringify(parsed);
  for (let i = 0; i < 5; i++) parsed = parseStatuslineSettings(parsed).settings;
  assert.equal(JSON.stringify(parsed), serialized);
});

test("presets, auto visibility and icon styles keep idle output minimal", () => {
  const settings = applyPreset(defaults(), "detailed");
  assert.equal(settings.providers.scope, "selected");
  settings.icons.style = "none";
  const snapshot = { cwd: "/tmp/demo", model: { id: "test", provider: "api" }, meter: { activeMs: 1000 }, totals: { input: 10, output: 20, cost: 0 }, sessionWindows: windows };
  assert.doesNotMatch(renderMainLine(settings, snapshot, 500), /🧾|⏳/);
  settings.icons.style = "ascii";
  assert.doesNotMatch(renderMainLine(settings, snapshot, 500), /[^\x00-\x7F]/);
  const balanced = applyPreset(settings, "balanced");
  assert.equal(balanced.providers.scope, "active");
  assert.doesNotMatch(renderMainLine(balanced, snapshot, 500), /t\/s|~\$/);
  assert.match(renderMainLine(balanced, { ...snapshot, turnActive: true, meter: { activeMs: 1000, outputRate: 15, outputEstimated: true } }, 500), /~15/);
  assert.equal(applyPreset(settings, "minimal").segments.project, false);
});

test("generation timing freezes at message end and git conflicts override clean", () => {
  let now = 1000;
  const meter = new TurnMeter(() => now);
  meter.startTurn(); meter.markFirstUpdate(); meter.updateOutputChars(400);
  now = 2000; meter.markMessageEnd();
  now = 11000;
  assert.equal(meter.snapshot().outputRate, 100);
  assert.equal(meter.snapshot().outputEstimated, true);
  assert.equal(meter.snapshot().tools, true);
  assert.equal(isLocalEndpoint("http://[::1]:8000"), true);
  const status = parseGitStatus("# branch.ab +0 -0\0u UU conflict\0");
  assert.equal(status.conflicts, 1);
  assert.match(gitStatusTokens(status)[0].text, /conflict/);
  assert.equal(parseGitStatus("2 rename\0? not-an-untracked-file\0").dirty, 1);
});

test("Z.AI controls use quota capability, not API billing", () => {
  const descriptors = discoverProviders({ getAvailable: () => [{ provider: "zai", baseUrl: "https://api.z.ai" }] });
  const capabilities = { zai: deriveCapability(descriptors[0]) };
  const state = createSettingsUi(defaults()); state.openRow = "providers"; state.selectedProviderId = "zai";
  const lines = renderSettingsUi(state, { width: 100, providers: { descriptors, capabilities, windows: { zai: windows }, health: { zai: { state: "fresh", cached: true, updatedAt: 1000 } } } }).join("\n");
  assert.match(lines, /Bar:/); assert.match(lines, /Refresh usage now/);
  assert.match(lines, /shared cache/); assert.match(lines, /1970-01-01/);
});

test("OpenRouter reports finite key budgets only, using the regular key endpoint", async () => {
  assert.equal(parseOpenRouterUsage({ data: { limit: 10, limit_remaining: 8 } })[0].used, .2);
  assert.deepEqual(parseOpenRouterUsage({ data: { limit: null, usage: 2 } }), []);
  assert.deepEqual(parseOpenRouterUsage({ data: { limit: 10 } }), []);
  assert.deepEqual(parseAnthropicUsage({ five_hour: { utilization: 20 }, seven_day: { utilization: null } }).map((x) => x.label), ["5h"]);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (url: string) => {
      assert.equal(url, "https://openrouter.ai/api/v1/key");
      return new Response(JSON.stringify({ data: { limit: 10, limit_remaining: 8 } }));
    }) as typeof fetch;
    assert.equal((await getAdapter("openrouter").refresh!({ getToken: async () => "synthetic" }, AbortSignal.timeout(1000)))[0].used, .2);
  } finally { globalThis.fetch = original; }
});

test("all presets and built-in icon styles stay within 1–240 columns", () => {
  for (const preset of ["minimal", "balanced", "detailed"] as const) {
    for (const style of ["emoji", "unicode", "ascii", "nerdfont", "minimal", "none"] as const) {
      const settings = applyPreset(defaults(), preset); settings.icons.style = style;
      for (let width = 1; width <= 240; width++) {
        const snapshot = { cwd: "/tmp/项目", model: { id: "long-model-name", provider: "test" }, contextUsage: { tokens: 95000, contextWindow: 100000, percent: 95 }, sessionWindows: windows, sessionFreshness: "cached 2m", turnActive: true, meter: { activeMs: 1000, outputRate: 100, outputEstimated: true } };
        assert.ok(visibleWidth(renderMainLine(settings, snapshot, width)) <= width);
        const rows = renderProviderRows(settings, [{ provider: "test", windows, freshness: "cached 2m" }], undefined, 0, width);
        for (const line of rows) assert.ok(visibleWidth(line) <= width);
      }
    }
  }
});
