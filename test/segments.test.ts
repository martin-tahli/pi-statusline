import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSegments, createSegments, SEGMENT_ORDER } from "../src/segments.ts";

const enabled = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, true])) as Record<(typeof SEGMENT_ORDER)[number], boolean>;
const namedSegments = () => createSegments(enabled, Object.fromEntries(
  SEGMENT_ORDER.map((id) => [id, () => id]),
) as Record<(typeof SEGMENT_ORDER)[number], () => string>);

test("segments have fixed order and drop disabled or empty values", () => {
  assert.deepEqual([...SEGMENT_ORDER], ["project", "model", "effort", "context", "session", "throughput", "time"]);
  const withoutEffort = { ...enabled, effort: false };
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => id === "context" ? "" : id])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  assert.equal(composeSegments(createSegments(withoutEffort, renderers), 200), "project · model · session · throughput · time");
});

test("injects separators and drops whole segments in priority order", () => {
  const separator = " > ";
  const withoutSession = "project > model > effort > context > throughput > time";
  assert.equal(composeSegments(namedSegments(), visibleWidth(withoutSession), separator), withoutSession);

  const protectedPair = "throughput > time";
  assert.equal(composeSegments(namedSegments(), visibleWidth(protectedPair), separator), protectedPair);
  const narrow = composeSegments(namedSegments(), 10, separator);
  assert.ok(visibleWidth(narrow) <= 10);
  assert.equal(narrow.includes("\n"), false);
});

test("composition is one width-bounded line", () => {
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => `${id}-long-value`])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  const line = composeSegments(createSegments(enabled, renderers), 40);
  assert.ok(visibleWidth(line) <= 40);
  assert.equal(line.includes("\n"), false);
});
