import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSettings, loadSettings, saveSettings, toggleSetting } from "../src/config.ts";

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
