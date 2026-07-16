import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSegments, createSegments, SEGMENT_ORDER } from "../src/segments.ts";

const enabled = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, true])) as Record<(typeof SEGMENT_ORDER)[number], boolean>;
const namedSegments = () => createSegments(enabled, Object.fromEntries(
  SEGMENT_ORDER.map((id) => [id, () => id]),
) as Record<(typeof SEGMENT_ORDER)[number], () => string>);

test("segments render in priority order and drop disabled or empty values", () => {
  assert.deepEqual([...SEGMENT_ORDER], ["context", "session", "model", "effort", "project", "throughput", "time"]);
  const withoutEffort = { ...enabled, effort: false };
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => id === "context" ? "" : id])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  assert.equal(composeSegments(createSegments(withoutEffort, renderers), 200), "session · model · project · throughput · time");
});

test("injects separators and drops lowest-priority segments first", () => {
  const separator = " > ";
  const withoutTime = "context > session > model > effort > project > throughput";
  assert.equal(composeSegments(namedSegments(), visibleWidth(withoutTime), separator), withoutTime);

  const protectedPair = "context > session";
  assert.equal(composeSegments(namedSegments(), visibleWidth(protectedPair), separator), protectedPair);
  assert.equal(composeSegments(namedSegments(), 10, separator), "context");
  assert.ok(composeSegments(namedSegments(), 4, separator).startsWith("cont"));
});

test("composition is one width-bounded line", () => {
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => `${id}-long-value`])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  const line = composeSegments(createSegments(enabled, renderers), 40);
  assert.ok(visibleWidth(line) <= 40);
  assert.equal(line.includes("\n"), false);
});
