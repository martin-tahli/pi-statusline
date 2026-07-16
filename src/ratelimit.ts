export interface RateLimitWindow {
  label: string;
  used: number;
  resetAt?: number;
}

export type RateLimits = RateLimitWindow[];

const ANTHROPIC_WINDOWS = [
  ["5h", "anthropic-ratelimit-unified-5h-utilization"],
  ["wk", "anthropic-ratelimit-unified-7d-utilization"],
] as const;

function numberInRange(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= max ? parsed : undefined;
}

function reset(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function durationLabel(minutes: number): string {
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "wk" : `${minutes / 10_080}wk`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
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
    if (percent === undefined || percent < 0 || percent > 100 || seconds === undefined || seconds <= 0) return [];
    const resetAt = typeof window.reset_at === "number" ? window.reset_at : undefined;
    return [{
      label: durationLabel(seconds / 60),
      used: percent / 100,
      ...(resetAt === undefined ? {} : { resetAt }),
    }];
  });
}

export function parseRateLimits(headers: Record<string, string>): RateLimits {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const limits: RateLimits = ANTHROPIC_WINDOWS.flatMap(([label, header]) => {
    const used = numberInRange(normalized[header], 1);
    const resetAt = reset(normalized[header.replace("utilization", "reset")]);
    return used === undefined ? [] : [{ label, used, ...(resetAt === undefined ? {} : { resetAt }) }];
  });

  for (const name of ["primary", "secondary"] as const) {
    const prefix = `x-codex-${name}`;
    const percent = numberInRange(normalized[`${prefix}-used-percent`], 100);
    if (percent === undefined) continue;
    const minutes = numberInRange(normalized[`${prefix}-window-minutes`], Number.MAX_SAFE_INTEGER);
    const resetAt = reset(normalized[`${prefix}-reset-at`]);
    if (percent === 0 && minutes === undefined && resetAt === undefined) continue;
    limits.push({
      label: minutes === undefined ? name : durationLabel(minutes),
      used: percent / 100,
      ...(resetAt === undefined ? {} : { resetAt }),
    });
  }

  return limits;
}
