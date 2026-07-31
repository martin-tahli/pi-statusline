import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProviderUsageCache } from "../src/provider-cache.ts";

const usage = { limits: [{ label: "5h", used: 0.2 }] };
type Usage = typeof usage;

test("shares one fresh provider usage result between sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  try {
    let fetches = 0;
    const first = new ProviderUsageCache(dir, 10_000);
    const second = new ProviderUsageCache(dir, 10_000);
    assert.deepEqual(await first.refresh("anthropic", async () => { fetches++; return usage; }), usage);
    assert.deepEqual((await second.refresh("anthropic", async () => { fetches++; return undefined; }))?.limits, usage.limits);
    assert.equal(fetches, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("allows only one simultaneous refresh per provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-cache-"));
  let resolve!: (usage: Usage) => void;
  try {
    const first = new ProviderUsageCache(dir, 10_000);
    const second = new ProviderUsageCache(dir, 10_000);
    const pending = first.refresh("anthropic", () => new Promise<Usage>((done) => { resolve = done; }));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(await second.refresh("anthropic", async () => usage), undefined);
    resolve(usage);
    assert.deepEqual(await pending, usage);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
