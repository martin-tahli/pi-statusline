import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_STATUSLINE_SETTINGS } from "../src/settings/defaults.ts";
import {
  ROOT_ROWS,
  createSettingsUi,
  isDirty,
  renderSettingsUi,
  replaceDraft,
  resetDraft,
  resolveDirtyChoice,
  routeSettingsKey,
} from "../src/settings/ui.ts";

test("root rows and keyboard routing are exact and deterministic", () => {
  assert.deepEqual(ROOT_ROWS.map(({ label }) => label), ["Providers", "Separators", "Emojis"]);

  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  assert.equal(routeSettingsKey(initial, "ArrowUp").state.selected, 0);
  assert.equal(routeSettingsKey(initial, "End").state.selected, ROOT_ROWS.length - 1);
  assert.equal(routeSettingsKey(initial, "x").state, initial);
  const moved = routeSettingsKey(initial, "ArrowDown").state;
  assert.equal(moved.selected, 1);
  assert.equal(routeSettingsKey(initial, "Enter").state.openRow, "providers");
  assert.equal(routeSettingsKey({ ...moved, openRow: "providers" }, "Escape").state.openRow, undefined);
  assert.deepEqual(initial, createSettingsUi(DEFAULT_STATUSLINE_SETTINGS));
});

test("draft creation, replacement, and reset are structured-cloned", () => {
  const source = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  const state = createSettingsUi(source);
  state.draft.layout.segmentOrder.reverse();
  assert.notDeepEqual(state.draft.layout.segmentOrder, source.layout.segmentOrder);

  const replacement = structuredClone(source);
  replacement.enabled = false;
  const replaced = replaceDraft(state, replacement);
  replacement.layout.segmentOrder.reverse();
  assert.notDeepEqual(replaced.draft.layout.segmentOrder, replacement.layout.segmentOrder);
  assert.equal(isDirty(replaced), true);

  replaced.draft.__unknown = { nested: { kept: true } };
  const reset = resetDraft(replaced);
  assert.deepEqual(reset.draft.layout, DEFAULT_STATUSLINE_SETTINGS.layout);
  assert.deepEqual(reset.draft.__unknown, { nested: { kept: true } });
  assert.notEqual(reset.draft.__unknown, replaced.draft.__unknown);
});

test("render uses production preview fixtures and hides preview when narrow without mutation", () => {
  const state = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const before = structuredClone(state);
  const wide = renderSettingsUi(state, { width: 100, previewMode: "local" });
  assert.ok(wide.includes("Local model preview"));
  assert.ok(wide.length > ROOT_ROWS.length + 1);

  const narrow = renderSettingsUi(state, { width: 79, previewMode: "local" });
  assert.equal(narrow.includes("Local model preview"), false);
  assert.equal(narrow.length, ROOT_ROWS.length + 1);
  assert.deepEqual(state, before);
});

test("dirty Save, Discard, and Cancel preserve state correctly", async () => {
  const initial = createSettingsUi(DEFAULT_STATUSLINE_SETTINGS);
  const dirty = replaceDraft(initial, { ...initial.draft, enabled: false });
  const prompted = routeSettingsKey(dirty, "Escape").state;
  assert.equal(prompted.confirmClose, true);

  const cancelled = await resolveDirtyChoice(prompted, "cancel", () => assert.fail("must not save"));
  assert.equal(cancelled.action, "none");
  assert.equal(cancelled.state.draft.enabled, false);

  const discarded = await resolveDirtyChoice(prompted, "discard", () => assert.fail("must not save"));
  assert.equal(discarded.action, "close");
  assert.equal(discarded.state.draft.enabled, true);
  assert.notEqual(discarded.state.draft, discarded.state.original);

  const failed = await resolveDirtyChoice(prompted, "save", async (value) => {
    value.enabled = true;
    throw new Error("disk full");
  });
  assert.equal(failed.action, "confirm-close");
  assert.equal(failed.state.confirmClose, true);
  assert.equal(failed.state.error, "disk full");
  assert.equal(failed.state.draft.enabled, false);
  assert.equal(isDirty(failed.state), true);

  let saved: typeof initial.draft | undefined;
  const succeeded = await resolveDirtyChoice(prompted, "save", (value) => { saved = value; });
  assert.equal(succeeded.action, "close");
  assert.equal(succeeded.state.confirmClose, false);
  assert.equal(isDirty(succeeded.state), false);
  assert.notEqual(saved, succeeded.state.draft);
});
