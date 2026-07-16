export interface GitStatus {
  ahead: number;
  behind: number;
}

export type GitStatusState = GitStatus | "error";
export type GitTokenKind = "ahead" | "behind" | "clean" | "error";

export interface GitStatusToken {
  kind: GitTokenKind;
  text: string;
}

export const gitBranchSymbol = (nerdFont: boolean) => nerdFont ? "" : "";

export function parseGitStatus(output: string): GitStatus {
  const match = /(?:^|\0)# branch\.ab \+(\d+) -(\d+)(?:\0|$)/.exec(output);
  return {
    ahead: Number(match?.[1] ?? 0),
    behind: Number(match?.[2] ?? 0),
  };
}

export function gitStatusTokens(status: GitStatusState): GitStatusToken[] {
  if (status === "error") return [{ kind: "error", text: "!" }];
  const tokens: GitStatusToken[] = [
    status.behind && { kind: "behind", text: `↓${status.behind}` },
    status.ahead && { kind: "ahead", text: `↑${status.ahead}` },
  ].filter((token): token is GitStatusToken => Boolean(token));
  return tokens.length ? tokens : [{ kind: "clean", text: "✓" }];
}
