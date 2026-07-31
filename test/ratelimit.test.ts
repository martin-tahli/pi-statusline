import assert from "node:assert/strict";
import test from "node:test";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, parseZaiUsage } from "../src/ratelimit.ts";

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

test("parses Anthropic OAuth usage", () => {
  assert.deepEqual(parseAnthropicUsage({
    five_hour: { utilization: 23, resets_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 41, resets_at: 1_784_246_400 },
  }), [
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

test("parses Z.AI TOKENS_LIMIT windows, ordering the untouched/sooner-resetting one as 5h", () => {
  assert.deepEqual(parseZaiUsage({
    data: {
      limits: [
        { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: 1_787_999_449_996 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 0 },
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 5, nextResetTime: 1_785_753_049_998 },
      ],
      level: "pro",
    },
    success: true,
  }), [
    { label: "5h", used: 0 },
    { label: "wk", used: 0.05, resetAt: 1_785_753_049_998 },
  ]);
});

test("orders two reset-bearing Z.AI windows by which resets sooner", () => {
  assert.deepEqual(parseZaiUsage({
    data: {
      limits: [
        { type: "TOKENS_LIMIT", percentage: 40, nextResetTime: 1_785_753_049_998 },
        { type: "TOKENS_LIMIT", percentage: 10, nextResetTime: 1_785_000_049_998 },
      ],
    },
  }), [
    { label: "5h", used: 0.1, resetAt: 1_785_000_049_998 },
    { label: "wk", used: 0.4, resetAt: 1_785_753_049_998 },
  ]);
});

test("hides Z.AI usage on any unexpected shape rather than guessing", () => {
  assert.deepEqual(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10 }] } }), []);
  assert.deepEqual(parseZaiUsage({ data: { limits: [] } }), []);
  assert.deepEqual(parseZaiUsage({ data: { limits: [{ type: "TOKENS_LIMIT", percentage: 101 }, { type: "TOKENS_LIMIT", percentage: 5 }] } }), []);
  assert.deepEqual(parseZaiUsage({}), []);
  assert.deepEqual(parseZaiUsage(null), []);
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
