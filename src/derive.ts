import { basename } from "node:path";
import { formatContextPercent, formatWindow } from "./format.ts";

export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export function deriveProject(cwd: string): string {
  return basename(cwd);
}

export function deriveModel(model?: { id: string; provider?: string }, includeProvider = false): string {
  if (!model) return "";
  return includeProvider && model.provider ? `(${model.provider}) ${model.id}` : model.id;
}

export function deriveEffort(
  level: string,
  model?: { reasoning?: boolean },
): string {
  return level === "off" && model?.reasoning === false ? "" : level;
}

export function deriveContext(usage?: ContextUsage): { label: string; percent: number } | undefined {
  if (!usage || usage.percent === null) return undefined;
  return {
    label: `${formatContextPercent(usage.percent)}/${formatWindow(usage.contextWindow)}`,
    percent: usage.percent,
  };
}
