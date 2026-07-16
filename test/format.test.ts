import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, formatPercent, formatRate, formatResetCountdown, formatTime, formatWindow } from "../src/format.ts";

test("formats windows, percentages, rates, and durations", () => {
  assert.equal(formatWindow(128_000), "128K");
  assert.equal(formatWindow(200_000), "200K");
  assert.equal(formatWindow(1_000_000), "1.0M");
  assert.equal(formatPercent(0.55), "55.0%");
  assert.equal(formatRate(1_200), "1.2k");
  assert.equal(formatDuration(45_000), "45s");
  assert.equal(formatDuration(754_000), "12m34s");
  assert.equal(formatDuration(3_720_000), "1h02m");
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(2_460_000), "41m");
  assert.equal(formatResetCountdown(1_000_000, 1_000_000), "now");
  assert.equal(formatResetCountdown(1_000_000 + 42 * 60_000, 1_000_000), "42m");
  assert.equal(formatResetCountdown(1_000_000 + 134 * 60_000, 1_000_000), "2h14m");
  assert.equal(formatResetCountdown(1_000_000 + 76 * 3_600_000, 1_000_000), "3d4h");
  assert.equal(formatTime(754_000, 2_460_000, 18_000), "⏳ 12m34s (elapsed 41m, last 18s)");
});
