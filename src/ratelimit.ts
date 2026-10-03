import { sanitizeDisplayString } from "./settings/validation.ts";

export interface RateLimitWindow {
  /** Stable adapter identity; labels may be renamed without losing settings. */
  key?: string;
  label: string;
  used: number;
  resetAt?: number;
  usedAmount?: number;
  remainingAmount?: number;
  unit?: "USD";
}

export type RateLimits = RateLimitWindow[];

const ANTHROPIC_WINDOWS = [
  ["five-hour", "5h", "anthropic-ratelimit-unified-5h-utilization"],
  ["seven-day", "wk", "anthropic-ratelimit-unified-7d-utilization"],
] as const;

function numberInRange(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

function reset(value: string | number | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) ? (numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric) : Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 8.64e15 ? parsed : undefined;
}

function durationLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "wk" : `${minutes / 10_080}wk`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function parseAnthropicUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const usage = payload as Record<string, unknown>;

  const windows: RateLimits = ([["five-hour", "5h", usage.five_hour], ["seven-day", "wk", usage.seven_day]] as const).flatMap(([key, label, value]) => {
    if (!value || typeof value !== "object") return [];
    const window = value as Record<string, unknown>;
    const utilization = window.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization) || utilization < 0 || utilization > 100) return [];
    const resetAt = reset(typeof window.resets_at === "string" || typeof window.resets_at === "number" ? window.resets_at : undefined);
    return [{ key, label, used: utilization / 100, ...(resetAt === undefined ? {} : { resetAt }) }];
  });
  if (Array.isArray(usage.limits)) for (const value of usage.limits) {
    const name = value?.scope?.model?.display_name;
    const percent = value?.percent;
    if (typeof name !== "string" || !name || typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100) continue;
    const label = sanitizeDisplayString(name);
    const key = `model:${label}`;
    if (windows.some((window) => window.key === key)) continue;
    const resetAt = reset(typeof value.resets_at === "string" ? value.resets_at : undefined);
    windows.push({ key, label: `${label} wk`, used: percent / 100, ...(resetAt ? { resetAt } : {}) });
  }
  return windows;
}

export function parseCodexUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const rateLimit = (payload as Record<string, unknown>).rate_limit;
  if (!rateLimit || typeof rateLimit !== "object") return [];

  return ["primary_window", "secondary_window"].flatMap((name) => {
    const value = (rateLimit as Record<string, unknown>)[name];
    if (!value || typeof value !== "object") return [];
    const window = value as Record<string, unknown>;
    const percent = typeof window.used_percent === "number" ? window.used_percent : undefined;
    const seconds = typeof window.limit_window_seconds === "number" ? window.limit_window_seconds : undefined;
    if (percent === undefined || !Number.isFinite(percent) || percent < 0 || percent > 100 || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return [];
    const resetAt = reset(typeof window.reset_at === "number" ? window.reset_at : undefined);
    return [{
      key: name === "primary_window" ? "primary" : "secondary",
      label: durationLabel(seconds / 60),
      used: percent / 100,
      ...(resetAt === undefined ? {} : { resetAt }),
    }];
  });
}

// Z.AI has not published this endpoint in its own API docs (docs.z.ai); it's only known from a
// third-party reverse-engineered tool. Used anyway at the user's request because it works with
// pi's own stored GLM key and reports the same 5h/weekly credit windows Z.AI documents for the
// Coding Plan (docs.z.ai/devpack/teamplan). Upgrade path: drop this if Z.AI ever breaks/replaces it.
export function parseZaiUsage(payload: unknown): RateLimits {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return [];
  const rawLimits = (data as Record<string, unknown>).limits;
  if (!Array.isArray(rawLimits)) return [];

  // Only TOKENS_LIMIT entries are the coding-plan credit windows; TIME_LIMIT entries are an
  // unrelated MCP tool-call budget (search-prime/web-reader/zread), not the model quota.
  const windows = rawLimits.filter((entry) => entry?.type === "TOKENS_LIMIT").flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const window = entry as Record<string, unknown>;
    if (window.type !== "TOKENS_LIMIT") return [];
    const percentage = window.percentage;
    if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) return [];
    return [{ key: `window-${index + 1}`, label: `quota${index + 1}`, used: percentage / 100, resetAt: reset(typeof window.nextResetTime === "number" ? window.nextResetTime : undefined) }];
  });
  // ponytail: undocumented identities; preserve response order with neutral labels until the
  // endpoint supplies verified window IDs. Reset order cannot distinguish 5h from weekly.
  return windows;
}

export function parseOpenRouterUsage(payload: unknown): RateLimits {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : undefined;
  if (!data || typeof data !== "object") return [];
  const { limit, limit_remaining } = data as Record<string, unknown>;
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0
    || typeof limit_remaining !== "number" || !Number.isFinite(limit_remaining)) return [];
  const remaining = Math.max(0, Math.min(limit, limit_remaining));
  return [{ key: "key-budget", label: "key budget", used: (limit - remaining) / limit,
    usedAmount: limit - remaining, remainingAmount: remaining, unit: "USD" }];
}

export function parseStoredRateLimits(value: unknown): RateLimits {
  if (!Array.isArray(value)) return [];
  return value.flatMap((window) => {
    if (!window || typeof window !== "object") return [];
    const { key, label, used, resetAt, usedAmount, remainingAmount, unit } = window as Record<string, unknown>;
    if (key !== undefined && (typeof key !== "string" || !key.trim())) return [];
    if (typeof label !== "string" || !label || typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 1) return [];
    // Stored timestamps are already milliseconds, never reinterpret them as seconds.
    const parsedResetAt = typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0 && resetAt <= 8.64e15 ? resetAt : undefined;
    return [{
      ...(typeof key === "string" ? { key: sanitizeDisplayString(key) } : {}),
      label: sanitizeDisplayString(label),
      used,
      ...(parsedResetAt === undefined ? {} : { resetAt: parsedResetAt }),
      ...(unit === "USD" && typeof usedAmount === "number" && Number.isFinite(usedAmount) && usedAmount >= 0 ? { usedAmount, unit } : {}),
      ...(unit === "USD" && typeof remainingAmount === "number" && Number.isFinite(remainingAmount) && remainingAmount >= 0 ? { remainingAmount, unit } : {}),
    }];
  });
}

export function parseRateLimits(headers: Record<string, string>): RateLimits {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const limits: RateLimits = ANTHROPIC_WINDOWS.flatMap(([key, label, header]) => {
    const used = numberInRange(normalized[header], 1);
    const resetAt = reset(normalized[header.replace("utilization", "reset")]);
    return used === undefined ? [] : [{ key, label, used, ...(resetAt === undefined ? {} : { resetAt }) }];
  });

  for (const name of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${name}`;
    const percent = numberInRange(normalized[`${prefix}-used-percent`], 100);
    if (percent === undefined) continue;
    const minutes = numberInRange(normalized[`${prefix}-window-minutes`], Number.MAX_SAFE_INTEGER);
    const resetAt = reset(normalized[`${prefix}-reset-at`]);
    if (percent === 0 && minutes === undefined && resetAt === undefined) continue;
    limits.push({
      key: name,
      label: minutes === undefined || minutes <= 0 ? name : durationLabel(minutes),
      used: percent / 100,
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }

  return limits;
}
