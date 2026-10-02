export interface GitStatus {
  ahead: number;
  behind: number;
  dirty: number;
  conflicts?: number;
}

export type GitStatusState = GitStatus | "error";
export type GitTokenKind = "ahead" | "behind" | "dirty" | "clean" | "error";

export interface GitStatusToken {
  kind: GitTokenKind;
  text: string;
}

export const gitBranchSymbol = (nerdFont: boolean) => nerdFont ? "" : "";

export function parseGitStatus(output: string): GitStatus {
  const abMatch = /(?:^|\0)# branch\.ab \+(\d+) -(\d+)(?:\0|$)/.exec(output);
  let dirty = 0, conflicts = 0;
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const kind = records[i].slice(0, 2);
    if (["1 ", "2 ", "? ", "u "].includes(kind)) dirty++;
    if (kind === "u ") conflicts++;
    if (kind === "2 ") i++; // Rename source path is a separate NUL record, not a status.
  }
  return {
    ahead: Number(abMatch?.[1] ?? 0),
    behind: Number(abMatch?.[2] ?? 0),
    dirty,
    ...(conflicts ? { conflicts } : {}),
  };
}

export function gitStatusTokens(status: GitStatusState): GitStatusToken[] {
  if (status === "error") return [{ kind: "error", text: "!" }];
  const tokens: GitStatusToken[] = [
    status.conflicts && { kind: "error", text: `!conflict ${status.conflicts}` },
    status.dirty && { kind: "dirty", text: `● ${status.dirty}` },
    status.behind && { kind: "behind", text: `↓${status.behind}` },
    status.ahead && { kind: "ahead", text: `↑${status.ahead}` },
  ].filter((token): token is GitStatusToken => Boolean(token));
  return tokens.length ? tokens : [{ kind: "clean", text: "✓" }];
}
