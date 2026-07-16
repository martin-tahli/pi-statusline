import assert from "node:assert/strict";
import test from "node:test";
import { parseRateLimits } from "../src/ratelimit.ts";

const fixture = {
  "anthropic-ratelimit-unified-5h-utilization": "0.23",
  "anthropic-ratelimit-unified-5h-reset": "2026-07-15T18:00:00Z",
  "anthropic-ratelimit-unified-7d-utilization": "0.41",
  "anthropic-ratelimit-unified-7d-reset": "1784246400000",
};

test("parses Anthropic unified 5h and weekly utilization", () => {
  const limits = parseRateLimits(fixture);
  assert.equal(limits.fiveHour?.used, 0.23);
  assert.equal(limits.weekly?.used, 0.41);
  assert.equal(limits.fiveHour?.resetAt, Date.parse("2026-07-15T18:00:00Z"));
  assert.equal(limits.weekly?.resetAt, 1_784_246_400_000);
});

test("hides bars for absent, unrecognized, partial, or invalid headers", () => {
  assert.deepEqual(parseRateLimits({}), {});
  assert.deepEqual(parseRateLimits({ "x-ratelimit-5h": "0.2", "x-ratelimit-7d": "0.4" }), {});
  assert.deepEqual(parseRateLimits({ "anthropic-ratelimit-unified-5h-utilization": "0.2" }), {});
  assert.deepEqual(parseRateLimits({ ...fixture, "anthropic-ratelimit-unified-7d-utilization": "unknown" }), {});
});
