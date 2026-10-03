import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountSources, accountWindows, credentialFingerprint, parseAccountSnapshot, readClaudePool } from "../src/accounts.ts";
import { createProviderConfig, DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import { renderProviderRows } from "../src/render.ts";
import { createSettingsUi, routeSettingsKey, renderSettingsUi } from "../src/settings/ui.ts";
import statusline from "../extensions/statusline.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { renderPreview } from "../src/settings/preview.ts";

const now = Date.now();
const pool = { active: "wrong-pin", accounts: [
  { label: "Personal", uuid: "user", orgUuid: "personal", access: "synthetic-a", refresh: "never-export-a" },
  { label: "Work", uuid: "user", orgUuid: "work", access: "synthetic-b", refresh: "never-export-b", disabled: true },
] };
const usage = {
  Personal: { at: now - 1000, five_hour: { pct: 10 }, seven_day: { pct: 20 }, scoped: [{ name: "Fable", pct: 30 }] },
  Work: { at: now - 2000, five_hour: { pct: 70 }, seven_day: { pct: 80 } },
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "statusline-accounts-"));
  const write = (name: string, value: unknown) => writeFileSync(join(dir, name), JSON.stringify(value));
  write("claude-pool.json", pool); write("claude-pool-usage.json", usage);
  return { dir, write, close: () => rmSync(dir, { recursive: true, force: true }) };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Claude bridge distinguishes organizations, follows the actual credential, and returns no secrets", () => {
  const f = fixture();
  try {
    const snapshot = readClaudePool(f.dir, "synthetic-b", now)!;
    assert.equal(snapshot.accounts.length, 2);
    assert.notEqual(snapshot.accounts[0].id, snapshot.accounts[1].id);
    assert.equal(snapshot.accounts[0].active, false); assert.equal(snapshot.accounts[1].active, true);
    assert.equal(snapshot.accounts[0].windows.find((w) => w.key === "model:Fable")?.used, .3);
    assert.doesNotMatch(JSON.stringify(snapshot), /synthetic|never-export|refresh|access/);
    const rotated = structuredClone(pool); rotated.accounts[0].access = "rotated";
    f.write("claude-pool.json", rotated);
    assert.equal(readClaudePool(f.dir, "rotated", now)!.accounts[0].id, snapshot.accounts[0].id);
    assert.equal(readClaudePool(f.dir, "unmatched", now)!.accounts.some((a) => a.active), false);
    f.write("claude-pool.stash.json", { Personal: { access: "successor", refresh: "successor-refresh" } });
    assert.equal(readClaudePool(f.dir, "successor", now)!.accounts[0].active, true);
  } finally { f.close(); }
});

test("account validation rejects ambiguous identity and stale/denied snapshots never imply zero", () => {
  assert.equal(parseAccountSnapshot({ provider: "test", accounts: [{ id: "same" }, { id: "same" }] }), undefined);
  assert.equal(parseAccountSnapshot({ provider: "test", accounts: [{ id: "a", active: true }, { id: "b", active: true }] }), undefined);
  assert.equal(parseAccountSnapshot({ provider: "__proto__", accounts: [] }), undefined);
  const f = fixture();
  try {
    f.write("claude-pool-usage.json", { ...usage, Work: { ...usage.Work, error: "http-401" } });
    const snapshot = readClaudePool(f.dir, "synthetic-a", now)!;
    assert.deepEqual(snapshot.accounts[1].windows, []);
    assert.deepEqual(accountWindows(DEFAULT_STATUSLINE_SETTINGS, "anthropic", snapshot.accounts[0], now + 600_000), []);
    const s = structuredClone(DEFAULT_STATUSLINE_SETTINGS); s.providers.accountScope = "selected";
    const sources = accountSources(s, snapshot, now);
    const lines = renderProviderRows(s, sources, undefined, now, 500).join("\n");
    assert.match(lines, /anthropic \/ Personal \*/); assert.match(lines, /Work usage unavailable/);
    assert.doesNotMatch(lines, /70%|80%/);
    s.providers.records.anthropic = createProviderConfig();
    s.providers.records.anthropic.accounts = { [snapshot.accounts[0].id]: { enabled: true, label: "Home" }, [snapshot.accounts[1].id]: { enabled: false, label: "" } };
    assert.equal(accountSources(s, snapshot, now).length, 1);
    assert.match(accountSources(s, snapshot, now)[0].label!, /Home/);
  } finally { f.close(); }
});

test("account display controls change only statusline preferences, never authentication", () => {
  const f = fixture();
  try {
    const snapshot = readClaudePool(f.dir, "synthetic-a", now)!;
    const providers: any = { descriptors: [{ id: "anthropic", displayName: "Anthropic", available: true, models: [] }], capabilities: { anthropic: { quotaSupport: "best-effort" } }, accounts: { anthropic: snapshot } };
    let state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
    state.openRow = "providers"; state.selectedProviderId = "anthropic"; state.section = "accounts";
    assert.match(renderSettingsUi(state, { width: 100, providers }).join("\n"), /Add \/ sign in \/ switch accounts in your provider addon/);
    state = routeSettingsKey(state, "Enter", providers).state;
    assert.equal(state.draft.providers.records.anthropic.accounts![snapshot.accounts[0].id].enabled, false);
    state = routeSettingsKey(state, "ArrowDown", providers).state;
    for (const key of ["W", "o", "r", "k"]) state = routeSettingsKey(state, key, providers).state;
    assert.equal(state.draft.providers.records.anthropic.accounts![snapshot.accounts[0].id].label, "Work");
    assert.doesNotMatch(JSON.stringify(state.draft), /synthetic|never-export/);
  } finally { f.close(); }
});

test("real extension displays both pooled accounts with zero independent usage requests", async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => { networkCalls++; throw new Error("unexpected request"); }) as typeof fetch;
  const handlers = new Map<string, any>(); const events = new Map<string, any>();
  let footer: any; let token = "synthetic-a";
  const config = structuredClone(DEFAULT_STATUSLINE_SETTINGS); config.providers.accountScope = "selected";
  f.write("statusline.json", config);
  const model = { id: "claude", provider: "anthropic" };
  const ctx: any = { cwd: f.dir, mode: "tui", model,
    modelRegistry: { getAvailable: () => [model], isUsingOAuth: () => true, getApiKeyForProvider: async () => token },
    sessionManager: { getBranch: () => [] }, getContextUsage: () => undefined, hasPendingMessages: () => false,
    ui: { setFooter: (factory: any) => { footer?.dispose(); footer = factory?.({ requestRender() {} }, { fg: (_: string, text: string) => text }, { getGitBranch: () => null, onBranchChange: () => () => {} }); } } };
  const pi: any = { on: (name: string, fn: any) => handlers.set(name, fn), registerCommand() {}, getThinkingLevel: () => "off", exec: async () => ({ code: 0, stdout: "" }), events: { on: (name: string, fn: any) => events.set(name, fn), emit() {} } };
  try {
    statusline(pi, new ProviderUsageCache(join(f.dir, "cache")), join(f.dir, "statusline.json"));
    await handlers.get("session_start")({}, ctx); await flush();
    assert.match(footer.render(500).join("\n"), /Personal \*/);
    assert.match(footer.render(500).join("\n"), /Work .*70%/);
    token = "synthetic-b";
    await handlers.get("model_select")({}, ctx); await flush();
    assert.match(footer.render(500).join("\n"), /Work \*/);
    assert.doesNotMatch(footer.render(500).join("\n"), /Personal \*/);
    handlers.get("after_provider_response")({ headers: { "anthropic-ratelimit-unified-5h-utilization": "0.99" } }, ctx);
    assert.doesNotMatch(footer.render(500).join("\n"), /99%/);
    assert.equal(networkCalls, 0);
    // Other addons can publish the same credential-free protocol, independent of Claude's files.
    events.get("statusline:accounts")({ provider: "anthropic", source: "Synthetic addon", accounts: [{ id: "third", label: "Third", active: true, updatedAt: now, windows: [{ label: "quota", used: .33 }] }] });
    assert.match(footer.render(500).join("\n"), /Third \*.*33%/);
    assert.doesNotMatch(footer.render(500).join("\n"), /Personal|Work/);
  } finally { handlers.get("session_shutdown")?.({}, ctx); footer?.dispose(); globalThis.fetch = originalFetch; f.close(); }
});

test("malformed stashes cannot revive dead accounts; preview never borrows another account's quota", () => {
  const f = fixture();
  try {
    f.write("claude-pool.json", { ...pool, accounts: [{ ...pool.accounts[0], dead: true }, pool.accounts[1]] });
    f.write("claude-pool.stash.json", { Personal: {} });
    const snapshot = readClaudePool(f.dir, "unmatched", now)!;
    assert.deepEqual(snapshot.accounts[0].windows, []);
    const s = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
    s.providers.enabled = false;
    const providers: any = { descriptors: [{ id: "anthropic", displayName: "Anthropic", models: [] }], capabilities: { anthropic: { quotaSupport: "best-effort" } },
      windows: { anthropic: snapshot.accounts[1].windows }, accounts: { anthropic: snapshot } };
    const preview = renderPreview({ settings: s, mode: "current", width: 200, current: { runtime: { activeProvider: "other" } }, providers, selectedProviderId: "anthropic" });
    assert.doesNotMatch(preview.join("\n"), /70%|80%/);
  } finally { f.close(); }
});

test("failed quota reads still honor the shared provider minimum interval", async () => {
  const f = fixture(); let clock = 1_000_000, calls = 0;
  try {
    const cache = new ProviderUsageCache(join(f.dir, "minimum"), 10_000, 10_000, () => clock);
    const policy = { intervalMs: 180_000, maxAgeMs: 300_000, useCache: true, keepAfterFailure: true };
    const fetchUsage = async () => { calls++; return undefined; };
    await cache.refresh("anthropic:account", fetchUsage, policy);
    clock += 10_000;
    await cache.refresh("anthropic:account", fetchUsage, policy);
    assert.equal(calls, 1);
    clock += 180_000;
    await cache.refresh("anthropic:account", fetchUsage, policy);
    assert.equal(calls, 2);
  } finally { f.close(); }
});

test("credential fingerprints isolate accounts and never include credentials", async () => {
  const f = fixture();
  try {
    const cache = new ProviderUsageCache(join(f.dir, "isolated"));
    const a = `anthropic:${credentialFingerprint("anthropic", "secret-a")}`;
    const b = `anthropic:${credentialFingerprint("anthropic", "secret-b")}`;
    assert.notEqual(a, b); assert.doesNotMatch(a, /secret/);
    await cache.refresh("anthropic", async () => ({ limits: [{ label: "old", used: .9 }] }));
    assert.equal(cache.getFresh(a), undefined, "legacy provider-only data is never an account match");
    await cache.refresh(a, async () => ({ limits: [{ label: "A", used: .1 }] }));
    assert.equal(cache.getFresh(b), undefined);
  } finally { f.close(); }
});
