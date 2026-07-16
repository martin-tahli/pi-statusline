import assert from "node:assert/strict";
import test from "node:test";
import statusline from "../extensions/statusline.ts";

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
    assert.equal(cleared, 2);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("renders emoji segments with themed semantic colors", async () => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const execCalls: unknown[][] = [];
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
    modelRegistry: { authStorage: { get: () => ({ type: "oauth" }), getApiKey: async () => undefined } },
    getContextUsage: () => ({ tokens: 110_000, percent: 55, contextWindow: 200_000 }),
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => [] },
    ui: {
      setFooter: (factory: any) => {
        footer = factory?.(
          { requestRender: () => {} },
          {
            fg: (role: string, text: string) => `<${role}>${text}</${role}>`,
            getColorMode: () => "truecolor",
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
  for (const label of ["⚡", "↑ 0 t/s", "↓ 0 t/s", "🪟  </muted><dim>55.0%/200K"]) assert.ok(initial.includes(label));
  assert.ok(initial.includes("📁 pi-statusline</muted>  <accent> main</accent> <warning>~1</warning> <warning>?1</warning> <accent>↑2</accent> <warning>↓1</warning>"));
  assert.deepEqual(execCalls[0], ["git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: process.cwd(), timeout: 2_000 }]);
  assert.equal(initial.includes("5h"), false);
  assert.equal(initial.includes("wk"), false);
  const now = Date.now();
  handlers.get("turn_start")!({ timestamp: now - 1_000 });
  await handlers.get("turn_end")!({ message: { role: "assistant", usage: { input: 850, output: 74 } } }, ctx);
  const resetAt = String(Math.floor((Date.now() + 3_600_000) / 1_000));
  handlers.get("after_provider_response")!({ headers: {
    "x-codex-primary-used-percent": "23",
    "x-codex-primary-window-minutes": "60",
    "x-codex-primary-reset-at": resetAt,
    "x-codex-secondary-used-percent": "91",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": resetAt,
  } }, ctx);
  const line = footer!.render(1_000)[0]!;
  for (const icon of ["📁", "🤖", "🧠", "🪟", "⚡", "⏳"]) assert.ok(line.includes(icon));
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
  assert.equal(line.includes(" · "), false);

  await handlers.get("model_select")!({}, ctx);
  assert.ok(footer!.render(500)[0]!.includes("↑ 0 t/s"));
  footer?.dispose?.();
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
    modelRegistry: { authStorage: { get: () => ({ type: "oauth" }), getApiKey: async () => undefined } },
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
