import type { RateLimits } from "../../ratelimit.ts";
import { parseAnthropicUsage, parseCodexUsage, parseZaiUsage } from "../../ratelimit.ts";

/**
 * Adapter support tiers (R14). Only this module maps provider ids to quota
 * behaviour; every other module derives capability structurally so the UI never
 * branches on a provider name.
 */
export type AdapterSupport = "official" | "best-effort" | "none";

/** Credentials/endpoint context handed to an adapter's refresh function. */
export interface AdapterContext {
  /** Resolved bearer token for the provider, if any. Never logged. */
  getToken?: () => Promise<string | undefined>;
  /** Active model for the provider (for endpoint origin / OAuth check), if any. */
  baseUrl?: string;
  /** ChatGPT account id derived from a Codex token, if applicable. */
  accountId?: string;
}

/** A registered quota adapter. `reason` is required when support is "none". */
export interface QuotaAdapter {
  id: string;
  support: AdapterSupport;
  /** Sanitized, UI-safe reason shown when quota is unavailable (no secrets). */
  reason?: string;
  /** Best-effort quota refresh; returns [] when unavailable. Never throws raw data. */
  refresh?: (ctx: AdapterContext, signal: AbortSignal) => Promise<RateLimits>;
}

const anthropicAdapter: QuotaAdapter = {
  id: "anthropic",
  support: "official",
  reason: "usage requires an authenticated Anthropic subscription (OAuth)",
  // Anthropic OAuth usage endpoint; parser validates shape and returns [] on anything unexpected.
  refresh: async (ctx, signal) => {
    const token = ctx.getToken ? await ctx.getToken().catch(() => undefined) : undefined;
    if (!token) return [];
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "pi-statusline",
        },
        signal,
      });
      if (!response.ok) return [];
      return parseAnthropicUsage(await response.json());
    } catch {
      return [];
    }
  },
};

const codexAdapter: QuotaAdapter = {
  id: "openai-codex",
  support: "official",
  reason: "usage requires a Codex (ChatGPT) account",
  refresh: async (ctx, signal) => {
    if (!ctx.baseUrl || !ctx.accountId) return [];
    const token = ctx.getToken ? await ctx.getToken().catch(() => undefined) : undefined;
    if (!token) return [];
    try {
      const origin = new URL(ctx.baseUrl).origin;
      const response = await fetch(`${origin}/backend-api/wham/usage`, {
        headers: {
          authorization: `Bearer ${token}`,
          "chatgpt-account-id": ctx.accountId,
          originator: "pi",
        },
        signal,
      });
      if (!response.ok) return [];
      return parseCodexUsage(await response.json());
    } catch {
      return [];
    }
  },
};

const zaiAdapter: QuotaAdapter = {
  // Undocumented Z.AI endpoint (see src/ratelimit.ts parseZaiUsage); best-effort by design.
  id: "zai",
  support: "best-effort",
  reason: "usage is best-effort for Z.AI",
  refresh: async (ctx, signal) => {
    const token = ctx.getToken ? await ctx.getToken().catch(() => undefined) : undefined;
    if (!token) return [];
    try {
      const response = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
        headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "pi-statusline" },
        signal,
      });
      if (!response.ok) return [];
      return parseZaiUsage(await response.json());
    } catch {
      return [];
    }
  },
};

const openrouterAdapter: QuotaAdapter = {
  id: "openrouter",
  support: "none",
  // OpenRouter's only usage endpoint requires a separate management key pi doesn't manage
  // (the inference key pi stores is explicitly rejected by that endpoint).
  reason: "usage requires an OpenRouter management key pi doesn't manage",
};

/**
 * The single source of truth for which provider ids have quota adapters.
 * UI/capability code reads this via getAdapter(); it must never hardcode these ids.
 */
export const QUOTA_ADAPTERS: Readonly<Record<string, QuotaAdapter>> = Object.freeze({
  anthropic: anthropicAdapter,
  "openai-codex": codexAdapter,
  zai: zaiAdapter,
  openrouter: openrouterAdapter,
});

/** Known adapter provider ids, derived from the registry (never inline the list elsewhere). */
export const KNOWN_ADAPTER_PROVIDER_IDS: readonly string[] = Object.keys(QUOTA_ADAPTERS);

/** Look up the adapter for a provider id; unsupported providers return support "none". */
export function getAdapter(providerId: string): QuotaAdapter {
  return (
    QUOTA_ADAPTERS[providerId] ?? {
      id: providerId,
      support: "none",
      reason: "usage unavailable",
    }
  );
}

/** Sanitized, UI-safe reason for why a provider's quota is unavailable. */
export function sanitizedUnavailableReason(providerId: string, error?: unknown): string {
  const adapter = getAdapter(providerId);
  if (adapter.support === "none") return adapter.reason ?? "usage unavailable";
  if (error instanceof DOMException && error.name === "TimeoutError") return "usage refresh timed out";
  return "usage unavailable";
}
