import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import statusline from "../extensions/statusline.ts";

// The interactive settings menu resolves colors from pi's global theme singleton
// (getSettingsListTheme() throws "Theme not initialized" otherwise). Real pi sessions
// call this at startup; tests must do it once too.
initTheme();

test("stops the live timer when settled or the footer is disposed", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void } | undefined;
  let cleared = 0;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((_: () => void) => 1) as typeof setInterval;
  globalThis.clearInterval = ((_: ReturnType<typeof setInterval>) => { cleared++; }) as typeof clearInterval;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    } as never;
    const ctx = {
      cwd: process.cwd(),
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi);
    await handlers.get("session_start")!({}, ctx);
    const now = Date.now();
    handlers.get("turn_start")!({ timestamp: now });
    handlers.get("agent_settled")!({});
    assert.equal(cleared, 1);

    handlers.get("turn_start")!({ timestamp: now });
    footer?.dispose?.();
    // Disposing also stops the independent git-status poll interval alongside the time tick.
    assert.equal(cleared, 3);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("renders emoji segments with themed semantic colors", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const execCalls: unknown[][] = [];
  let colorMode = "truecolor";
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "medium",
    exec: async (...args: unknown[]) => {
      execCalls.push(args);
      return {
        code: 0,
        stdout: "# branch.ab +2 -1\0" + "1 .M N... modified.ts\0" + "? untracked.ts\0",
        stderr: "",
      };
    },
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "gpt-5.6-terra", provider: "openai-codex", reasoning: true },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => ({ tokens: 110_000, percent: 55, contextWindow: 200_000 }),
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          {
            fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
            getColorMode: () => colorMode,
            getFgAnsi: (role: string) => ({
              success: "\x1b[38;2;0;255;0m",
              warning: "\x1b[38;2;255;165;0m",
              error: "\x1b[38;2;255;0;0m",
            } as Record<string, string>)[role] ?? "\x1b[39m",
          },
          { getGitBranch: () => "main", getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi);
  await handlers.get("session_start")!({}, ctx);
  const initial = footer!.render(500)[0]!;
  // Subscription (openai-codex + OAuth) hides the throughput ledger at idle; quota bars carry it.
  assert.equal(initial.includes(" t/s"), false);
  for (const label of ["🪟  </muted><success>55.0%/200K"]) assert.ok(initial.includes(label));
  assert.ok(initial.includes("📁 pi-statusline</muted><dim> > </dim><accent>main</accent> <warning>● 2</warning> <warning>↓1</warning> <accent>↑2</accent>"));
  assert.deepEqual(execCalls[0], ["git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: process.cwd(), timeout: 2_000 }]);
  assert.equal(initial.includes("5h"), false);
  assert.equal(initial.includes("wk"), false);
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 850, output: 74 } } }, ctx);
  const resetAt = String(Math.floor((Date.now() + 3_600_000) / 1_000));
  handlers.get("after_provider_response")!({ headers: {
    "x-codex-primary-used-percent": "60",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": resetAt,
    "x-codex-secondary-used-percent": "80",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": resetAt,
  } }, ctx);
  const line = footer!.render(1_000)[0]!;
  for (const icon of ["📁", "🤖", "🧠", "🪟", "⏳"]) assert.ok(line.includes(icon));
  assert.ok(line.includes("1h"));
  assert.ok(line.includes("wk"));
  assert.equal(line.includes("5h"), false);
  assert.ok(line.includes("\x1b[38;2;"));
  assert.ok(line.includes("╺"));
  assert.ok(line.includes("╴"));
  assert.equal(line.includes("◖"), false);
  assert.equal(line.includes("◗"), false);
  assert.equal(line.split("↻").length - 1, 2);
  assert.ok(line.includes("<dim> > </dim>"));
  assert.ok(line.includes("<dim> ></dim>"));
  assert.equal(line.includes(" · "), false);

  colorMode = "16";
  const semanticLine = footer!.render(1_000)[0]!;
  assert.ok(semanticLine.includes("<warning>╺━━━━━━</warning><dim>────╴</dim> 60%"));
  assert.ok(semanticLine.includes("<error>╺━━━━━━━━━</error><dim>─╴</dim> 80%"));

  await handlers.get("model_select")!({}, ctx);
  assert.equal(footer!.render(500)[0]!.includes(" t/s"), false);
  footer?.dispose?.();
});

test("loads Anthropic limits at session start", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const entries: unknown[] = [];
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  let request: [string, RequestInit | undefined] | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    request = [String(input), init];
    return {
      ok: true,
      json: async () => ({
        five_hour: { utilization: 23, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: { utilization: 41, resets_at: new Date(Date.now() + 86_400_000).toISOString() },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "claude-opus-4-8", provider: "anthropic", reasoning: true },
      modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => "access-token" },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => entries },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi);
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(request?.[0], "https://api.anthropic.com/api/oauth/usage");
    assert.equal((request?.[1]?.headers as Record<string, string>)["anthropic-beta"], "oauth-2025-04-20");
    const line = footer!.render(500)[0]!;
    assert.ok(line.includes("5h ╺"));
    assert.ok(line.includes("wk ╺"));
    assert.equal(entries.length, 1);
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("restores Anthropic limits when a session reloads", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const entries: unknown[] = [];
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "claude-opus-4-8", provider: "anthropic", reasoning: true },
    modelRegistry: { isUsingOAuth: () => true, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => entries },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi);
  await handlers.get("session_start")!({}, ctx);
  const resetAt = String(Math.floor((Date.now() + 3_600_000) / 1_000));
  handlers.get("after_provider_response")!({ headers: {
    "anthropic-ratelimit-unified-5h-utilization": "0.23",
    "anthropic-ratelimit-unified-5h-reset": resetAt,
    "anthropic-ratelimit-unified-7d-utilization": "0.41",
    "anthropic-ratelimit-unified-7d-reset": resetAt,
  } }, ctx);
  await handlers.get("session_start")!({}, ctx);

  const line = footer!.render(500)[0]!;
  assert.equal(entries.length, 1);
  assert.ok(line.includes("5h ╺"));
  assert.ok(line.includes("wk ╺"));
  assert.equal(line.split("↻").length - 1, 2);
  assert.equal(line.includes("—"), false);
  assert.equal(line.includes(""), false);
  assert.equal(line.includes("⎇"), false);
  footer?.dispose?.();
});

test("estimates throughput from response text when a provider reports no usage", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "llama-local", provider: "llama-cpp", baseUrl: "http://localhost:8080/v1" },
    modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi);
  await handlers.get("session_start")!({}, ctx);
  handlers.get("context")!({ messages: [{ role: "user", content: "a".repeat(400) }] });
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({
    message: { role: "assistant", usage: { input: 0, output: 0 }, content: [{ type: "text", text: "b".repeat(200) }] },
  }, ctx);

  const line = footer!.render(500)[0]!;
  assert.ok(line.includes("↑100"));
  assert.ok(line.includes("↓50"));
  footer?.dispose?.();
});

test("shows an API token ledger (not a bogus prompt rate) for hosted providers when idle", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: () => {},
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "claude-sonnet-4-5", provider: "anthropic", baseUrl: "https://api.anthropic.com" },
    modelRegistry: { isUsingOAuth: () => false, getApiKeyForProvider: async () => undefined },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: {
      getBranch: () => [{
        type: "message",
        message: {
          role: "assistant",
          usage: { input: 7_400, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: 0.021 } },
        },
      }],
    },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, getColorMode: () => "16", getFgAnsi: () => "" },
          { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
        );
      },
      notify: () => {},
    },
  } as never;

  statusline(pi);
  await handlers.get("session_start")!({}, ctx);
  handlers.get("context")!({ messages: [{ role: "user", content: "a".repeat(30_000) }] });
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({
    message: { role: "assistant", usage: { input: 7_400, output: 200 }, content: [{ type: "text", text: "b".repeat(800) }] },
  }, ctx);
  handlers.get("agent_settled")!({});

  const line = footer!.render(500)[0]!;
  assert.ok(line.includes("🧾"), `expected API token ledger, got: ${line}`);
  assert.ok(line.includes("$0.021"), `expected session cost, got: ${line}`);
  assert.ok(!/↑\d+ ↓\d+ t\/s/.test(line), `should not show a bogus prompt rate, got: ${line}`);
  footer?.dispose?.();
});

test("renders a fresh active provider beneath the session line without duplicate quota", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    five_hour: { utilization: 25, resets_at: Date.now() + 3_600_000 },
    seven_day: { utilization: 50, resets_at: Date.now() + 86_400_000 },
  }), { status: 200 })) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      model: { id: "claude", provider: "anthropic" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getApiKeyForProvider: async () => "access-token",
        getAvailable: () => [{ provider: "anthropic" }],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi);
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lines = footer!.render(500);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.includes("5h"), false, `active session line duplicated quota: ${lines[0]}`);
    assert.ok(lines[1]!.includes("anthropic 5h"), `missing provider row: ${lines[1]}`);
    assert.ok(lines[1]!.includes("wk"), `provider windows were not preserved: ${lines[1]}`);
    assert.equal(footer!.render(1).length, 2, "narrow widths must retain the provider row");
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("bare /statusline opens the interactive provider menu and lets Escape discard unsaved toggles", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;
  const notifications: Array<[string, string]> = [];
  let customOpened = false;
  const pi = {
    on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
    registerCommand: (_name: string, def: { handler: (args: string, ctx: any) => Promise<void> }) => { commandHandler = def.handler; },
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  } as never;
  const ctx = {
    cwd: process.cwd(),
    model: { id: "claude", provider: "anthropic" },
    modelRegistry: {
      isUsingOAuth: () => false,
      getApiKeyForProvider: async () => undefined,
      getAvailable: () => [{ provider: "anthropic" }, { provider: "openai-codex" }],
    },
    getContextUsage: () => undefined,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: () => {},
      notify: (message: string, level: string) => notifications.push([message, level]),
      custom: (factory: any) => new Promise((resolve) => {
        customOpened = true;
        const component = factory(
          { requestRender: () => {} },
          { fg: (_: string, text: string) => text, bold: (text: string) => text, getColorMode: () => "16" },
          {},
          resolve,
        );
        // Down x4 reaches the first provider's "selected" row (enabled, usage, percent, reset, then per-provider rows).
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput("\x1b[B");
        component.handleInput(" "); // toggle anthropic from selected -> hidden
        const rendered = component.render(80).join("\n");
        assert.ok(rendered.includes("anthropic") && rendered.includes("hidden"), `expected a togglable anthropic row, got: ${rendered}`);
        component.handleInput("\x1b"); // Escape cancels
      }),
    },
  } as never;

  statusline(pi);
  await handlers.get("session_start")!({}, ctx);
  assert.ok(commandHandler, "expected /statusline to register a handler");
  await commandHandler!("", ctx);

  assert.ok(customOpened, "bare /statusline must open the interactive menu, not just print settings");
  assert.equal(notifications.length, 0, "Escape must cancel without notifying or persisting");
});

test("tracks every selected provider's usage simultaneously, not just the active model's", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let footer: { dispose?: () => void; render: (width: number) => string[] } | undefined;
  const originalFetch = globalThis.fetch;
  const codexToken = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })).toString("base64url")}.s`;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("anthropic.com")) {
      return new Response(JSON.stringify({
        five_hour: { utilization: 10, resets_at: Date.now() + 3_600_000 },
        seven_day: { utilization: 20, resets_at: Date.now() + 86_400_000 },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      rate_limit: { primary_window: { used_percent: 30, limit_window_seconds: 3_600, reset_at: Math.floor(Date.now() / 1_000) + 3_600 } },
    }), { status: 200 });
  }) as typeof fetch;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      appendEntry: () => {},
    } as never;
    const ctx = {
      cwd: process.cwd(),
      // The active model is Codex, not Anthropic. Before the fix, this alone hid Anthropic's row
      // (and any provider row but the active one) no matter what the settings menu had selected.
      model: { id: "gpt-5-codex", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
      modelRegistry: {
        isUsingOAuth: (model: { provider: string }) => model.provider === "anthropic",
        getApiKeyForProvider: async (provider: string) => (provider === "openai-codex" ? codexToken : "access-token"),
        getAvailable: () => [
          { provider: "anthropic", id: "claude" },
          { provider: "openai-codex", id: "gpt-5-codex", baseUrl: "https://chatgpt.com/backend-api/codex" },
        ],
      },
      getContextUsage: () => undefined,
      hasPendingMessages: () => false,
      sessionManager: { getBranch: () => [] },
      ui: {
        setFooter: (factory: any) => {
          footer = factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text, getColorMode: () => "16" },
            { getGitBranch: () => null, getAvailableProviderCount: () => 2, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi);
    await handlers.get("session_start")!({}, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const lines = footer!.render(500);
    assert.ok(lines.some((line) => line.includes("anthropic") && line.includes("5h")), `expected an anthropic row despite Codex being active, got: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((line) => line.includes("openai-codex")), `expected an openai-codex row, got: ${JSON.stringify(lines)}`);
  } finally {
    footer?.dispose?.();
    globalThis.fetch = originalFetch;
  }
});

test("refreshes git status on an interval independent of turn activity", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let intervalCallback: (() => void) | undefined;
  let intervalMs: number | undefined;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    intervalCallback = fn;
    intervalMs = ms;
    return 1;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  let execCount = 0;
  try {
    const pi = {
      on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
      registerCommand: () => {},
      getThinkingLevel: () => "off",
      exec: async () => {
        execCount++;
        return { code: 0, stdout: "", stderr: "" };
      },
    } as never;
    const ctx = {
      cwd: process.cwd(),
      ui: {
        setFooter: (factory: any) => {
          factory?.(
            { requestRender: () => {} },
            { fg: (_: string, text: string) => text },
            { getGitBranch: () => "main", getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
          );
        },
        notify: () => {},
      },
    } as never;

    statusline(pi);
    await handlers.get("session_start")!({}, ctx);
    const countAfterStart = execCount;
    assert.ok(intervalCallback, "expected a periodic git refresh interval");
    assert.equal(intervalMs, 10_000);

    intervalCallback!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(execCount, countAfterStart + 1);

    intervalCallback!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(execCount, countAfterStart + 2);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
