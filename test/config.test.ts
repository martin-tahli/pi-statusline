import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatSettings, loadSettings, saveSettings, toggleSetting } from "../src/config.ts";

test("defaults core segments on and extras off", () => {
  const settings = loadSettings(join(tmpdir(), `missing-statusline-${Date.now()}.json`));
  assert.ok(Object.values(settings.segments).every(Boolean));
  assert.ok(Object.values(settings.extras).every((value) => !value));
  assert.equal(settings.footerEnabled, true);
});

test("toggle persists and unknown names are rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-statusline-"));
  const path = join(dir, "nested", "statusline.json");
  try {
    let settings = loadSettings(path);
    settings = toggleSetting(settings, "throughput");
    saveSettings(settings, path);
    assert.equal(loadSettings(path).segments.throughput, false);
    assert.throws(() => toggleSetting(settings, "wat"), /Unknown statusline segment/);
    assert.match(formatSettings(settings), /throughput: off/);
    assert.match(formatSettings(settings), /branch: off/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
