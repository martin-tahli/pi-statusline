import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { lockSync } from "proper-lockfile";
import { parseStoredRateLimits } from "./ratelimit.ts";
import { PROVIDER_MAX_AGE_MS, PROVIDER_REFRESH_MS, type ProviderUsage } from "./providers.ts";

export const PROVIDER_CACHE_DIR = join(homedir(), ".pi", "agent", "statusline", "provider-usage");
const LOCK_MS = 10_000;

interface CachedUsage extends ProviderUsage {
  updatedAt: number;
}

export class ProviderUsageCache {
  private readonly dir: string;
  private readonly refreshMs: number;
  private readonly lockMs: number;
  private readonly now: () => number;

  constructor(
    dir = PROVIDER_CACHE_DIR,
    refreshMs = PROVIDER_REFRESH_MS,
    lockMs = LOCK_MS,
    now = () => Date.now(),
  ) {
    this.dir = dir;
    this.refreshMs = refreshMs;
    this.lockMs = lockMs;
    this.now = now;
  }

  get(provider: string): CachedUsage | undefined {
    try {
      const value = JSON.parse(readFileSync(this.file(provider), "utf8")) as Record<string, unknown>;
      const limits = parseStoredRateLimits(value.limits);
      const updatedAt = value.updatedAt;
      return limits.length && typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt <= this.now()
        ? { limits, updatedAt }
        : undefined;
    } catch {
      return undefined;
    }
  }

  getFresh(provider: string, maxAge = PROVIDER_MAX_AGE_MS): CachedUsage | undefined {
    const cached = this.get(provider);
    return cached && this.now() - cached.updatedAt <= maxAge ? cached : undefined;
  }

  async refresh(provider: string, fetchUsage: () => Promise<ProviderUsage | undefined>): Promise<ProviderUsage | undefined> {
    const cached = this.get(provider);
    if (cached && this.now() - cached.updatedAt < this.refreshMs) return cached;
    mkdirSync(this.dir, { recursive: true });
    let release: () => void;
    try {
      release = lockSync(this.file(provider), { realpath: false, stale: Math.max(this.lockMs, 5_000), retries: 0 });
    } catch {
      return undefined;
    }
    try {
      const current = this.get(provider);
      if (current && this.now() - current.updatedAt < this.refreshMs) return current;
      const usage = await fetchUsage();
      if (usage?.limits.length) this.save(provider, usage);
      return usage;
    } finally {
      try { release(); } catch { /* The lock may already have been recovered after a crash. */ }
    }
  }

  private file(provider: string) {
    return join(this.dir, `${Buffer.from(provider).toString("base64url")}.json`);
  }

  private save(provider: string, usage: ProviderUsage): void {
    const file = this.file(provider);
    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ ...usage, updatedAt: this.now() })}\n`, "utf8");
      renameSync(temporary, file);
    } finally {
      try { unlinkSync(temporary); } catch { /* The atomic rename already won. */ }
    }
  }
}
