import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  configuredProviders,
  DEFAULT_SETTINGS,
  formatSettings,
  loadSettings,
  reconcileProviderTracking,
  saveSettings,
  toggleSetting,
  type SaveOperations,
  type Settings,
} from "../src/config.ts";

test("defaults core segments and Git HUD on", () => {
  const settings = loadSettings(join(tmpdir(), `missing-statusline-${Date.now()}.json`));
  assert.ok(Object.values(settings.segments).every(Boolean));
  assert.deepEqual(settings.extras, {
    branch: true,
    nerdFont: false,
    cost: false,
    sessionElapsed: false,
    lastTurn: false,
    pending: false,
  });
  assert.equal(settings.footerEnabled, true);
  assert.deepEqual(settings.providerTracking, {
    enabled: true,
    selected: {},
    order: [],
    metrics: { usage: true, reset: true },
    overrides: {},
  });
});

test("toggle persists and unknown names are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  const path = join(dir, "nested", "statusline.json");
  try {
    let settings = loadSettings(path);
    settings = toggleSetting(settings, "throughput");
    settings = toggleSetting(settings, "nerdFont");
    saveSettings(settings, path);
    assert.equal(loadSettings(path).segments.throughput, false);
    assert.equal(loadSettings(path).extras.nerdFont, true);
    assert.throws(() => toggleSetting(settings, "wat"), /Unknown statusline segment/);
    assert.match(formatSettings(settings), /throughput: off/);
    assert.match(formatSettings(settings), /branch: on/);
    assert.match(formatSettings(settings), /nerdFont: on/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tracks only authenticated registry providers and reconciles their saved state", () => {
  const registry = (providers: string[]) => ({
    getAvailable: () => providers.map((provider) => ({ provider })),
    getAll: () => [...providers, "catalog-only"].map((provider) => ({ provider })),
  });
  assert.deepEqual(configuredProviders(registry(["anthropic", "anthropic", "openai-codex"])), ["anthropic", "openai-codex"]);

  const initial = reconcileProviderTracking(DEFAULT_SETTINGS, registry(["anthropic", "openai-codex"]));
  assert.equal("catalog-only" in initial.providerTracking.selected, false);
  assert.equal("user-invented" in initial.providerTracking.selected, false);
  assert.deepEqual(initial.providerTracking.selected, { anthropic: true, "openai-codex": true });
  assert.deepEqual(initial.providerTracking.order, ["anthropic", "openai-codex"]);

  const deselected: Settings = {
    ...initial,
    providerTracking: {
      ...initial.providerTracking,
      selected: { ...initial.providerTracking.selected, "openai-codex": false },
      order: ["openai-codex", "anthropic"],
      overrides: { "openai-codex": { reset: false } },
    },
  };
  const returned = reconcileProviderTracking(
    reconcileProviderTracking(deselected, registry(["anthropic"])),
    registry(["anthropic", "openai-codex", "glm"]),
  );
  assert.deepEqual(returned.providerTracking.selected, { anthropic: true, "openai-codex": false, glm: true });
  assert.deepEqual(returned.providerTracking.order, ["openai-codex", "anthropic", "glm"]);
  assert.deepEqual(returned.providerTracking.overrides, { "openai-codex": { reset: false } });
  assert.deepEqual(returned.providerTracking.metrics, { usage: true, reset: true });
});

test("defaults legacy provider tracking and drops junk overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  const path = join(dir, "statusline.json");
  try {
    writeFileSync(path, JSON.stringify({
      footerEnabled: true,
      segments: { throughput: false },
      providerTracking: {
        overrides: {
          anthropic: { reset: false },
          "openai-codex": { usage: "yes" },
          "   ": { usage: true },
        },
      },
    }), "utf8");
    const { providerTracking } = loadSettings(path);
    assert.equal(providerTracking.enabled, true);
    assert.deepEqual(providerTracking.metrics, { usage: true, reset: true });
    assert.deepEqual(providerTracking.selected, {});
    assert.deepEqual(providerTracking.order, []);
    assert.deepEqual(providerTracking.overrides, { anthropic: { reset: false } });

    writeFileSync(path, JSON.stringify({ footerEnabled: false, extras: { cost: true } }), "utf8");
    assert.deepEqual(loadSettings(path).providerTracking, DEFAULT_SETTINGS.providerTracking);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saves provider tracking atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  const path = join(dir, "statusline.json");
  try {
    const before = DEFAULT_SETTINGS;
    saveSettings(before, path);
    const document = readFileSync(path, "utf8");
    assert.deepEqual(JSON.parse(document), before);

    const next: Settings = {
      ...before,
      providerTracking: { ...before.providerTracking, selected: { anthropic: false } },
    };
    const fail = (method: "writeFile" | "rename"): SaveOperations => ({
      mkdir: () => {},
      writeFile: (file, data, encoding) => {
        if (method === "writeFile") throw new Error("write failed");
        writeFileSync(file, data, encoding);
      },
      rename: (from, to) => {
        if (method === "rename") throw new Error("rename failed");
        renameSync(from, to);
      },
      unlink: (file) => rmSync(file, { force: true }),
    });
    for (const method of ["writeFile", "rename"] as const) {
      assert.throws(() => saveSettings(next, path, fail(method)), new RegExp(`${method.replace("File", "")} failed`));
      assert.equal(readFileSync(path, "utf8"), document);
      assert.deepEqual(next.providerTracking.selected, { anthropic: false });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
