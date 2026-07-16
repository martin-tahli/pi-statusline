import assert from "node:assert/strict";
import test from "node:test";
import { barLevel, renderBar } from "../src/bar.ts";

test("renders smooth consumed pills without an empty track", () => {
  const green = (text: string) => `<green>${text}</green>`;
  assert.equal(renderBar(0.54, 8, green), "<green>████▍</green> 54%");
  assert.equal(renderBar(0.5625), "████▌ 56%");
  assert.equal(renderBar(0), "0%");
  assert.equal(renderBar(1), "████████ 100%");
  assert.equal(renderBar(2), "████████ 100%");
  assert.equal(renderBar(-1), "0%");
});

test("classifies raw utilization thresholds", () => {
  assert.equal(barLevel(0.23), "success");
  assert.equal(barLevel(0.62), "success");
  assert.equal(barLevel(0.75), "warning");
  assert.equal(barLevel(0.9), "error");
});
