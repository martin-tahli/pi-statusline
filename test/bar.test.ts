import assert from "node:assert/strict";
import test from "node:test";
import { barLevel, gradientAt, renderBar, type BarStyle } from "../src/bar.ts";

// Deterministic style: filled cells wrap in <rgb>, empty cells wrap in <->.
const style: BarStyle = {
  fill: (text, [r, g, b]) => `<${r},${g},${b}>${text}</>`,
  track: (text) => `<->${text}</>`,
};
const stops = [[0, 0, 0], [128, 128, 128], [255, 255, 255]] as [number, number, number][];

test("draws the whole bottle and fills it to the used fraction", () => {
  // empty: full outline visible, nothing painted
  assert.equal(renderBar(0, 4, style, stops), "<->◖</><->─</><->─</><->─</><->─</><->◗</> 0%");
  // full: every cell + both caps painted along the gradient
  assert.equal(
    renderBar(1, 4, style, stops),
    "<0,0,0>◖</><0,0,0>━</><85,85,85>━</><170,170,170>━</><255,255,255>━</><255,255,255>◗</> 100%",
  );
});

test("rounds fill count and keeps the right cap dim until full", () => {
  // 0.5 * 4 = 2 filled body cells, left cap painted, right cap still track
  assert.equal(
    renderBar(0.5, 4, style, stops),
    "<0,0,0>◖</><0,0,0>━</><85,85,85>━</><->─</><->─</><->◗</> 50%",
  );
});

test("clamps out-of-range fractions", () => {
  assert.equal(renderBar(2, 2, style, stops).endsWith(" 100%"), true);
  assert.equal(renderBar(-1, 2, style, stops).endsWith(" 0%"), true);
});

test("interpolates rgb stops linearly", () => {
  assert.deepEqual(gradientAt(stops, 0), [0, 0, 0]);
  assert.deepEqual(gradientAt(stops, 0.5), [128, 128, 128]);
  assert.deepEqual(gradientAt(stops, 0.25), [64, 64, 64]);
  assert.deepEqual(gradientAt(stops, 1), [255, 255, 255]);
  assert.deepEqual(gradientAt(stops, 5), [255, 255, 255]); // clamped
});

test("classifies raw utilization thresholds", () => {
  assert.equal(barLevel(0.23), "success");
  assert.equal(barLevel(0.62), "success");
  assert.equal(barLevel(0.75), "warning");
  assert.equal(barLevel(0.9), "error");
});
