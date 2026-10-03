import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import statusline from "../extensions/statusline.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { UsageUnavailableError } from "../src/providers.ts";
import { credentialFingerprint } from "../src/accounts.ts";
const cacheKey = `zai:${credentialFingerprint("zai", "test-key")}`;

initTheme();
test("recognizes explicit denials across Pi's uncached extension imports", () => {
  const duplicate = new Error("usage unavailable");
  duplicate.name = "UsageUnavailableError";
  assert.equal(UsageUnavailableError.is(duplicate), true);
  assert.equal(UsageUnavailableError.is(new Error("network outage")), false);
});
const payload = {
  success: true,
  data: { limits: [
    { type: "TOKENS_LIMIT", percentage: 6, nextResetTime: Date.now() - 60_000 },
    { type: "TOKENS_LIMIT", percentage: 23, nextResetTime: Date.now() + 3 * 86_400_000 },
  ] },
};
const limits = [{ key: "five-hour", label: "5h", used: 0.06 }, { key: "weekly", label: "wk", used: 0.23 }];
const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

for (const tracking of [true, false]) {
  for (const denial of [200, 401, 403]) {
    test(`Z.AI clears denied quota and recovers (tracking=${tracking}, HTTP=${denial})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-statusline-zai-"));
      const originalFetch = globalThis.fetch;
      const originalNow = Date.now;
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      const polls: Array<() => void> = [];
      globalThis.setInterval = ((callback: () => void) => {
        polls.push(callback);
        return { unref() {} };
      }) as unknown as typeof setInterval;
      globalThis.clearInterval = (() => {}) as typeof clearInterval;
      let state: "ok" | "outage" | "denied" = "ok";
      globalThis.fetch = (async () => {
        if (state === "outage") throw new Error("network outage with secret details");
        return new Response(JSON.stringify(state === "ok" ? payload : {
          code: 500, msg: "No coding plan exists for this user", success: false,
          // Even if a denial includes old data, it must not render as usable quota.
          data: payload.data,
        }), { status: state === "denied" ? denial : 200 });
      }) as typeof fetch;
      let clock = Date.now() - 20_000;
      Date.now = () => clock;
      const cache = new ProviderUsageCache(dir, 10_000, 10_000, () => clock);
      let footer: { render(width: number): string[]; dispose(): void } | undefined;
      const handlers = new Map<string, (...args: any[]) => unknown>();
      const config = join(dir, "settings.json");
      writeFileSync(config, JSON.stringify({ providerTracking: { enabled: tracking, selected: { zai: true }, order: ["zai"] } }));
      const pi = {
        on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler),
        registerCommand() {},
        getThinkingLevel: () => "off",
        exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      } as never;
      const ctx = {
        cwd: dir,
        model: { id: "glm", provider: "zai" },
        modelRegistry: {
          isUsingOAuth: () => false,
          getApiKeyForProvider: async () => "test-key",
          getAvailable: () => [{ id: "glm", provider: "zai" }],
        },
        getContextUsage: () => undefined,
        hasPendingMessages: () => false,
        sessionManager: { getBranch: () => [] },
        ui: {
          notify() {},
          setFooter: (factory: any) => {
            footer = factory?.(
              { requestRender() {} },
              { fg: (_: string, text: string) => text, getColorMode: () => "16" },
              { getGitBranch: () => null, getAvailableProviderCount: () => 1, onBranchChange: () => () => {} },
            );
          },
        },
      } as never;
      const render = () => footer!.render(500).join("\n");
      const poll = async () => {
        clock += 20_000;
        polls.forEach((callback) => callback());
        await settle();
      };
      try {
        await cache.refresh(cacheKey, async () => ({ limits }));
        clock += 20_000;
        statusline(pi, cache, config);
        await handlers.get("session_start")!({}, ctx);
        await settle();
        assert.match(render(), /6%/);
        assert.match(render(), /23%/);

        state = "outage";
        await poll();
        assert.match(render(), /23%/, "a transient outage should preserve the last quota");

        state = "denied";
        await poll();
        assert.doesNotMatch(render(), /6%|23%|secret|coding plan/);
        if (tracking) assert.match(render(), /zai usage unavailable/);
        assert.deepEqual(cache.get(cacheKey)?.limits ?? [], []);
        assert.deepEqual(new ProviderUsageCache(dir, 10_000, 10_000, () => clock).get(cacheKey)?.limits ?? [], [],
          "another session must not restore denied quota");

        state = "ok";
        await poll();
        assert.match(render(), /23%/, "renewed access should restore quota without restarting");
        assert.doesNotMatch(render(), /usage unavailable/);
      } finally {
        footer?.dispose();
        await handlers.get("session_shutdown")?.({}, ctx);
        Date.now = originalNow;
        globalThis.fetch = originalFetch;
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
