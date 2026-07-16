import assert from "node:assert/strict";
import test from "node:test";
import { gitBranchSymbol, gitStatusTokens, parseGitStatus } from "../src/git.ts";

const record = (value: string) => `${value}\0`;

test("parses porcelain v2 upstream counts", () => {
  assert.deepEqual(parseGitStatus([
    record("# branch.oid abc123"),
    record("# branch.ab +2 -1"),
    record("1 .M N... modified.ts"),
  ].join("")), { ahead: 2, behind: 1 });
});

test("formats upstream direction or a clean tick", () => {
  assert.equal(gitBranchSymbol(true), "");
  assert.equal(gitBranchSymbol(false), "");
  assert.deepEqual(gitStatusTokens({ ahead: 0, behind: 0 }), [{ kind: "clean", text: "✓" }]);
  assert.deepEqual(gitStatusTokens({ ahead: 2, behind: 1 }), [
    { kind: "behind", text: "↓1" },
    { kind: "ahead", text: "↑2" },
  ]);
  assert.deepEqual(gitStatusTokens(parseGitStatus(record("1 .M N... modified.ts"))), [{ kind: "clean", text: "✓" }]);
  assert.deepEqual(gitStatusTokens("error"), [{ kind: "error", text: "!" }]);
});
