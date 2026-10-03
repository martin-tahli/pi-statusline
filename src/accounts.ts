import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStoredRateLimits, type RateLimits } from "./ratelimit.ts";
import { sanitizeDisplayString } from "./settings/validation.ts";
import type { StatuslineSettings } from "./settings/schema.ts";
import { resolveProviderRefreshPolicy } from "./settings/refresh.ts";
import { missingUsageLabel, usageFreshness, type ProviderRowSource } from "./render.ts";

/** Credential-free account snapshots that authentication addons may publish on pi.events. */
export interface AccountUsage {
  id: string;
  label: string;
  active: boolean;
  windows: RateLimits;
  updatedAt: number;
  unavailable?: string;
}
export interface AccountSnapshot {
  provider: string;
  source: string;
  accounts: AccountUsage[];
}

export function credentialFingerprint(provider: string, credential: string): string {
  return createHash("sha256").update(JSON.stringify([provider, credential])).digest("hex");
}

function object(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}
function safeId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && sanitizeDisplayString(value) === value
    && !["__proto__", "constructor", "prototype"].includes(value) ? value : undefined;
}

/** Reject ambiguous IDs/active identities, never accept secrets or arbitrary provider error text. */
export function parseAccountSnapshot(value: unknown, now = Date.now()): AccountSnapshot | undefined {
  const input = object(value);
  const provider = safeId(input?.provider);
  if (!provider || !Array.isArray(input?.accounts) || input.accounts.length > 100) return undefined;
  const ids = new Set<string>();
  const accounts: AccountUsage[] = [];
  for (const raw of input.accounts) {
    const account = object(raw), id = safeId(account?.id);
    if (!account || !id || ids.has(id)) return undefined;
    ids.add(id);
    const updatedAt = typeof account.updatedAt === "number" && Number.isFinite(account.updatedAt) && account.updatedAt > 0 && account.updatedAt <= now ? account.updatedAt : 0;
    accounts.push({ id, label: sanitizeDisplayString(account.label) || id, active: account.active === true,
      windows: updatedAt && !account.unavailable ? parseStoredRateLimits(account.windows) : [], updatedAt,
      ...(account.unavailable ? { unavailable: "usage unavailable" } : {}) });
  }
  if (accounts.filter((account) => account.active).length > 1) return undefined;
  return { provider, source: sanitizeDisplayString(input.source) || "Account addon", accounts };
}

export function accountWindows(settings: StatuslineSettings, provider: string, account?: AccountUsage, now = Date.now()): RateLimits {
  return account && !account.unavailable && now >= account.updatedAt && now - account.updatedAt <= resolveProviderRefreshPolicy(settings, provider).maxAgeMs ? account.windows : [];
}

export function accountSources(settings: StatuslineSettings, snapshot: AccountSnapshot, now = Date.now()): ProviderRowSource[] {
  return snapshot.accounts.flatMap((account) => {
    const config = settings.providers.records[snapshot.provider]?.accounts?.[account.id];
    if (config?.enabled === false || (settings.providers.accountScope !== "selected" && !account.active)) return [];
    const windows = accountWindows(settings, snapshot.provider, account, now);
    const label = `${snapshot.provider} / ${config?.label || account.label}${account.active ? " *" : ""}`;
    return [{ provider: snapshot.provider, label, active: account.active, windows,
      freshness: usageFreshness(account.updatedAt, true, now),
      ...(!windows.length ? { placeholder: missingUsageLabel(settings, snapshot.provider) } : {}) }];
  });
}

function readObject(path: string): Record<string, any> | undefined {
  try { return object(JSON.parse(readFileSync(path, "utf8"))); } catch { return undefined; }
}

/**
 * Read-only bridge for DrunkenDonkey80/pi-provider-claude-ex (Claude Plus).
 * Never imports addon code, refreshes tokens, writes its files, or calls an endpoint.
 * UUID + org UUID identifies the subscription; access fingerprints are a conservative fallback.
 * Active identity is matched to Pi's actual credential, NOT guessed from the pool's pin/ranking.
 */
export function readClaudePool(agentDir: string, activeToken?: string, now = Date.now()): AccountSnapshot | undefined {
  if (process.env.PI_CLAUDE_PROVIDER_POOL_DISABLE === "1") return undefined;
  const store = readObject(join(agentDir, "claude-pool.json"));
  if (!store || store.enabled === false || !Array.isArray(store.accounts) || !store.accounts.length) return undefined;
  const usage = readObject(join(agentDir, "claude-pool-usage.json")) ?? {};
  const stash = readObject(join(agentDir, "claude-pool.stash.json")) ?? {};
  const accounts: AccountUsage[] = [];
  for (const raw of store.accounts) {
    const account = object(raw);
    if (!account || typeof account.label !== "string") continue;
    const pending = Object.hasOwn(stash, account.label) ? object(stash[account.label]) : undefined;
    const successor = typeof pending?.access === "string" && pending.access && typeof pending.refresh === "string" && pending.refresh !== account.refresh ? pending : undefined;
    const access = successor?.access ?? account.access;
    const identity = typeof account.uuid === "string" && typeof account.orgUuid === "string" && account.uuid && account.orgUuid
      ? JSON.stringify([account.uuid, account.orgUuid]) : typeof access === "string" && access ? access : undefined;
    if (!identity) continue;
    const id = credentialFingerprint("anthropic", identity);
    const cached = Object.hasOwn(usage, account.label) ? object(usage[account.label]) : undefined;
    const updatedAt = typeof cached?.at === "number" && Number.isFinite(cached.at) && cached.at > 0 && cached.at <= now ? cached.at : 0;
    const denied = (account.dead && !successor) || cached?.error === "http-401" || cached?.error === "http-403" || cached?.error === "no-access-token";
    const windows: RateLimits = [];
    const add = (key: string, label: string, value: unknown) => {
      const win = object(value);
      if (typeof win?.pct !== "number" || !Number.isFinite(win.pct) || win.pct < 0 || win.pct > 100) return;
      const resetAt = typeof win.resets_at === "string" ? Date.parse(win.resets_at) : NaN;
      windows.push({ key, label, used: win.pct / 100, ...(Number.isFinite(resetAt) && resetAt > 0 ? { resetAt } : {}) });
    };
    if (updatedAt && !denied) {
      add("five-hour", "5h", cached?.five_hour);
      add("seven-day", "wk", cached?.seven_day);
      if (Array.isArray(cached?.scoped)) for (const model of cached.scoped) {
        if (typeof model?.name === "string") add(`model:${model.name}`, `${sanitizeDisplayString(model.name)} wk`, model);
      }
    }
    const next: AccountUsage = { id, label: sanitizeDisplayString(account.label) || "Account", active: Boolean(activeToken && access === activeToken),
      windows, updatedAt, ...(denied ? { unavailable: "usage unavailable" } : {}) };
    const index = accounts.findIndex((entry) => entry.id === id);
    if (index < 0) accounts.push(next);
    else {
      // Aliases do not create extra quota; keep the latest sample and preserve actual active identity.
      const previous = accounts[index];
      accounts[index] = { ...(next.updatedAt > previous.updatedAt ? next : previous), active: previous.active || next.active };
    }
  }
  return parseAccountSnapshot({ provider: "anthropic", source: "Claude pool cache", accounts }, now);
}
