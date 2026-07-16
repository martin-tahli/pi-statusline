import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { composeSegments, createSegments, SEGMENT_ORDER } from "../src/segments.ts";

test("segments have fixed order and drop disabled or empty values", () => {
  assert.deepEqual([...SEGMENT_ORDER], ["project", "model", "effort", "context", "session", "throughput", "time"]);
  const enabled = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, id !== "effort"])) as Record<(typeof SEGMENT_ORDER)[number], boolean>;
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => id === "context" ? "" : id])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  assert.equal(composeSegments(createSegments(enabled, renderers), 200), "project · model · session · throughput · time");
});

test("composition is one width-bounded line", () => {
  const enabled = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, true])) as Record<(typeof SEGMENT_ORDER)[number], boolean>;
  const renderers = Object.fromEntries(SEGMENT_ORDER.map((id) => [id, () => `${id}-long-value`])) as Record<(typeof SEGMENT_ORDER)[number], () => string>;
  const line = composeSegments(createSegments(enabled, renderers), 40);
  assert.ok(visibleWidth(line) <= 40);
  assert.equal(line.includes("\n"), false);
});
