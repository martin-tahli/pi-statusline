import assert from "node:assert/strict";
import test from "node:test";
import { renderBar } from "../src/bar.ts";

test("renders and clamps fixed-width green bars", () => {
  const green = (text: string) => `<green>${text}</green>`;
  assert.equal(renderBar(0.23, 8, green), "[<green>██</green>░░░░░░] 23%");
  assert.equal(renderBar(1, 8), "[████████] 100%");
  assert.equal(renderBar(0, 8), "[░░░░░░░░] 0%");
  assert.equal(renderBar(2, 8), "[████████] 100%");
  assert.equal(renderBar(-1, 8), "[░░░░░░░░] 0%");
});
