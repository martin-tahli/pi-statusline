import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { parseStoredRateLimits } from "./ratelimit.ts";
import { PROVIDER_MAX_AGE_MS, PROVIDER_REFRESH_MS, RateLimitedError, UsageUnavailableError, type ProviderUsage } from "./providers.ts";

export const PROVIDER_CACHE_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "statusline", "provider-usage");
const LOCK_MS = 10_000;
// When a provider's usage endpoint returns 429, back off with a growing delay shared across
// every session and every caller (persisted in the cache file). Anthropic's usage endpoint sends
// retry-after: 0, which is useless, so we use our own schedule instead. Capped at the last step.
const BACKOFF_STEPS_MS = [60_000, 120_000, 300_000];

interface CachedUsage extends ProviderUsage {
  updatedAt: number;
  /** Epoch ms; while now() < retryAt the cache skips fetching (active 429 backoff). */
  retryAt?: number;
  /** Next index into BACKOFF_STEPS_MS; bumped on each consecutive 429, cleared on success. */
  backoffStep?: number;
}

export class ProviderUsageCache {
  private readonly dir: string;
  private readonly refreshMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;
  private readonly refreshMsOverrides: Record<string, number>;

  constructor(
    dir = PROVIDER_CACHE_DIR,
    refreshMs = PROVIDER_REFRESH_MS,
    lockMs = LOCK_MS,
    now = () => Date.now(),
    refreshMsOverrides: Record<string, number> = {},
  ) {
    this.dir = dir;
    this.refreshMs = refreshMs;
    this.lockMs = lockMs;
    this.now = now;
    this.refreshMsOverrides = refreshMsOverrides;
  }

  private refreshMsFor(provider: string): number {
    return this.refreshMsOverrides[provider] ?? this.refreshMs;
  }

  get(provider: string): CachedUsage | undefined {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(readFileSync(this.file(provider), "utf8")) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const limits = parseStoredRateLimits(value.limits);
    const updatedAt = value.updatedAt;
    const retryAt = typeof value.retryAt === "number" && Number.isFinite(value.retryAt) ? value.retryAt : undefined;
    const backoffStep = typeof value.backoffStep === "number" && Number.isInteger(value.backoffStep) && value.backoffStep >= 0 ? value.backoffStep : undefined;
    const usageValid = limits.length && typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0 && updatedAt <= this.now();
    // Keep an entry while it has usable usage, or while a 429 backoff is still cooling down.
    if (!usageValid && retryAt === undefined) return undefined;
    const extras = { ...(retryAt === undefined ? {} : { retryAt }), ...(backoffStep === undefined ? {} : { backoffStep }) };
    return usageValid
      ? { limits, updatedAt: updatedAt as number, ...extras }
      : { limits: [], updatedAt: 0, ...extras };
  }

  getFresh(provider: string, maxAge = PROVIDER_MAX_AGE_MS): CachedUsage | undefined {
    const cached = this.get(provider);
    return cached && cached.limits.length && this.now() - cached.updatedAt <= maxAge ? cached : undefined;
  }

  async refresh(provider: string, fetchUsage: () => Promise<ProviderUsage | undefined>, policy?: { intervalMs: number; maxAgeMs: number; useCache: boolean; keepAfterFailure: boolean }): Promise<ProviderUsage | undefined> {
    const refreshMs = Math.max(this.refreshMsFor(provider), policy?.intervalMs ?? 0);
    const fallback = (entry: CachedUsage | undefined): ProviderUsage | undefined =>
      policy?.useCache !== false && policy?.keepAfterFailure !== false && entry?.limits.length
        && this.now() - entry.updatedAt <= (policy?.maxAgeMs ?? PROVIDER_MAX_AGE_MS)
        ? { limits: entry.limits, updatedAt: entry.updatedAt, cached: true } : undefined;
    const fetchFresh = async () => {
      const usage = await fetchUsage();
      return usage?.limits.length ? { ...usage, updatedAt: this.now(), cached: false } : undefined;
    };
    const before = this.get(provider);
    // Honor an active 429 backoff: don't hit the endpoint again until it expires.
    if (before?.retryAt !== undefined && this.now() < before.retryAt) {
      return fallback(before);
    }
    if (policy?.useCache !== false && before?.limits.length && this.now() - before.updatedAt < Math.min(refreshMs, policy?.maxAgeMs ?? PROVIDER_MAX_AGE_MS)) {
      return { limits: before.limits, updatedAt: before.updatedAt, cached: true };
    }
    try { mkdirSync(this.dir, { recursive: true }); } catch { return fetchFresh(); }
    let release: () => void;
    try {
      release = lockSync(this.file(provider), { realpath: false, stale: Math.max(this.lockMs, 5_000), retries: 0 });
    } catch {
      return fallback(before);
    }
    try {
      const current = this.get(provider);
      if (current?.retryAt !== undefined && this.now() < current.retryAt) {
        return fallback(current);
      }
      if (policy?.useCache !== false && current?.limits.length && this.now() - current.updatedAt < Math.min(refreshMs, policy?.maxAgeMs ?? PROVIDER_MAX_AGE_MS)) {
        return { limits: current.limits, updatedAt: current.updatedAt, cached: true };
      }
      // Reserve the next attempt even when the endpoint returns no usable data. Otherwise
      // missing/failed usage bypasses the interval and every process retries immediately.
      this.save(provider, { limits: current?.limits ?? [], updatedAt: current?.updatedAt ?? 0,
        retryAt: this.now() + refreshMs, ...(current?.backoffStep === undefined ? {} : { backoffStep: current.backoffStep }) });
      try {
        const usage = await fetchFresh();
        if (usage?.limits.length) {
          // Success: store fresh usage and clear any backoff.
          this.save(provider, { limits: usage.limits, updatedAt: this.now() });
          return usage;
        }
        return fallback(current);
      } catch (error) {
        if (UsageUnavailableError.is(error)) {
          // A denied account must not keep re-serving last-known quota across sessions.
          this.save(provider, { limits: [], updatedAt: this.now(), retryAt: this.now() + refreshMs });
          throw error;
        }
        if (RateLimitedError.is(error)) {
          // 429: persist a growing backoff so every session and every caller backs off.
          this.applyBackoff(provider, current, refreshMs);
        } else if (!current?.limits.length) {
          throw error;
        }
        return fallback(current);
      }
    } finally {
      try { release(); } catch { /* The lock may already have been recovered after a crash. */ }
    }
  }

  private applyBackoff(provider: string, current: CachedUsage | undefined, minimumMs: number): void {
    const step = current?.backoffStep ?? 0;
    const delay = Math.max(minimumMs, BACKOFF_STEPS_MS[Math.min(step, BACKOFF_STEPS_MS.length - 1)]);
    const hasUsage = current?.limits.length;
    this.save(provider, {
      limits: hasUsage ? current!.limits : [],
      updatedAt: hasUsage ? current!.updatedAt : 0,
      retryAt: this.now() + delay,
      backoffStep: step + 1,
    });
  }

  private file(provider: string) {
    return join(this.dir, `${Buffer.from(provider).toString("base64url")}.json`);
  }

  private save(provider: string, record: CachedUsage): void {
    const file = this.file(provider);
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
      renameSync(temporary, file);
    } catch { /* Read-only/full cache storage must not hide successfully fetched usage. */
    } finally {
      try { unlinkSync(temporary); } catch { /* The atomic rename already won. */ }
    }
  }
}
