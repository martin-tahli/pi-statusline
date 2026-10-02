import type { RateLimits } from "./ratelimit.ts";

export const PROVIDER_REFRESH_MS = 10_000;
// Keep the last quota during a brief provider/API outage instead of flickering to unavailable.
export const PROVIDER_MAX_AGE_MS = 5 * 60_000;

export interface ProviderUsage {
  limits: RateLimits;
  /** Successful fetch time, preserved across cache reads/fallbacks. */
  updatedAt?: number;
  cached?: boolean;
}

export type ProviderHealth =
  | { state: "fresh"; usage: ProviderUsage; updatedAt: number }
  | { state: "hidden"; reason: string; updatedAt?: number };

export interface ProviderAdapter {
  refresh(signal: AbortSignal): Promise<ProviderUsage | undefined>;
}

/** Thrown by a provider usage fetch on HTTP 429. The provider-usage cache catches it to apply a
 *  shared, persisted backoff, so every session and every caller (background poll, session start,
 *  model select) stops hammering the endpoint until the cooldown elapses. */
export class RateLimitedError extends Error {
  constructor() {
    super("usage endpoint returned 429");
    this.name = "RateLimitedError";
  }

  static is(error: unknown): error is RateLimitedError {
    return error instanceof Error && error.name === "RateLimitedError";
  }
}

/** An explicit provider denial, not a transient outage: cached quota is no longer usable. */
export class UsageUnavailableError extends Error {
  constructor() {
    super("usage unavailable");
    this.name = "UsageUnavailableError";
  }

  static is(error: unknown): error is UsageUnavailableError {
    // Pi's uncached TS loader can create separate class instances for each import.
    return error instanceof Error && error.name === "UsageUnavailableError";
  }
}

/** Never surface thrown provider data; these are deliberately short UI-safe reasons. */
export function sanitizedReason(provider: string, error?: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "usage refresh timed out";
  return "usage unavailable";
}

export class ProviderRefreshCoordinator {
  private readonly health = new Map<string, ProviderHealth>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();
  private readonly attemptedAt = new Map<string, number>();
  private generation = 0;
  private readonly policy?: (provider: string) => { eligible: boolean; intervalMs: number; maxAgeMs: number; keepAfterFailure: boolean };

  constructor(
    adapters: ReadonlyMap<string, ProviderAdapter>,
    onUpdate: () => void,
    cadenceMs = PROVIDER_REFRESH_MS,
    maxAgeMs = PROVIDER_MAX_AGE_MS,
    policy?: ProviderRefreshCoordinator["policy"],
  ) {
    this.policy = policy;
    this.adapters = adapters;
    this.onUpdate = onUpdate;
    this.cadenceMs = cadenceMs;
    this.maxAgeMs = maxAgeMs;
  }

  private readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  private readonly onUpdate: () => void;
  private readonly cadenceMs: number;
  private readonly maxAgeMs: number;

  start(providers: readonly string[]) {
    this.stop();
    if (!providers.length) return;
    for (const provider of providers) void this.refresh(provider, false);
    this.timer = setInterval(() => { for (const provider of providers) void this.refresh(provider, false); }, this.cadenceMs);
    this.timer.unref?.();
  }

  stop() {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(provider: string, now = Date.now()): ProviderHealth {
    const value = this.health.get(provider);
    if (value?.state === "fresh" && now - value.updatedAt <= (this.policy?.(provider).maxAgeMs ?? this.maxAgeMs)) return value;
    return value?.state === "hidden" ? value : { state: "hidden", reason: value ? "usage data is stale" : "usage unavailable", updatedAt: value?.updatedAt };
  }

  prime(provider: string, usage: ProviderUsage, updatedAt: number): void {
    if (usage.limits.length && Number.isFinite(updatedAt) && updatedAt <= Date.now()) this.health.set(provider, { state: "fresh", usage, updatedAt });
  }

  async refresh(provider: string, force = true): Promise<void> {
    const policy = this.policy?.(provider);
    if (policy && (!policy.eligible || (!force && Date.now() - (this.attemptedAt.get(provider) ?? -Infinity) < policy.intervalMs))) return;
    if (this.running.has(provider)) return;
    const generation = this.generation;
    this.attemptedAt.set(provider, Date.now());
    this.running.add(provider);
    const adapter = this.adapters.get(provider);
    const previous = this.health.get(provider);
    if (!adapter) {
      if (previous?.state !== "fresh") this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider) });
      this.running.delete(provider);
      this.onUpdate();
      return;
    }
    try {
      const usage = await adapter.refresh(AbortSignal.timeout(Math.min(this.cadenceMs, 3_000)));
      if (generation !== this.generation) return;
      if (usage?.limits.length) this.health.set(provider, { state: "fresh", usage, updatedAt: usage.updatedAt ?? Date.now() });
      else if (policy?.keepAfterFailure === false || previous?.state !== "fresh") this.health.set(provider, { state: "hidden", reason: "usage unavailable" });
      else this.health.set(provider, { ...previous, usage: { ...previous.usage, cached: true } });
    } catch (error) {
      if (generation !== this.generation) return;
      if (UsageUnavailableError.is(error) || policy?.keepAfterFailure === false || previous?.state !== "fresh") {
        this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider, error) });
      } else this.health.set(provider, { ...previous, usage: { ...previous.usage, cached: true } });
    } finally {
      this.running.delete(provider);
      this.onUpdate();
    }
  }
}
