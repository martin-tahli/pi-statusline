import assert from "node:assert/strict";
import test from "node:test";
import { gitBranchSymbol, gitStatusTokens, parseGitStatus } from "../src/git.ts";

const record = (value: string) => `${value}\0`;

test("parses porcelain v2 file and upstream counts", () => {
  const status = parseGitStatus([
    record("# branch.oid abc123"),
    record("# branch.head main"),
    record("# branch.upstream origin/main"),
    record("# branch.ab +2 -1"),
    record("1 M. N... staged.ts"),
    record("1 .M N... modified.ts"),
    record("1 MM N... both.ts"),
    record("1 D. N... staged-delete.ts"),
    record("1 .D N... deleted.ts"),
    record("2 R. N... renamed.ts"),
    record("old-name.ts"),
    record("? untracked\nname.ts"),
    record("u UU N... conflicted.ts"),
    record("! ignored.ts"),
  ].join(""));

  assert.deepEqual(status, {
    staged: 4,
    modified: 2,
    untracked: 1,
    deleted: 2,
    conflicts: 1,
    ahead: 2,
    behind: 1,
  });
});

test("formats only relevant compact Git tokens", () => {
  assert.equal(gitBranchSymbol(true), "");
  assert.equal(gitBranchSymbol(false), "⎇");

  const clean = parseGitStatus(record("# branch.ab +0 -0"));
  assert.deepEqual(gitStatusTokens(clean), [{ kind: "clean", text: "✓" }]);

  assert.deepEqual(gitStatusTokens({
    staged: 2,
    modified: 1,
    untracked: 3,
    deleted: 1,
    conflicts: 0,
    ahead: 2,
    behind: 1,
  }), [
    { kind: "staged", text: "+2" },
    { kind: "modified", text: "~1" },
    { kind: "untracked", text: "?3" },
    { kind: "deleted", text: "-1" },
    { kind: "ahead", text: "↑2" },
    { kind: "behind", text: "↓1" },
  ]);

  assert.deepEqual(gitStatusTokens({
    staged: 0,
    modified: 0,
    untracked: 0,
    deleted: 0,
    conflicts: 2,
    ahead: 0,
    behind: 0,
  }), [{ kind: "error", text: "!2" }]);
  assert.deepEqual(gitStatusTokens(parseGitStatus(record("1 .. S.M. dirty-submodule"))), [{ kind: "dirty", text: "●" }]);
  assert.deepEqual(gitStatusTokens("error"), [{ kind: "error", text: "!" }]);
});
