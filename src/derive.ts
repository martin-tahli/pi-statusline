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

export function deriveModel(model?: { id: string }): string {
  return model?.id ?? "";
}

export function deriveEffort(
  level: string,
  model?: { reasoning?: boolean },
): string {
  return level === "off" && model?.reasoning === false ? "" : level;
}

export function deriveContext(usage?: ContextUsage): { label: string; percent: number; tokens: number | null } | undefined {
  if (!usage || usage.percent === null) return undefined;
  return {
    label: `${formatContextPercent(usage.percent)}/${formatWindow(usage.contextWindow)}`,
    percent: usage.percent,
    tokens: usage.tokens,
  };
}

// Context-rot studies show degradation is task- and model-dependent rather than a universal
// cliff. These are deliberately conservative operational warnings, not model capability claims.
const DEGRADED_TOKENS = 170_000;
const CAUTION_TOKENS = 120_000;

export function contextSeverity(context: { percent: number; tokens: number | null }): "error" | "warning" | "success" {
  const tokens = context.tokens ?? 0;
  if (context.percent >= 90 || tokens >= DEGRADED_TOKENS) return "error";
  if (context.percent >= 75 || tokens >= CAUTION_TOKENS) return "warning";
  return "success";
}
