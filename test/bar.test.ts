import assert from "node:assert/strict";
import test from "node:test";
import { renderBar, usageColor, type BarStyle, type ColorStops } from "../src/bar.ts";

const style: BarStyle = {
  fill: (text, [r, g, b]) => `<${r},${g},${b}>${text}</>`,
  track: (text) => `<->${text}</>`,
};
const stops: ColorStops = [[0, 0, 0], [128, 128, 128], [255, 255, 255]];

test("draws one continuous rounded line without brackets or blocks", () => {
  assert.equal(renderBar(0, 4, style, stops), "<->╶──╴</> 0%");
  assert.equal(renderBar(0.5, 4, style, stops), "<0,0,0>╺━</><->─╴</> 50%");
  assert.equal(renderBar(1, 4, style, stops), "<255,255,255>╺━━╸</> 100%");

  const line = renderBar(0.56, 12, style, stops);
  for (const glyph of ["◖", "◗", "█", "▓", "▒", "░"]) assert.equal(line.includes(glyph), false);
});

test("clamps usage and minimum width", () => {
  assert.equal(renderBar(2, 1, style, stops).endsWith(" 100%"), true);
  assert.equal(renderBar(-1, 1, style, stops).endsWith(" 0%"), true);
});

test("holds neon green, then blends through orange into blood red", () => {
  assert.deepEqual(usageColor(0.6), [92, 255, 170]);
  assert.deepEqual(usageColor(0.85), [255, 140, 32]);
  assert.deepEqual(usageColor(1), [145, 0, 32]);
  assert.deepEqual(usageColor(0, stops), [0, 0, 0]);
  assert.deepEqual(usageColor(0.6, stops), [0, 0, 0]);
  assert.deepEqual(usageColor(0.725, stops), [64, 64, 64]);
  assert.deepEqual(usageColor(0.85, stops), [128, 128, 128]);
  assert.deepEqual(usageColor(0.925, stops), [192, 192, 192]);
  assert.deepEqual(usageColor(5, stops), [255, 255, 255]);
});
