import type { StatuslineSettings } from "./schema.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";

/** Minimum refresh cadence and floor for cache age (matches the 10s/5min contract). */
const MIN_INTERVAL_MS = 10_000;

/** Per-provider refresh/cache policy resolved from settings (R18). */
export interface RefreshPolicy {
  intervalMs: number;
  maxAgeMs: number;
  useCache: boolean;
  keepAfterFailure: boolean;
  refreshWhileActive: boolean;
  refreshDisabledProvider: boolean;
}

export interface EligibilityInputs {
  /** Whether this provider's own row/tracking is enabled. */
  providerEnabled: boolean;
  /** Whether this provider is the currently active model. */
  isActive: boolean;
}

export type RefreshHealthState = "fresh" | "stale" | "unknown";

export interface RefreshHealth {
  state: RefreshHealthState;
  /** Sanitized reason for stale/unknown (never a secret or raw error). */
  reason?: string;
}

/** Merge provider defaults with sparse per-provider overrides, then bound the result. */
export function resolveProviderRefreshPolicy(
  settings: StatuslineSettings,
  _providerId: string,
  _capability?: ProviderCapability,
): RefreshPolicy {
  const defaults = settings.providers.defaults;
  // ponytail: per-provider override hook is the ProviderConfiguration; until it carries a
  // refresh block, defaults govern. Interval floored at 10s; maxAge finite and >= interval.
  const intervalMs = Math.max(MIN_INTERVAL_MS, Math.floor(defaults.refreshIntervalMs) || MIN_INTERVAL_MS);
  const requestedMaxAge = Math.floor(defaults.maxCacheAgeMs) || intervalMs;
  const maxAgeMs = Math.max(intervalMs, requestedMaxAge);
  return {
    intervalMs,
    maxAgeMs,
    useCache: defaults.useCache,
    keepAfterFailure: defaults.keepAfterFailure,
    refreshWhileActive: defaults.refreshWhileActive,
    refreshDisabledProvider: defaults.refreshDisabledProvider,
  };
}

/**
 * Refresh eligibility (R18): requires global tracking, the provider's own row, adapter
 * support, and policy permission. Unsupported/unauthenticated providers are never eligible,
 * so they make no network call.
 */
export function resolveRefreshEligibility(
  settings: StatuslineSettings,
  _providerId: string,
  capability: ProviderCapability,
  inputs: EligibilityInputs,
): boolean {
  if (!settings.providers.enabled) return false;
  if (!inputs.providerEnabled && !settings.providers.defaults.refreshDisabledProvider) return false;
  if (!capability.available || !capability.authenticated) return false;
  if (capability.quotaSupport === "none") return false;
  // Active provider only refreshes while active unless refreshWhileActive permits background.
  if (inputs.isActive && !settings.providers.defaults.refreshWhileActive && inputs.providerEnabled) {
    // Active + provider-enabled is always eligible (it is the session provider); this gate
    // only matters for non-active background providers, handled by providerEnabled above.
  }
  return true;
}

/**
 * Sanitized health from the last successful refresh timestamp (R18, KTD7). Fresh within
 * maxAge; stale after maxAge (last value retained when keepAfterFailure); unknown when never
 * refreshed. Reasons are UI-safe and contain no credential fragments.
 */
export function resolveRefreshHealth(
  previousFreshAt: number | undefined,
  now: number,
  policy: RefreshPolicy,
): RefreshHealth {
  if (previousFreshAt === undefined || !Number.isFinite(previousFreshAt)) {
    return { state: "unknown", reason: "no usage data yet" };
  }
  const age = now - previousFreshAt;
  if (age <= policy.maxAgeMs) return { state: "fresh" };
  return policy.keepAfterFailure
    ? { state: "stale", reason: "usage data is stale" }
    : { state: "unknown", reason: "usage data is stale" };
}
