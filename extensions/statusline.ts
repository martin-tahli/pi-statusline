import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseKey, truncateToWidth } from "@earendil-works/pi-tui";
import { renderBar, type BarStyle } from "../src/bar.ts";
import { billingMode, contextSeverity, deriveContext, deriveEffort, deriveModel, deriveProject, isLocalEndpoint } from "../src/derive.ts";
import { formatRate, formatResetCountdown, formatTime, formatWindow } from "../src/format.ts";
import { gitBranchSymbol, gitStatusTokens, parseGitStatus, type GitStatusState, type GitTokenKind } from "../src/git.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, parseZaiUsage, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { ProviderUsageCache } from "../src/provider-cache.ts";
import { ProviderRefreshCoordinator, type ProviderAdapter } from "../src/providers.ts";
import { composeSegments, createSegments } from "../src/segments.ts";
import { estimateTokens, sumTextLength, TurnMeter } from "../src/throughput.ts";
import {
  DEFAULT_STATUSLINE_CONFIG_PATH,
  configuredProviders,
  loadRuntimeSettings,
  reconcileProviders,
} from "../src/settings/runtime.ts";
import { saveStatuslineSettings } from "../src/settings/storage.ts";
import { createSettingsUi, renderSettingsWindow, resolveDirtyChoice, routeSettingsKey } from "../src/settings/ui.ts";
import type { ProviderUiContext } from "../src/settings/provider-ui.ts";
import { discoverProviders, type ModelRegistryLike } from "../src/settings/providers/discovery.ts";
import { deriveCapability, type ProviderCapability } from "../src/settings/providers/capabilities.ts";
import type { RefreshHealth } from "../src/settings/refresh.ts";
import type { StatuslineSettings } from "../src/settings/schema.ts";

const GIT_ROLES: Record<GitTokenKind, "accent" | "success" | "warning" | "error"> = {
  ahead: "accent",
  behind: "warning",
  dirty: "warning",
  clean: "success",
  error: "error",
};

export default function statusline(pi: ExtensionAPI, providerUsageCache = new ProviderUsageCache(), settingsPath = DEFAULT_STATUSLINE_CONFIG_PATH) {
  let settings: StatuslineSettings = loadRuntimeSettings(settingsPath);
  let meter = new TurnMeter();
  let limits: RateLimits = [];
  let gitStatus: GitStatusState | undefined;
  const ANTHROPIC_LIMITS_ENTRY = "pi-statusline:anthropic-limits";
  let requestRender: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let gitTick: ReturnType<typeof setInterval> | undefined;
  let anthropicRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let lastContextChars = 0;
  let lastRenderedTime = "";
  let sessionActive = false;
  let sessionEpoch = 0;
  let turnActive = false;
  let providerRefresh: ProviderRefreshCoordinator | undefined;
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
      if (next !== lastRenderedTime) {
        lastRenderedTime = next;
        requestRender?.();
      }
      if (!turnActive && !hasUpcomingReset()) stopTick();
    }, 1_000);
    tick.unref?.();
  };
  const syncTick = () => {
    const shouldTick = sessionActive && settings.enabled
      && ((turnActive && (settings.segments.time || settings.segments.throughput)) || (settings.segments.session && hasUpcomingReset()));
    if (shouldTick && !tick) startTick();
    else if (!shouldTick && tick) stopTick();
  };

  const refreshGit = async (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    if (!settings.extras.branch) {
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
    ctx.modelRegistry.getAvailable().find((model) => model.provider === provider);

  const codexAccountId = (token: string): string | undefined => {
    try {
      const payload = JSON.parse(atob(token.split(".")[1] ?? ""));
      return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch {
      return undefined;
    }
  };

  const restoreAnthropicLimits = (ctx: ExtensionContext): RateLimits => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry?.type === "custom" && entry.customType === ANTHROPIC_LIMITS_ENTRY) {
        return parseStoredRateLimits(entry.data);
      }
    }
    return [];
  };

  // Pure provider-scoped fetch: no side effects on the active session's `limits`/tick/persisted
  // entry, so it's safe to call for a provider that isn't the currently active model. The
  // provider-tracking rows need every *selected* provider's usage simultaneously, not just
  // whichever one you happen to be talking to right now.
  const fetchAnthropicUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>): Promise<RateLimits> => {
    if (!model || !ctx.modelRegistry.isUsingOAuth(model)) return [];
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
      if (!access) return [];
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
      if (!response.ok) return [];
      return parseAnthropicUsage(await response.json());
    } catch {
      // Best effort: unavailable account usage falls back to response headers.
      return [];
    }
  };

  // Undocumented by Z.AI (see src/ratelimit.ts parseZaiUsage), used anyway at the user's request.
  const fetchZaiUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>): Promise<RateLimits> => {
    if (!model) return [];
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("zai");
      if (!access) return [];
      const response = await fetch("https://api.z.ai/api/monitor/usage/quota/limit", {
        headers: { authorization: `Bearer ${access}`, accept: "application/json", "user-agent": "pi-statusline" },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return [];
      return parseZaiUsage(await response.json());
    } catch {
      return [];
    }
  };

  const fetchCodexUsage = async (ctx: ExtensionContext, model: ReturnType<typeof findAvailableModel>): Promise<RateLimits> => {
    if (!model?.baseUrl) return [];
    try {
      const access = await ctx.modelRegistry.getApiKeyForProvider("openai-codex");
      const accountId = access ? codexAccountId(access) : undefined;
      if (!access || !accountId) return [];
      const origin = new URL(model.baseUrl).origin;
      const response = await fetch(`${origin}/backend-api/wham/usage`, {
        headers: {
          authorization: `Bearer ${access}`,
          "chatgpt-account-id": accountId,
          originator: "pi",
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok) return [];
      return parseCodexUsage(await response.json());
    } catch {
      return [];
    }
  };

  const refreshProviderUsage = (provider: string, fetchLimits: () => Promise<RateLimits>) =>
    providerUsageCache.refresh(provider, async () => {
      const next = await fetchLimits();
      return next.length ? { limits: next } : undefined;
    });

  // Active-session wrappers: only apply fetched usage to the shared `limits`/tick/persisted entry
  // when the fetched provider is actually the active model, so a background provider-tracking
  // fetch for a different provider never clobbers what the session line shows.
  const refreshAnthropicLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || !isAnthropicOAuth(ctx)) return [];
    const usage = await refreshProviderUsage("anthropic", () => fetchAnthropicUsage(ctx, ctx.model));
    const next = usage?.limits ?? [];
    if (!next.length || !isCurrentSession(epoch) || !isAnthropicOAuth(ctx)) return [];
    limits = next;
    pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
    syncTick();
    requestRender?.();
    return next;
  };

  const refreshCodexLimits = async (ctx: ExtensionContext, epoch = sessionEpoch): Promise<RateLimits> => {
    if (!isCurrentSession(epoch) || ctx.model?.provider !== "openai-codex") return [];
    const usage = await refreshProviderUsage("openai-codex", () => fetchCodexUsage(ctx, ctx.model));
    const next = usage?.limits ?? [];
    if (!next.length || !isCurrentSession(epoch) || ctx.model?.provider !== "openai-codex") return [];
    limits = next;
    syncTick();
    requestRender?.();
    return next;
  };

  // Sum token usage across the session's assistant messages. "input" folds cached and
  // cache-write tokens into the prompt total; cost.total already reflects the cache discount.
  const sessionTotals = (ctx: ExtensionContext): { input: number; output: number; cost: number } => {
    let input = 0, output = 0, cost = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const usage = (entry.message as AssistantMessage).usage;
        input += usage.input + usage.cacheRead + usage.cacheWrite;
        output += usage.output;
        cost += usage.cost.total;
      }
    }
    return { input, output, cost };
  };

  const installFooter = (ctx: ExtensionContext, epoch = sessionEpoch) => {
    if (!isCurrentSession(epoch)) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
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
          const context = deriveContext(ctx.getContextUsage());
          const snapshot = meter.snapshot();
          const branch = settings.extras.branch ? footerData.getGitBranch() : undefined;
          const branchSymbol = gitBranchSymbol(settings.icons.style === "nerdfont");
          const git = branch
            ? [
              theme.fg("accent", `${branchSymbol ? `${branchSymbol} ` : ""}${branch}`),
              ...(gitStatus ? gitStatusTokens(gitStatus).map((token) => theme.fg(GIT_ROLES[token.kind], token.text)) : []),
            ].join(" ")
            : "";
          const pending = settings.extras.pending && ctx.hasPendingMessages();
          const model = deriveModel(ctx.model);
          const effort = deriveEffort(pi.getThinkingLevel(), ctx.model);
          const localModel = isLocalEndpoint(ctx.model?.baseUrl);
          const subscription = ctx.model !== undefined
            && (ctx.model.provider === "openai-codex" || ctx.modelRegistry.isUsingOAuth(ctx.model));
          const mode = billingMode(localModel, subscription);
          // Walk the branch for totals only when something actually shows them (opt-in cost, or the
          // API token ledger while idle), not on every render tick.
          const needTotals = settings.extras.cost || (mode === "api" && !turnActive);
          const totals = needTotals ? sessionTotals(ctx) : undefined;
          const cost = settings.extras.cost ? totals!.cost : undefined;
          const liveOutputRate = turnActive && snapshot.outputRate !== undefined ? snapshot.outputRate : undefined;
          const outputRateLabel = () => theme.fg(snapshot.outputLevel ?? "muted", `↓${formatRate(liveOutputRate ?? snapshot.avgOutputRate ?? 0)}`);
          // The ⚡ segment adapts to the billing model:
          //  local        → live ↑/↓ token rates (the rate is the real, measurable point)
          //  hosted+turn  → live ↓ speed pulse ("is it working, how fast") for API and subscription
          //  subscription → idle: nothing; the 5h/wk quota bars are the real budget meter
          //  api          → idle: 🧾 running token totals + session cost (what you're spending)
          const throughput = (() => {
            if (mode === "local") {
              // While the prompt is still ingesting, estimate ↑ from the known prompt size; once a
              // turn settles, fall back to the rolling average rather than freezing on one number.
              const promptRate = snapshot.waitingMs ? estimateTokens(lastContextChars) / (snapshot.waitingMs / 1_000) : undefined;
              const inputRate = promptRate ?? snapshot.avgInputRate ?? 0;
              const input = theme.fg(snapshot.inputLevel ?? "muted", `↑${formatRate(inputRate)}`);
              return `${theme.fg("muted", "⚡")}${input} ${outputRateLabel()}${theme.fg("muted", " t/s")}`;
            }
            if (turnActive) return `${theme.fg("muted", "⚡")}${outputRateLabel()}${theme.fg("muted", " t/s")}`;
            if (mode === "subscription") return "";
            if (!totals || (!totals.input && !totals.output)) return "";
            return theme.fg("muted", `🧾 ↑${formatWindow(totals.input)} ↓${formatWindow(totals.output)} $${totals.cost.toFixed(3)}`);
          })();
          const time = timeLabel();
          lastRenderedTime = tickLabel(time);
          const truecolor = theme.getColorMode() === "truecolor";
          const barStyle = (used: number): BarStyle => ({
            fill: truecolor
              ? (text, [r, g, b]) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
              : (text) => theme.fg(used >= 0.8 ? "error" : used >= 0.6 ? "warning" : "success", text),
            track: truecolor
              ? (text) => `\x1b[38;2;58;63;70m${text}\x1b[39m`
              : (text) => theme.fg("dim", text),
          });
          const sessionBar = (limit: RateLimitWindow) => {
            const reset = limit.resetAt === undefined
              ? ""
              : theme.fg("dim", ` ↻ ${formatResetCountdown(limit.resetAt)}`);
            return `${theme.fg("muted", `${limit.label} `)}${renderBar(limit.used, 12, barStyle(limit.used))}${reset}`;
          };
          const providerSettings = settings.providers;
          const providerRows = !providerSettings.enabled ? [] : providerSettings.order.flatMap((provider) => {
            const record = providerSettings.records[provider];
            if (!record?.enabled) return [];
            const health = providerRefresh?.get(provider);
            const window = record.windows["default"];
            const showBar = window?.showBar ?? true;
            const showPercent = window?.showPercent ?? true;
            const showReset = window?.showReset ?? true;
            if (health?.state !== "fresh") {
              const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> };
              const model = provider === "anthropic" && registry.getAvailable ? findAvailableModel(ctx, provider) : undefined;
              return provider === "anthropic" && model && ctx.modelRegistry.isUsingOAuth(model) && (showBar || showReset)
                ? [{ provider, line: theme.fg("muted", "anthropic 5h — wk —") }]
                : [];
            }
            const windows = health.usage.limits.flatMap((limit) => {
              const usage = showBar ? renderBar(limit.used, 12, barStyle(limit.used), undefined, showPercent) : "";
              const reset = showReset && limit.resetAt !== undefined
                ? theme.fg("dim", ` ↻ ${formatResetCountdown(limit.resetAt)}`)
                : "";
              return usage || reset ? [`${theme.fg("muted", `${limit.label} `)}${usage}${reset}`] : [];
            });
            return windows.length ? [{ provider, line: `${theme.fg("muted", `${provider} `)}${windows.join(theme.fg("dim", " >"))}` }] : [];
          });
          const activeProviderHasRow = providerRows.some((row) => row.provider === ctx.model?.provider);
          const provider = ctx.model?.provider;
          const session = activeProviderHasRow ? "" : limits.length
            ? limits.map(sessionBar).join(theme.fg("dim", " >"))
            : provider === "anthropic" && ctx.model !== undefined && ctx.modelRegistry.isUsingOAuth(ctx.model)
              ? theme.fg("muted", "5h — wk —")
              : "";

          const line = composeSegments(createSegments(settings.segments, {
            project: () => `${theme.fg("muted", `📁 ${deriveProject(ctx.cwd)}`)}${git ? `${theme.fg("dim", " > ")}${git}` : ""}${pending ? ` ${theme.fg("muted", "queued")}` : ""}`,
            model: () => model ? theme.fg("muted", `🤖 ${model}${cost === undefined ? "" : ` $${cost.toFixed(3)}`}`) : "",
            effort: () => effort ? theme.fg("muted", `🧠 ${effort}`) : "",
            context: () => context
              ? `${theme.fg("muted", "🪟  ")}${theme.fg(contextSeverity(context), context.label)}`
              : "",
            session: () => session,
            throughput: () => throughput,
            time: () => time ? theme.fg("muted", time) : "",
          }), width, theme.fg("dim", " >"));
          return [line, ...providerRows.map((row) => truncateToWidth(row.line, width, ""))];
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
        registeredProviders: typeof registry.getRegisteredProviderIds === "function" ? registry.getRegisteredProviderIds() : undefined,
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
      const snapshot = providerRefresh?.get(descriptor.id);
      if (snapshot?.state === "fresh") {
        health[descriptor.id] = { state: "fresh" };
        windows[descriptor.id] = snapshot.usage.limits;
      } else if (snapshot) {
        health[descriptor.id] = { state: "unknown" };
      }
    }
    return { descriptors, capabilities, health, windows, activeProvider: ctx.model?.provider };
  };

  // Raw terminal input -> the semantic key names routeSettingsKey understands.
  const ROUTE_KEYS: Record<string, string> = {
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    enter: "Enter", escape: "Escape", home: "Home", end: "End", space: " ", backspace: "Backspace",
    "ctrl+up": "Ctrl+Up", "ctrl+down": "Ctrl+Down",
  };
  const translateKey = (data: string): string | undefined => {
    const parsed = parseKey(data);
    if (!parsed) return undefined;
    if (parsed in ROUTE_KEYS) return ROUTE_KEYS[parsed];
    return parsed.length === 1 ? parsed : undefined; // printable char, else ignore
  };

  // Persist the draft first (throws => nothing applied), then swap in-memory settings atomically and
  // reconfigure the live runtime once. Reconcile pulls in providers authenticated since load.
  const commitSettings = (draft: StatuslineSettings, ctx: ExtensionContext) => {
    const next = availableProviders(ctx).length ? reconcileProviders(draft, ctx.modelRegistry) : draft;
    saveStatuslineSettings(next, settingsPath);
    settings = next;
    if (settings.enabled) installFooter(ctx);
    else ctx.ui.setFooter(undefined);
    syncTick();
    syncGitTick(ctx);
    void refreshGit(ctx);
    requestRender?.();
  };

  const openSettingsApp = (ctx: ExtensionContext) => {
    const providers = buildProviderContext(ctx);
    return ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
      let state = createSettingsUi(settings);
      let finished = false;
      const finish = () => { if (!finished) { finished = true; done(); } };
      return {
        invalidate() {},
        render: (width: number) => {
          const rows = tui.terminal?.rows;
          return renderSettingsWindow(state, { width, providers, viewportRows: rows ? rows - 2 : undefined });
        },
        handleInput(data: string) {
          const key = translateKey(data);
          if (!key) return;
          if (state.confirmClose) {
            const choice = key === "s" || key === "S" ? "save"
              : key === "d" || key === "D" ? "discard"
              : key === "c" || key === "C" || key === "Escape" ? "cancel"
              : undefined;
            if (!choice) return;
            void resolveDirtyChoice(state, choice, (draft) => commitSettings(draft, ctx)).then((result) => {
              state = result.state;
              if (result.action === "close") finish();
              tui.requestRender();
            });
            return;
          }
          const result = routeSettingsKey(state, key, providers);
          state = result.state;
          if (result.effect?.type === "refresh-provider") void providerRefresh?.refresh(result.effect.providerId);
          if (result.action === "close") finish();
          tui.requestRender();
        },
      };
    }, {
      overlay: true,
      overlayOptions: { width: "80%", anchor: "center", margin: 1 },
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
    stopAnthropicRetry();
    settings = loadRuntimeSettings(settingsPath);
    if (availableProviders(ctx).length) settings = reconcileProviders(settings, ctx.modelRegistry);
    meter = new TurnMeter();
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    if (!limits.length) limits = providerUsageCache.getFresh(ctx.model?.provider ?? "")?.limits ?? [];
    gitStatus = undefined;
    const providers = availableProviders(ctx);
    // Saved providers may not be available in this process yet. Keep their last fresh cross-session
    // snapshot visible while a session that can authenticate them refreshes it.
    const trackedProviders = Array.from(new Set([...providers, ...settings.providers.order]));
    const adapters = new Map<string, ProviderAdapter>();
    if (providers.includes("anthropic")) adapters.set("anthropic", { refresh: () => refreshProviderUsage("anthropic", () => fetchAnthropicUsage(ctx, findAvailableModel(ctx, "anthropic"))) });
    if (providers.includes("openai-codex")) adapters.set("openai-codex", { refresh: () => refreshProviderUsage("openai-codex", () => fetchCodexUsage(ctx, findAvailableModel(ctx, "openai-codex"))) });
    if (providers.includes("zai")) adapters.set("zai", { refresh: () => refreshProviderUsage("zai", () => fetchZaiUsage(ctx, findAvailableModel(ctx, "zai"))) });
    providerRefresh?.stop();
    providerRefresh = new ProviderRefreshCoordinator(adapters, () => {
      if (!isCurrentSession(epoch)) return;
      const health = providerRefresh?.get(ctx.model?.provider ?? "");
      if (health?.state === "fresh") {
        limits = health.usage.limits;
        syncTick();
      }
      requestRender?.();
    });
    for (const provider of trackedProviders) {
      const cached = providerUsageCache.getFresh(provider);
      if (cached) providerRefresh.prime(provider, cached, cached.updatedAt);
    }
    if (settings.enabled) installFooter(ctx, epoch);
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
    meter.markFirstUpdate();
    meter.updateOutputChars(sumTextLength(event.message.content));
    requestRender?.();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("context", (event) => {
    lastContextChars = sumTextLength(event.messages);
  });

  pi.on("turn_end", async (event, ctx) => {
    turnActive = false;
    if (event.message.role === "assistant") {
      const { usage, content } = event.message;
      const input = usage.input || estimateTokens(lastContextChars);
      const output = usage.output || estimateTokens(sumTextLength(content));
      meter.finishTurn({ input, output });
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
    const next = parseRateLimits(event.headers);
    if (!next.length) return;
    limits = next;
    if (isAnthropicOAuth(ctx)) pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
    syncTick();
    requestRender?.();
  });

  pi.on("model_select", (_event, ctx) => {
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    meter.resetThroughput();
    syncTick();
    requestRender?.();
    stopAnthropicRetry();
    void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx); });
    void refreshCodexLimits(ctx);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
