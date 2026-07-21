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

// The prompt-processing "rate" (input tokens ÷ time-to-first-token) is only a real, measurable
// number for local inference. Over a network it collapses to request latency + prompt caching,
// so it just tracks prompt size (a 7.4k-token prompt reads as a bogus "7.4k t/s"). Detect local
// endpoints by loopback/LAN host so hosted providers can suppress the meaningless rate.
export function isLocalEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return false;
  }
  return host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "0.0.0.0"
    || host.endsWith(".local")
    || /^10\./.test(host)
    || /^192\.168\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

// The throughput segment means different things per billing model: on local inference the ↑/↓
// token rate is the real, measurable point; on a subscription the meaningful budget is the quota
// window (shown by the session bars), not tokens or cost; on a per-token API what matters is how
// many tokens you've spent and the running cost.
export type BillingMode = "local" | "subscription" | "api";

export function billingMode(local: boolean, subscription: boolean): BillingMode {
  if (local) return "local";
  return subscription ? "subscription" : "api";
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
