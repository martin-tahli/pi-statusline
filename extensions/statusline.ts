import { dirname } from "node:path";
import { accountSources, accountWindows, credentialFingerprint, parseAccountSnapshot, readClaudePool, type AccountSnapshot } from "../src/accounts.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { billingMode, isLocalEndpoint } from "../src/derive.ts";
import { formatResetCountdown, formatTime } from "../src/format.ts";
import { parseGitStatus, type GitStatusState } from "../src/git.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { ProviderRefreshCoordinator, RateLimitedError, UsageUnavailableError, type ProviderAdapter } from "../src/providers.ts";
import { renderMainLine, renderProviderRows, providerHasRow, arrangeFooterLines, missingUsageLabel, usageFreshness, type ProviderRowSource } from "../src/render.ts";
import { estimateTokens, sumTextLength, TurnMeter } from "../src/throughput.ts";
import {
  DEFAULT_STATUSLINE_CONFIG_PATH,
  configuredProviders,
  loadRuntimeSettings,
  reconcileProviders,
} from "../src/settings/runtime.ts";
import type { ResolutionContext } from "../src/settings/resolve.ts";
import { saveStatuslineSettings } from "../src/settings/storage.ts";
import { createSettingsUi, renderSettingsWindow, resolveDirtyChoice, routeSettingsKey } from "../src/settings/ui.ts";
import type { ProviderUiContext } from "../src/settings/provider-ui.ts";
import { discoverProviders, type ModelRegistryLike } from "../src/settings/providers/discovery.ts";
import { deriveCapability, type ProviderCapability } from "../src/settings/providers/capabilities.ts";
import { resolveProviderRefreshPolicy, resolveProviderMissingDataPolicy, providerRefreshEnabled, type RefreshHealth } from "../src/settings/refresh.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";
import { getAdapter } from "../src/settings/providers/adapters.ts";
import { parseStatuslineSettings } from "../src/settings/validation.ts";
import { isTextInput } from "../src/settings/text.ts";
import { createProviderConfig } from "../src/settings/defaults.ts";

// Anthropic's OAuth usage endpoint (api.anthropic.com/api/oauth/usage) throttles hard and hands
// out sticky 429s, so poll it less often than the 10s cadence the other providers share.
const ANTHROPIC_REFRESH_MS = 180_000;

export default function statusline(
  pi: ExtensionAPI,
  providerUsageCache = new ProviderUsageCache(undefined, undefined, undefined, undefined, { anthropic: ANTHROPIC_REFRESH_MS }),
  settingsPath = DEFAULT_STATUSLINE_CONFIG_PATH,
) {
  let settings: StatuslineSettings = loadRuntimeSettings(settingsPath);
  let meter = new TurnMeter();
  let limits: RateLimits = [];
  let gitStatus: GitStatusState | undefined;
  const accountSnapshots = new Map<string, AccountSnapshot>();
  const credentialKeys = new Map<string, string>();
  let accountTick: ReturnType<typeof setInterval> | undefined;
  let readingAccounts = false;
  const eventAccountProviders = new Set<string>();
  let requestRender: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let gitTick: ReturnType<typeof setInterval> | undefined;
  let anthropicRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastContextChars = 0;
  let lastRenderedTime = "";
  let sessionActive = false;
  let sessionEpoch = 0;
  let turnActive = false;
  // Last git branch the footer rendered, captured so the settings preview can show the same HUD.
  let liveGitBranch: string | null | undefined;
  // True while the settings overlay is open; keeps commitSettings from flashing the live footer.
  let settingsOverlayOpen = false;
  let providerRefresh: ProviderRefreshCoordinator | undefined;
  let limitsUpdatedAt = 0;
  let limitsCached = false;
  const isCurrentSession = (epoch: number) => sessionActive && epoch === sessionEpoch;
  const ANTHROPIC_RETRY_DELAYS_MS = [1_500, 3_000];

  const timeLabel = () => {
    const snapshot = meter.snapshot();
    const liveMs = meter.liveElapsedMs();
    return snapshot.lastTurnMs === undefined && liveMs === 0
      ? ""
      : formatTime(
        snapshot.activeMs + liveMs,
        settings.extras.sessionElapsed ? snapshot.elapsedMs : undefined,
        settings.extras.lastTurn ? snapshot.lastTurnMs : undefined,
      );
  };
  const tickLabel = (time = timeLabel()) => `${time}|${limits.map((limit) =>
    limit.resetAt === undefined ? "" : formatResetCountdown(limit.resetAt)
  ).join("|")}`;
  const hasUpcomingReset = () => limits.some((limit) => limit.resetAt !== undefined && limit.resetAt > Date.now());
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = undefined;
    lastRenderedTime = "";
  };
  const startTick = () => {
    stopTick();
    lastRenderedTime = tickLabel();
    tick = setInterval(() => {
      const next = tickLabel();
      if (next !== lastRenderedTime || settings.providers.enabled) {
        lastRenderedTime = next;
        requestRender?.();
      }
      syncTick();
    }, 1_000);
    tick.unref?.();
  };
  const syncTick = () => {
    const shouldTick = sessionActive && settings.enabled
      && ((turnActive && (settings.segments.time || settings.segments.throughput))
        || (settings.segments.time && settings.extras.sessionElapsed)
        || (settings.segments.session && hasUpcomingReset()) || (settings.providers.enabled && settings.providers.order.length > 0));
    if (shouldTick && !tick) startTick();
    else if (!shouldTick && tick) stopTick();
  };

  const refreshGit = async (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    if (!settings.enabled || !settings.extras.branch) {
      gitStatus = undefined;
      return;
    }
    try {
      const result = await pi.exec("git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: ctx.cwd, timeout: 2_000 });
      if (!isCurrentSession(epoch)) return;
      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : "error";
    } catch {
      if (!isCurrentSession(epoch)) return;
      gitStatus = "error";
    }
    requestRender?.();
  };

  const stopGitTick = () => {
    if (gitTick) clearInterval(gitTick);
    gitTick = undefined;
  };
  const syncGitTick = (ctx: ExtensionContext, epoch = sessionEpoch) => {
    const shouldTick = isCurrentSession(epoch) && settings.enabled && settings.extras.branch;
    if (shouldTick && !gitTick) {
      gitTick = setInterval(() => void refreshGit(ctx, epoch), 10_000);
      gitTick.unref?.();
    } else if (!shouldTick) stopGitTick();
  };

  const stopAnthropicRetry = () => {
    if (anthropicRetryTimer) clearTimeout(anthropicRetryTimer);
    anthropicRetryTimer = undefined;
  };
  const scheduleAnthropicRetry = (ctx: ExtensionContext, attempt = 0, epoch = sessionEpoch) => {
    stopAnthropicRetry();
    if (!isCurrentSession(epoch) || attempt >= ANTHROPIC_RETRY_DELAYS_MS.length) return;
    anthropicRetryTimer = setTimeout(() => {
      anthropicRetryTimer = undefined;
      if (!isCurrentSession(epoch) || limits.length || !isAnthropicOAuth(ctx)) return;
      void refreshAnthropicLimits(ctx, epoch).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, attempt + 1, epoch); });
    }, ANTHROPIC_RETRY_DELAYS_MS[attempt]);
    anthropicRetryTimer.unref?.();
  };

  const isAnthropicOAuth = (ctx: ExtensionContext) =>
    ctx.model?.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(ctx.model);

  // The active model's provider, not necessarily configured/authenticated, is irrelevant here:
  // provider-tracking rows need usage for every *selected* provider, so resolve each provider's
  // own model from the registry instead of assuming it's the one currently in use.
  const findAvailableModel = (ctx: ExtensionContext, provider: string) =>
    ctx.modelRegistry.getAvailable?.().find((model) => model.provider === provider) ?? (ctx.model?.provider === provider ? ctx.model : undefined);

  // Anthropic's own login state, independent of the active model: undefined means "not logged in",
  // in which case subscription usage is unreachable — not even the last cached numbers.
  const anthropicOAuthModel = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> };
    if (!registry.getAvailable) return isAnthropicOAuth(ctx) ? ctx.model : undefined;
    const model = findAvailableModel(ctx, "anthropic");
    return model && ctx.modelRegistry.isUsingOAuth(model) ? model : undefined;
  };

  const codexAccountId = (token: string): string | undefined => {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
      return typeof id === "string" && id ? id : undefined;
    } catch {
      return undefined;
    }
  };

  const acceptAccounts = (snapshot: AccountSnapshot) => {
    accountSnapshots.set(snapshot.provider, snapshot);
    settings.providers.records[snapshot.provider] ??= createProviderConfig();
    if (!settings.providers.order.includes(snapshot.provider)) settings.providers.order.push(snapshot.provider);
  };

  const syncAccounts = async (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch) || !settings.enabled || readingAccounts || eventAccountProviders.has("anthropic")) return;
    readingAccounts = true;
    try {
      const pool = readClaudePool(dirname(settingsPath));
      if (!pool) { accountSnapshots.delete("anthropic"); return; }
      const visible = ctx.model?.provider === "anthropic" || (settings.providers.enabled && settings.providers.scope === "selected" && settings.providers.records.anthropic?.enabled !== false);
      const token = visible ? await ctx.modelRegistry.getApiKeyForProvider("anthropic").catch(() => undefined) : undefined;
      if (!isCurrentSession(epoch)) return;
      const snapshot = readClaudePool(dirname(settingsPath), token);
      if (snapshot) acceptAccounts(snapshot);
      else accountSnapshots.delete("anthropic");
      requestRender?.();
    } finally { readingAccounts = false; }
  };

  // Optional, credential-free interoperability. Addons own login, rotation and network polling.
  pi.events?.on("statusline:accounts", (value: unknown) => {
    const snapshot = parseAccountSnapshot(value);
    if (!snapshot) return;
    eventAccountProviders.add(snapshot.provider);
    acceptAccounts(snapshot);
    requestRender?.();
  });

  // Pure provider-scoped fetch: no side effects on the active session's `limits`/tick
  // state, so it's safe to call for a provider that isn't the currently active model. The
  // provider-tracking rows need every *selected* provider's usage simultaneously, not just
  // whichever one you happen to be talking to right now.
  const fetchAnthropicUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>, access: string): Promise<RateLimits> => {
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return [];
    try {
      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        headers: {
          authorization: `Bearer ${access}`,
          accept: "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "user-agent": "pi-statusline",
        },
        signal: AbortSignal.timeout(3_000),
      });
      // 429: surface to the provider-usage cache so every session and every caller backs off
      // instead of re-hammering the endpoint each refresh (Anthropic's retry-after: 0 is useless).
      if (response.status === 429) throw new RateLimitedError();
      if (response.status === 401 || response.status === 403) throw new UsageUnavailableError();
      if (!response.ok) return [];
      return parseAnthropicUsage(await response.json());
    } catch (error) {
      // Best effort: unavailable account usage falls back to response headers — but let the 429
      // signal through so the cache can apply its shared backoff.
      if (RateLimitedError.is(error) || UsageUnavailableError.is(error)) throw error;
      return [];
    }
  };

  const fetchZaiUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>, access: string): Promise<RateLimits> => {
    if (!model) return [];
    return getAdapter("zai").refresh?.({
      getToken: async () => access,
    }, AbortSignal.timeout(3_000)) ?? [];
  };

  const fetchCodexUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>, access: string): Promise<RateLimits> => {
    if (!model?.baseUrl) return [];
    try {
      const accountId = access ? codexAccountId(access) : undefined;
      if (!access || !accountId) return [];
      const origin = "https://chatgpt.com";
      const response = await fetch(`${origin}/backend-api/wham/usage`, {
        headers: {
          authorization: `Bearer ${access}`,
          "chatgpt-account-id": accountId,
          originator: "pi",
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 429) throw new RateLimitedError();
      if (response.status === 401 || response.status === 403) throw new UsageUnavailableError();
      if (!response.ok) return [];
      return parseCodexUsage(await response.json());
    } catch (error) {
      if (RateLimitedError.is(error) || UsageUnavailableError.is(error)) throw error;
      return [];
    }
  };

  const refreshProviderUsage = async (provider: string, ctx: ExtensionContext, fetchLimits: (access: string) => Promise<RateLimits>) => {
    if (accountSnapshots.has(provider)) return undefined;
    const epoch = sessionEpoch;
    const access = await ctx.modelRegistry.getApiKeyForProvider(provider);
    if (!isCurrentSession(epoch)) return undefined;
    if (!access) { credentialKeys.delete(provider); throw new UsageUnavailableError(); }
    const key = `${provider}:${credentialFingerprint(provider, access)}`;
    if (credentialKeys.get(provider) !== key) {
      credentialKeys.set(provider, key);
      providerRefresh?.clear(provider);
      if (ctx.model?.provider === provider) { limits = []; limitsUpdatedAt = 0; }
      requestRender?.();
    }
    const policy = resolveProviderRefreshPolicy(settings, provider);
    const usage = await providerUsageCache.refresh(key, async () => {
      const next = await fetchLimits(access);
      return next.length ? { limits: next } : undefined;
    }, { ...policy, intervalMs: Math.max(policy.intervalMs, provider === "anthropic" ? ANTHROPIC_REFRESH_MS : 0) });
    if (!isCurrentSession(epoch)) return undefined;
    if (credentialKeys.get(provider) !== key) throw new UsageUnavailableError();
    return usage;
  };

  const refreshEligible = (ctx: ExtensionContext, provider: string) => !accountSnapshots.has(provider) && providerRefreshEnabled(settings, provider, ctx.model?.provider === provider);
  const freshness = usageFreshness;

  // Active-session wrappers: only apply fetched usage to the shared `limits`/tick state
  // when the fetched provider is actually the active model, so a background provider-tracking
  // fetch for a different provider never clobbers what the session line shows.
  const refreshAnthropicLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || !isAnthropicOAuth(ctx) || !refreshEligible(ctx, "anthropic")) return [];
    const model = ctx.model;
    let denied = false;
    const usage = await refreshProviderUsage("anthropic", ctx, (access) => fetchAnthropicUsage(ctx, model, access)).catch((error) => { denied = UsageUnavailableError.is(error); return undefined; });
    const next = usage?.limits ?? [];
    if (!isCurrentSession(epoch) || ctx.model !== model) return [];
    if (!denied && (!next.length || (usage?.updatedAt ?? 0) < limitsUpdatedAt)) return [];
    limits = next;
    limitsUpdatedAt = usage?.updatedAt ?? Date.now();
    limitsCached = usage?.cached ?? false;
    syncTick();
    requestRender?.();
    return next;
  };

  const refreshCodexLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || ctx.model?.provider !== "openai-codex" || !refreshEligible(ctx, "openai-codex")) return [];
    const model = ctx.model;
    let denied = false;
    const usage = await refreshProviderUsage("openai-codex", ctx, (access) => fetchCodexUsage(ctx, model, access)).catch((error) => { denied = UsageUnavailableError.is(error); return undefined; });
    const next = usage?.limits ?? [];
    if (!isCurrentSession(epoch) || ctx.model !== model) return [];
    if (!denied && (!next.length || (usage?.updatedAt ?? 0) < limitsUpdatedAt)) return [];
    limits = next;
    limitsUpdatedAt = usage?.updatedAt ?? Date.now();
    limitsCached = usage?.cached ?? false;
    syncTick();
    requestRender?.();
    return next;
  };

  // Sum token usage across the session's assistant messages. "input" folds cached and
  // cache-write tokens into the prompt total; cost.total already reflects the cache discount.
  const sessionTotals = (ctx: ExtensionContext) => {
    let input = 0, output = 0, cost = 0, cacheRead = 0, cacheWrite = 0, available = false, costAvailable = true;
    const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      const usage = (entry.message as AssistantMessage).usage;
      if (!usage) { costAvailable = false; continue; }
      available = true;
      cacheRead += finite(usage.cacheRead);
      cacheWrite += finite(usage.cacheWrite);
      input += finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite);
      output += finite(usage.output);
      costAvailable &&= Number.isFinite(usage.cost?.total) && usage.cost.total >= 0;
      cost += finite(usage.cost?.total);
    }
    return available ? { input, output, cost: costAvailable ? cost : undefined, cacheRead, cacheWrite } : undefined;
  };

  const installFooter = (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      syncGitTick(ctx, epoch);
      syncTick();
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => {
        gitStatus = undefined;
        tui.requestRender();
        void refreshGit(ctx, epoch);
      });
      return {
        dispose() {
          unsubscribe();
          stopTick();
          stopGitTick();
          stopAnthropicRetry();
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const provider = ctx.model?.provider;
          const subscription = ctx.model !== undefined
            && (ctx.model.provider === "openai-codex" || ctx.modelRegistry.isUsingOAuth(ctx.model));
          const mode = billingMode(isLocalEndpoint(ctx.model?.baseUrl), subscription);
          // Walk the branch for totals only when something actually shows them (opt-in cost, or the
          // API token ledger while idle), not on every render tick.
          const needTotals = settings.extras.cost || mode === "api";
          const totals = needTotals ? sessionTotals(ctx) : undefined;
          const snapshot = meter.snapshot();
          // Provider-tracking rows share the settings-preview renderer (renderProviderRows) so the
          // multi-line footer and the in-app preview can never drift. Sources are built here from
          // live refresh health; per-window display (visible/bar/percent/reset/label/width) is read
          // from settings inside the shared renderer, keyed by each window's stable adapter key.
          const sources: ProviderRowSource[] = settings.providers.enabled ? settings.providers.order.flatMap<ProviderRowSource>((p) => {
            const record = settings.providers.records[p];
            if (!record?.enabled || (settings.providers.scope === "active" && p !== provider)) return [];
            const accounts = accountSnapshots.get(p);
            if (accounts) return accountSources(settings, accounts);
            const health = providerRefresh?.get(p);
            if (health?.state === "fresh") return [{ provider: p, windows: health.usage.limits, freshness: freshness(health.updatedAt, health.usage.cached ?? false) }];
            if (resolveProviderMissingDataPolicy(settings, p) === "hide") return [];
            // No windows: an OAuth login earns the loading placeholder; anything else (not
            // logged in, API key) has no access to subscription usage, so the row says "log in"
            // instead of going blank or showing stale numbers.
            if (p === "anthropic") {
              const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> };
              if (registry.getAvailable) {
                return [{ provider: p, windows: [], placeholder: missingUsageLabel(settings, p, anthropicOAuthModel(ctx) ? "usage unavailable" : "log in") }];
              }
            }
            return [{ provider: p, windows: [], placeholder: missingUsageLabel(settings, p, health?.reason) }];
          }) : [];
          const accounts = provider ? accountSnapshots.get(provider) : undefined;
          const activeAccount = accounts?.accounts.find((account) => account.active);
          const activeProviderHasRow = providerHasRow(settings, sources, provider);
          const sessionPlaceholder = !activeProviderHasRow && provider && (accounts || getAdapter(provider).support !== "none")
            && resolveProviderMissingDataPolicy(settings, provider) !== "hide"
            ? theme.fg("muted", missingUsageLabel(settings, provider)) : "";
          lastRenderedTime = tickLabel();
          const line = renderMainLine(settings, {
            cwd: ctx.cwd,
            model: ctx.model,
            thinkingLevel: pi.getThinkingLevel(),
            contextUsage: ctx.getContextUsage(),
            gitBranch: (liveGitBranch = footerData.getGitBranch()),
            gitStatus,
            pending: ctx.hasPendingMessages(),
            subscription,
            turnActive,
            meter: { ...snapshot, activeMs: snapshot.activeMs + meter.liveElapsedMs() },
            lastContextChars,
            totals,
            sessionWindows: accounts ? accountWindows(settings, provider!, activeAccount) : Date.now() - limitsUpdatedAt <= resolveProviderRefreshPolicy(settings, provider ?? "").maxAgeMs ? limits : [],
            sessionFreshness: accounts ? freshness(activeAccount?.updatedAt ?? 0, true) : freshness(limitsUpdatedAt, limitsCached),
            activeProviderHasRow,
            sessionPlaceholder,
          }, width, theme);
          const providerRowLines = renderProviderRows(settings, sources, theme, Date.now(), width);
          const statuses = settings.extras.extensionStatuses ? [...(footerData.getExtensionStatuses?.().values() ?? [])].join(" · ") : "";
          return [...arrangeFooterLines(settings, line, providerRowLines), ...(statuses ? [truncateToWidth(statuses, width, "")] : [])];
        },
      };
    });
    syncTick();
  };

  const availableProviders = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> } | undefined;
    return registry?.getAvailable ? configuredProviders(registry as { getAvailable(): Array<{ provider: string }> }) : [];
  };

  // One-shot discovery/capability snapshot for the settings app. Rendering never re-discovers or
  // refreshes: the snapshot freezes at open time, so reopening the command picks up new providers.
  const buildProviderContext = (ctx: ExtensionContext): ProviderUiContext => {
    const registry = ctx.modelRegistry as unknown as ModelRegistryLike & { getRegisteredProviderIds?: () => string[] };
    const descriptors = typeof registry?.getAvailable === "function"
      ? discoverProviders(registry, {
        activeProvider: ctx.model?.provider,
        storedProviders: settings.providers.order,
        storedRecords: settings.providers.records,
        registeredProviders: [...accountSnapshots.keys(), ...(typeof registry.getRegisteredProviderIds === "function" ? registry.getRegisteredProviderIds() : [])],
      })
      : [];
    const capabilities: Record<string, ProviderCapability> = {};
    const health: Record<string, RefreshHealth> = {};
    const windows: Record<string, RateLimitWindow[]> = {};
    for (const descriptor of descriptors) {
      const model = findAvailableModel(ctx, descriptor.id);
      let oauth = false;
      try { oauth = Boolean(model && ctx.modelRegistry.isUsingOAuth(model)); } catch { oauth = false; }
      capabilities[descriptor.id] = deriveCapability(descriptor, { oauth });
      const accounts = accountSnapshots.get(descriptor.id);
      if (accounts) {
        capabilities[descriptor.id] = { ...capabilities[descriptor.id], quotaSupport: "best-effort", quotaReliability: "medium" };
        const active = accounts.accounts.find((account) => account.active);
        windows[descriptor.id] = [...new Map(accounts.accounts.flatMap((account) => accountWindows(settings, descriptor.id, account)).map((window) => [window.key, window])).values()];
        health[descriptor.id] = { state: active && accountWindows(settings, descriptor.id, active).length ? "fresh" : "unknown", updatedAt: active?.updatedAt, cached: true };
        continue;
      }
      const snapshot = providerRefresh?.get(descriptor.id);
      if (snapshot?.state === "fresh") {
        health[descriptor.id] = { state: "fresh", updatedAt: snapshot.updatedAt, cached: snapshot.usage.cached };
        windows[descriptor.id] = snapshot.usage.limits;
      } else if (snapshot) {
        health[descriptor.id] = { state: snapshot.updatedAt ? "stale" : "unknown", reason: snapshot.reason, updatedAt: snapshot.updatedAt };
      }
    }
    return { descriptors, capabilities, health, windows, activeProvider: ctx.model?.provider, accounts: Object.fromEntries(accountSnapshots) };
  };

  // Raw terminal input -> the semantic key names routeSettingsKey understands.
  const ROUTE_KEYS: Record<string, string> = {
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    enter: "Enter", escape: "Escape", home: "Home", end: "End", space: " ", backspace: "Backspace",
    "ctrl+up": "Ctrl+Up", "ctrl+down": "Ctrl+Down", "ctrl+s": "Ctrl+S",
    pageup: "PageUp", pagedown: "PageDown",
  };
  const translateKey = (data: string): string | undefined => {
    const parsed = parseKey(data);
    if (parsed && parsed in ROUTE_KEYS) return ROUTE_KEYS[parsed];
    if (isTextInput(data)) return data; // Preserve case and Unicode graphemes.
    return parsed && [...parsed].length === 1 ? parsed : undefined;
  };

  // Persist the draft first (throws => nothing applied), then swap in-memory settings atomically and
  // reconfigure the live runtime once. Reconcile pulls in providers authenticated since load.
  const commitSettings = (draft: StatuslineSettings, ctx: ExtensionContext) => {
    const next = parseStatuslineSettings(availableProviders(ctx).length ? reconcileProviders(draft, ctx.modelRegistry) : draft).settings;
    saveStatuslineSettings(next, settingsPath);
    settings = next;
    providerRefresh?.start([...new Set([...availableProviders(ctx), ...settings.providers.order])]);
    // While the settings overlay is open the live footer is intentionally hidden (the in-app
    // preview stands in); skip re-installing it here so it doesn't flash behind the overlay.
    // The close handler restores it based on the final `settings.enabled`.
    if (!settingsOverlayOpen) {
      if (settings.enabled) installFooter(ctx);
      else ctx.ui.setFooter(undefined);
    }
    syncTick();
    syncGitTick(ctx);
    void refreshGit(ctx);
    requestRender?.();
  };

  const openSettingsApp = (ctx: ExtensionContext) => {
    const epoch = sessionEpoch;
    const previewCapability = () => ctx.model?.provider ? buildProviderContext(ctx).capabilities[ctx.model.provider] : undefined;
    // Live snapshot of the current session, fed to the in-app preview so it shows exactly what the
    // footer will look like under the DRAFT settings (cwd, model, context, quota, ticking clock).
    // Reads the draft (not the committed settings) so toggling extras like cost / session-elapsed /
    // last-turn is visible before saving — the preview is a live reflection of the draft.
    const currentPreviewContext = (draft: StatuslineSettings): ResolutionContext => {
      const snapshot = meter.snapshot();
      const accounts = accountSnapshots.get(ctx.model?.provider ?? "");
      const activeAccount = accounts?.accounts.find((account) => account.active);
      const subscription = ctx.model !== undefined
        && (ctx.model.provider === "openai-codex" || ctx.modelRegistry.isUsingOAuth(ctx.model));
      const mode = billingMode(isLocalEndpoint(ctx.model?.baseUrl), subscription);
      // Mirror the footer's own render inputs so the "current" preview is byte-identical to the
      // live main line under the draft settings (git HUD, ledger, quota, ticking clock, theme).
      const needTotals = draft.extras.cost || mode === "api";
      const totals = needTotals ? sessionTotals(ctx) : undefined;
      return {
        capability: previewCapability(),
        runtime: {
          cwd: ctx.cwd,
          model: ctx.model ? { id: ctx.model.id, provider: ctx.model.provider, reasoning: ctx.model.reasoning, baseUrl: ctx.model.baseUrl } : undefined,
          activeProvider: ctx.model?.provider,
          thinkingLevel: pi.getThinkingLevel(),
          contextUsage: ctx.getContextUsage() ?? undefined,
          throughput: { inputRate: snapshot.avgInputRate, outputRate: snapshot.avgOutputRate },
          meter: { ...snapshot, activeMs: snapshot.activeMs + meter.liveElapsedMs() },
          sessionFreshness: accounts ? freshness(activeAccount?.updatedAt ?? 0, true) : freshness(limitsUpdatedAt, limitsCached),
          sessionWindows: accounts ? accountWindows(draft, ctx.model?.provider ?? "", activeAccount) : Date.now() - limitsUpdatedAt <= resolveProviderRefreshPolicy(draft, ctx.model?.provider ?? "").maxAgeMs ? limits : [],
          activeMs: snapshot.activeMs + meter.liveElapsedMs(),
          elapsedMs: draft.extras.sessionElapsed ? snapshot.elapsedMs : undefined,
          lastTurnMs: draft.extras.lastTurn ? snapshot.lastTurnMs : undefined,
          gitBranch: liveGitBranch,
          gitStatus,
          pending: ctx.hasPendingMessages(),
          subscription,
          turnActive,
          lastContextChars,
          totals,
        },
      };
    };
    // The live footer would duplicate the preview's clock; hide it while settings are open so there
    // is exactly one statusline on screen — the interactive preview. Restored on close.
    const footerWasEnabled = settings.enabled;
    settingsOverlayOpen = true;
    if (footerWasEnabled) ctx.ui.setFooter(() => ({ render: () => [], invalidate() {} }));
    return ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let state = createSettingsUi(settings);
      let finished = false;
      let saving = false;
      // Re-render every second so the preview's clock ticks live (the footer's own tick is gone).
      const previewTick = setInterval(() => tui.requestRender(), 1_000);
      previewTick.unref?.();
      const finish = () => {
        if (finished) return;
        finished = true;
        clearInterval(previewTick);
        settingsOverlayOpen = false;
        if (settings.enabled) installFooter(ctx);
        else ctx.ui.setFooter(undefined);
        done();
      };
      return {
        invalidate() {},
        dispose() { clearInterval(previewTick); },
        render: (width: number) => {
          const rows = tui.terminal?.rows;
          return renderSettingsWindow(state, { width, providers: buildProviderContext(ctx), viewportRows: rows ? rows - 2 : undefined, current: currentPreviewContext(state.draft), theme });
        },
        handleInput(data: string) {
          const key = translateKey(data);
          if (!key || saving) return;
          if (state.confirmClose || key === "Ctrl+S") {
            const choice = key === "Ctrl+S" ? "save" : key === "s" || key === "S" ? "save"
              : key === "d" || key === "D" ? "discard"
              : key === "c" || key === "C" || key === "Escape" ? "cancel"
              : undefined;
            if (!choice) return;
            saving = true;
            void resolveDirtyChoice(state, choice, (draft) => commitSettings(draft, ctx)).then((result) => {
              saving = false;
              state = result.state;
              if (result.action === "close") finish();
              tui.requestRender();
            });
            return;
          }
          const result = routeSettingsKey(state, key, buildProviderContext(ctx));
          state = result.state;
          if (result.effect?.type === "refresh-provider") {
            if (accountSnapshots.has(result.effect.providerId)) {
              pi.events?.emit("statusline:accounts:request", { provider: result.effect.providerId });
              void syncAccounts(ctx);
            } else void providerRefresh?.refresh(result.effect.providerId);
          }
          if (result.action === "close") finish();
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "80%", anchor: "center", margin: 1 },
    }).finally(() => {
      if (!settingsOverlayOpen) return;
      settingsOverlayOpen = false;
      if (isCurrentSession(epoch)) {
        if (settings.enabled) installFooter(ctx);
        else ctx.ui.setFooter(undefined);
      }
    });
  };

  pi.registerCommand("statusline", {
    description: "Open the interactive statusline settings",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Statusline settings require the interactive terminal UI.", "info");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("/statusline takes no arguments \u2014 run it with no arguments to open settings.", "warning");
        return;
      }
      await openSettingsApp(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++sessionEpoch;
    sessionActive = true;
    turnActive = false;
    stopTick();
    stopGitTick();
    stopAnthropicRetry();
    providerRefresh?.stop();
    if (accountTick) clearInterval(accountTick);
    accountTick = undefined;
    if (ctx.mode && ctx.mode !== "tui") { sessionActive = false; return; }
    settings = loadRuntimeSettings(settingsPath);
    if (availableProviders(ctx).length) settings = reconcileProviders(settings, ctx.modelRegistry);
    meter = new TurnMeter();
    lastContextChars = 0;
    limitsUpdatedAt = 0;
    limitsCached = false;
    limits = [];
    credentialKeys.clear();
    await syncAccounts(ctx, epoch);
    if (!isCurrentSession(epoch)) return;
    for (const snapshot of accountSnapshots.values()) acceptAccounts(snapshot);
    if (accountTick) clearInterval(accountTick);
    accountTick = setInterval(() => void syncAccounts(ctx, epoch), 2_000);
    accountTick.unref?.();
    pi.events?.emit("statusline:accounts:request", {});
    gitStatus = undefined;
    const providers = availableProviders(ctx);
    // Saved providers may not be available in this process yet. Keep their last fresh cross-session
    // snapshot visible while a session that can authenticate them refreshes it.
    const trackedProviders = Array.from(new Set([...providers, ...settings.providers.order]));
    const adapters = new Map<string, ProviderAdapter>();
    {
      // Not logged in (no OAuth): skip the usage cache entirely — it would otherwise keep
      // re-serving last-known numbers as "fresh" on every poll, and the row shows "log in".
      adapters.set("anthropic", { refresh: async () => {
        const model = anthropicOAuthModel(ctx);
        if (!model) throw new UsageUnavailableError();
        return refreshProviderUsage("anthropic", ctx, (access) => fetchAnthropicUsage(ctx, model, access));
      } });
    }
    adapters.set("openai-codex", { refresh: () => refreshProviderUsage("openai-codex", ctx, (access) => fetchCodexUsage(ctx, findAvailableModel(ctx, "openai-codex"), access)) });
    adapters.set("zai", { refresh: () => refreshProviderUsage("zai", ctx, (access) => fetchZaiUsage(ctx, findAvailableModel(ctx, "zai"), access)) });
    adapters.set("openrouter", { refresh: () => refreshProviderUsage("openrouter", ctx, (access) => getAdapter("openrouter").refresh!({ getToken: async () => access }, AbortSignal.timeout(3_000))) });
    providerRefresh?.stop();
    providerRefresh = new ProviderRefreshCoordinator(adapters, (updatedProvider) => {
      if (!isCurrentSession(epoch)) return;
      if (updatedProvider !== ctx.model?.provider) { requestRender?.(); return; }
      const health = providerRefresh?.get(ctx.model?.provider ?? "");
      limits = health?.state === "fresh" ? health.usage.limits : [];
      limitsUpdatedAt = health?.state === "fresh" ? health.updatedAt : 0;
      limitsCached = health?.state === "fresh" && Boolean(health.usage.cached);
      syncTick();
      requestRender?.();
    }, undefined, undefined, (provider) => ({ ...resolveProviderRefreshPolicy(settings, provider), eligible: refreshEligible(ctx, provider) }));
    if (settings.enabled) installFooter(ctx, epoch);
    else ctx.ui.setFooter(undefined);
    providerRefresh.start(trackedProviders);
    if (!providers.includes(ctx.model?.provider ?? "")) {
      void refreshAnthropicLimits(ctx, epoch).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, 0, epoch); });
      void refreshCodexLimits(ctx, epoch);
    }
    syncGitTick(ctx, epoch);
    await refreshGit(ctx, epoch);
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    sessionEpoch++;
    if (accountTick) clearInterval(accountTick);
    accountTick = undefined;
    turnActive = false;
    stopTick();
    stopGitTick();
    stopAnthropicRetry();
    providerRefresh?.stop();
  });

  pi.on("turn_start", (event) => {
    turnActive = true;
    meter.startTurn(event.timestamp);
    syncTick();
    requestRender?.();
  });

  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const chars = sumTextLength(event.message.content);
    if (chars > 0) meter.markFirstUpdate();
    meter.updateOutputChars(chars);
    requestRender?.();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("context", (event) => {
    lastContextChars = sumTextLength(event.messages);
  });

  // The `context` event omits the system prompt and tools, which dominate first-prompt prefill;
  // the outgoing request payload is the full size the server actually has to process.
  pi.on("before_provider_request", (event) => {
    const chars = sumTextLength(event.payload);
    if (chars > 0) lastContextChars = chars;
  });

  pi.on("turn_end", async (event, ctx) => {
    turnActive = false;
    if (event.message.role === "assistant") {
      const { usage, content } = event.message;
      const inputEstimated = !Number.isFinite(usage?.input) || !(usage?.input > 0);
      const outputEstimated = !Number.isFinite(usage?.output) || !(usage?.output > 0);
      const input = inputEstimated ? estimateTokens(lastContextChars) : usage.input;
      const output = outputEstimated ? estimateTokens(sumTextLength(content)) : usage.output;
      meter.finishTurn({ input, output, inputEstimated, outputEstimated });
    }
    syncTick();
    void refreshCodexLimits(ctx);
    await refreshGit(ctx);
    requestRender?.();
  });

  pi.on("agent_settled", () => {
    turnActive = false;
    meter.finalizeActiveTurn();
    syncTick();
    requestRender?.();
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (accountSnapshots.has(ctx.model?.provider ?? "")) return;
    const next = parseRateLimits(event.headers);
    if (!next.length) return;
    limits = next;
    limitsUpdatedAt = Date.now();
    limitsCached = false;
    if (ctx.model?.provider) providerRefresh?.prime(ctx.model.provider, { limits, updatedAt: limitsUpdatedAt }, limitsUpdatedAt);
    syncTick();
    requestRender?.();
  });

  pi.on("model_select", (_event, ctx) => {
    if (availableProviders(ctx).length) settings = reconcileProviders(settings, ctx.modelRegistry);
    providerRefresh?.start([...new Set([...availableProviders(ctx), ...settings.providers.order])]);
    limitsUpdatedAt = 0;
    limitsCached = false;
    limits = [];
    void syncAccounts(ctx);
    meter.resetThroughput();
    syncTick();
    requestRender?.();
    stopAnthropicRetry();
    void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx); });
    void refreshCodexLimits(ctx);
    if (ctx.model?.provider) void providerRefresh?.refresh(ctx.model.provider);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
