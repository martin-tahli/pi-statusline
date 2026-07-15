export interface RateLimitWindow {
  used: number;
  resetAt?: number;
}

export interface RateLimits {
  fiveHour?: RateLimitWindow;
  weekly?: RateLimitWindow;
}

const FIVE_HOUR = "anthropic-ratelimit-unified-5h-utilization";
const WEEKLY = "anthropic-ratelimit-unified-7d-utilization";

function fraction(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : undefined;
}

function reset(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function parseRateLimits(headers: Record<string, string>): RateLimits {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const fiveHour = fraction(normalized[FIVE_HOUR]);
  const weekly = fraction(normalized[WEEKLY]);
  if (fiveHour === undefined || weekly === undefined) return {};
  return {
    fiveHour: { used: fiveHour, resetAt: reset(normalized[`${FIVE_HOUR.replace("utilization", "reset")}`]) },
    weekly: { used: weekly, resetAt: reset(normalized[`${WEEKLY.replace("utilization", "reset")}`]) },
  };
}
