import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUsage, parseRateLimits, parseStoredRateLimits } from "../src/ratelimit.ts";

const fixture = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": "2026-07-15T18:00:00Z",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": "1784246400000",
};

test("parses Anthropic unified windows", () => {
  assert.deepEqual(parseRateLimits(fixture), [
    { label: "5h", used: 0.23, resetAt: Date.parse("2026-07-15T18:00:00Z") },
    { label: "wk", used: 0.41, resetAt: 1_784_246_400_000 },
  ]);
});

test("parses only the Codex windows actually reported", () => {
  assert.deepEqual(parseRateLimits({
    "X-Codex-Primary-Used-Percent": "23",
    "X-Codex-Primary-Window-Minutes": "60",
    "X-Codex-Primary-Reset-At": "1784246400",
    "X-Codex-Secondary-Used-Percent": "41",
    "X-Codex-Secondary-Window-Minutes": "10080",
  }), [
    { label: "1h", used: 0.23, resetAt: 1_784_246_400_000 },
    { label: "wk", used: 0.41 },
  ]);
  assert.deepEqual(parseRateLimits({
    "x-codex-primary-used-percent": "41",
    "x-codex-primary-window-minutes": "43200",
  }), [{ label: "30d", used: 0.41 }]);
});

test("parses Codex account usage by the windows returned by the account", () => {
  assert.deepEqual(parseCodexUsage({
    rate_limit: {
      primary_window: null,
      secondary_window: {
        used_percent: 63,
        limit_window_seconds: 604_800,
        reset_at: 1_784_246_400,
      },
    },
  }), [{ label: "wk", used: 0.63, resetAt: 1_784_246_400_000 }]);
  assert.deepEqual(parseCodexUsage({ rate_limit: null }), []);
});

test("restores only valid saved windows", () => {
  assert.deepEqual(parseStoredRateLimits([
    { label: "5h", used: 0.23, resetAt: 1_784_246_400 },
    { label: "wk", used: 0.41 },
    { label: "bad", used: 2 },
    null,
  ]), [
    { label: "5h", used: 0.23, resetAt: 1_784_246_400_000 },
    { label: "wk", used: 0.41 },
  ]);
  assert.deepEqual(parseStoredRateLimits({}), []);
});

test("hides absent, unrecognized, or invalid windows without hiding valid siblings", () => {
  assert.deepEqual(parseRateLimits({}), []);
  assert.deepEqual(parseRateLimits({ "x-ratelimit-5h": "0.2" }), []);
  assert.deepEqual(parseRateLimits({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }), [
    { label: "5h", used: 0.2 },
  ]);
  assert.deepEqual(parseRateLimits({ ...fixture, "anthropic-ratelimit-unified-7d-utilization": "unknown" }), [
    { label: "5h", used: 0.23, resetAt: Date.parse("2026-07-15T18:00:00Z") },
  ]);
});
