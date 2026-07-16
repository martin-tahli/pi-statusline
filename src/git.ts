export interface GitStatus {
  staged: number;
  modified: number;
  untracked: number;
  deleted: number;
  conflicts: number;
  ahead: number;
  behind: number;
  dirty?: boolean;
}

export type GitStatusState = GitStatus | "error";
export type GitTokenKind = "staged" | "modified" | "deleted" | "dirty" | "ahead" | "behind" | "clean" | "error";

export interface GitStatusToken {
  kind: GitTokenKind;
  text: string;
}

export const gitBranchSymbol = (nerdFont: boolean) => nerdFont ? "" : "⎇";

export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = { staged: 0, modified: 0, untracked: 0, deleted: 0, conflicts: 0, ahead: 0, behind: 0 };
  const records = output.split("\0");

  for (let index = 0; index < records.length; index++) {
    const value = records[index];
    if (value.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)$/.exec(value);
      if (match) [status.ahead, status.behind] = [Number(match[1]), Number(match[2])];
      continue;
    }
    if (value.startsWith("? ")) {
      status.untracked++;
      continue;
    }
    if (value.startsWith("u ")) {
      status.conflicts++;
      continue;
    }
    if (!value.startsWith("1 ") && !value.startsWith("2 ")) continue;

    const [staged, working] = value.slice(2, 4);
    const submodule = value.slice(5, 9);
    if (staged !== ".") status.staged++;
    if (staged === "D" || working === "D") status.deleted++;
    if (working !== "." && working !== "D") status.modified++;
    if (staged === "." && working === "." && submodule !== "N...") status.dirty = true;
    if (value.startsWith("2 ")) index++; // porcelain v2 emits the old rename path as the next NUL record
  }
  return status;
}

export function gitStatusTokens(status: GitStatusState): GitStatusToken[] {
  if (status === "error") return [{ kind: "error", text: "!" }];
  const modified = status.modified + status.untracked;
  const tokens: GitStatusToken[] = [
    status.conflicts && { kind: "error", text: `!${status.conflicts}` },
    status.staged && { kind: "staged", text: `+${status.staged}` },
    modified && { kind: "modified", text: `~${modified}` },
    status.deleted && { kind: "deleted", text: `-${status.deleted}` },
    status.dirty && { kind: "dirty", text: "●" },
    status.ahead && { kind: "ahead", text: `↑${status.ahead}` },
    status.behind && { kind: "behind", text: `↓${status.behind}` },
  ].filter((token): token is GitStatusToken => Boolean(token));
  return tokens.length ? tokens : [{ kind: "clean", text: "✓" }];
}
