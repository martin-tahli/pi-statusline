import type { RateLimits } from "./ratelimit.ts";

export const PROVIDER_REFRESH_MS = 60_000;
export const PROVIDER_MAX_AGE_MS = PROVIDER_REFRESH_MS * 2;

export interface ProviderUsage {
  limits: RateLimits;
}

export type ProviderHealth =
  | { state: "fresh"; usage: ProviderUsage; updatedAt: number }
  | { state: "hidden"; reason: string; updatedAt?: number };

export interface ProviderAdapter {
  refresh(signal: AbortSignal): Promise<ProviderUsage | undefined>;
}

/** Never surface thrown provider data; these are deliberately short UI-safe reasons. */
export function sanitizedReason(provider: string, error?: unknown): string {
  if (provider === "glm") return "no documented usage source for pi";
  if (error instanceof DOMException && error.name === "TimeoutError") return "usage refresh timed out";
  return "usage unavailable";
}

export class ProviderRefreshCoordinator {
  private readonly health = new Map<string, ProviderHealth>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly running = new Set<string>();

  constructor(
    adapters: ReadonlyMap<string, ProviderAdapter>,
    onUpdate: () => void,
    cadenceMs = PROVIDER_REFRESH_MS,
    maxAgeMs = PROVIDER_MAX_AGE_MS,
  ) {
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
    for (const provider of providers) void this.refresh(provider);
    this.timer = setInterval(() => { for (const provider of providers) void this.refresh(provider); }, this.cadenceMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  get(provider: string, now = Date.now()): ProviderHealth {
    const value = this.health.get(provider);
    if (value?.state === "fresh" && now - value.updatedAt <= this.maxAgeMs) return value;
    return value?.state === "hidden" ? value : { state: "hidden", reason: "usage data is stale", updatedAt: value?.updatedAt };
  }

  async refresh(provider: string): Promise<void> {
    if (this.running.has(provider)) return;
    this.running.add(provider);
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider) });
      this.running.delete(provider);
      this.onUpdate();
      return;
    }
    try {
      const usage = await adapter.refresh(AbortSignal.timeout(Math.min(this.cadenceMs, 3_000)));
      this.health.set(provider, usage?.limits.length
        ? { state: "fresh", usage, updatedAt: Date.now() }
        : { state: "hidden", reason: "usage unavailable" });
    } catch (error) {
      this.health.set(provider, { state: "hidden", reason: sanitizedReason(provider, error) });
    } finally {
      this.running.delete(provider);
      this.onUpdate();
    }
  }
}
