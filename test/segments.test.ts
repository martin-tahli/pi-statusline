import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSegments, createSegments, SEGMENT_ORDER } from "../src/segments.ts";

const enabled = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, true])) as Record<(typeof SEGMENT_ORDER)[number], boolean>;
const namedSegments = () => createSegments(enabled, Object.fromEntries(
  SEGMENT_ORDER.map((id) => [id, () => id]),
) as Record<(typeof SEGMENT_ORDER)[number], () => string>);

test("segments render in display order and drop disabled or empty values", () => {
  assert.deepEqual([...SEGMENT_ORDER], ["project", "model", "effort", "context", "session", "throughput", "time"]);
  const withoutEffort = { ...enabled, effort: false };
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => id === "context" ? "" : id])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  assert.equal(composeSegments(createSegments(withoutEffort, renderers), 200), "project · model · session · throughput · time");
});

test("preserves display order while dropping lowest-priority segments", () => {
  const separator = " > ";
  const withoutTime = "project > model > effort > context > session > throughput";
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

test("a width-aware segment shrinks to the leftover columns instead of being dropped", () => {
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [
    id,
    id === "session" ? (budget?: number) => (budget === undefined || budget > 8 ? "session-long-value" : "session") : () => `${id}-long-value`,
  ])) as Record<(typeof SEGMENT_ORDER)[number], (budget?: number) => string>;
  // Everything at full length cannot fit; dropping per priority would remove session entirely.
  // context-long-value (18) + sep (1) + shrunk session (7) = 26.
  const line = composeSegments(createSegments(enabled, renderers), 26, " ");
  assert.ok(line.includes("session"), `session degraded in place: ${line}`);
  assert.equal(line.includes("session-long-value"), false, `session took the shrunk form: ${line}`);
  assert.ok(visibleWidth(line) <= 26, line);
});
