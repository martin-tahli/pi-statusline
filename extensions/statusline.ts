import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getSettingsListTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, truncateToWidth } from "@earendil-works/pi-tui";
import { renderBar, type BarStyle } from "../src/bar.ts";
import {
  DEFAULT_CONFIG_PATH,
  configuredProviders,
  formatSettings,
  loadSettings,
  reconcileProviderTracking,
  saveSettings,
  toggleSetting,
  type Settings,
} from "../src/config.ts";
import { billingMode, contextSeverity, deriveContext, deriveEffort, deriveModel, deriveProject, isLocalEndpoint } from "../src/derive.ts";
import { formatRate, formatResetCountdown, formatTime, formatWindow } from "../src/format.ts";
import { gitBranchSymbol, gitStatusTokens, parseGitStatus, type GitStatusState, type GitTokenKind } from "../src/git.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { ProviderRefreshCoordinator, type ProviderAdapter } from "../src/providers.ts";
import { composeSegments, createSegments } from "../src/segments.ts";
import { estimateTokens, sumTextLength, TurnMeter } from "../src/throughput.ts";

const GIT_ROLES: Record<GitTokenKind, "accent" | "success" | "warning" | "error"> = {
  ahead: "accent",
  behind: "warning",
  dirty: "warning",
  clean: "success",
  error: "error",
};

export default function statusline(pi: ExtensionAPI) {
  let settings = loadSettings();
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
  let turnActive = false;
  let providerRefresh: ProviderRefreshCoordinator | undefined;
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
    const shouldTick = sessionActive && settings.footerEnabled
      && ((turnActive && (settings.segments.time || settings.segments.throughput)) || (settings.segments.session && hasUpcomingReset()));
    if (shouldTick && !tick) startTick();
    else if (!shouldTick && tick) stopTick();
  };

  const refreshGit = async (ctx: ExtensionContext) => {
    if (!settings.extras.branch) {
      gitStatus = undefined;
      return;
    }
    try {
      const result = await pi.exec("git", ["status", "--porcelain=v2", "--branch", "-z"], { cwd: ctx.cwd, timeout: 2_000 });
      gitStatus = result.code === 0 ? parseGitStatus(result.stdout) : "error";
    } catch {
      gitStatus = "error";
    }
    requestRender?.();
  };

  const stopGitTick = () => {
    if (gitTick) clearInterval(gitTick);
    gitTick = undefined;
  };
  const syncGitTick = (ctx: ExtensionContext) => {
    const shouldTick = sessionActive && settings.footerEnabled && settings.extras.branch;
    if (shouldTick && !gitTick) {
      gitTick = setInterval(() => void refreshGit(ctx), 10_000);
      gitTick.unref?.();
    } else if (!shouldTick) stopGitTick();
  };

  const stopAnthropicRetry = () => {
    if (anthropicRetryTimer) clearTimeout(anthropicRetryTimer);
    anthropicRetryTimer = undefined;
  };
  const scheduleAnthropicRetry = (ctx: ExtensionContext, attempt = 0) => {
    stopAnthropicRetry();
    if (attempt >= ANTHROPIC_RETRY_DELAYS_MS.length) return;
    anthropicRetryTimer = setTimeout(() => {
      anthropicRetryTimer = undefined;
      if (!sessionActive || limits.length || !isAnthropicOAuth(ctx)) return;
      void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx, attempt + 1); });
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

  // Active-session wrappers: only apply fetched usage to the shared `limits`/tick/persisted entry
  // when the fetched provider is actually the active model, so a background provider-tracking
  // fetch for a different provider never clobbers what the session line shows.
  const refreshAnthropicLimits = async (ctx: ExtensionContext): Promise<RateLimits> => {
    if (!isAnthropicOAuth(ctx)) return [];
    const next = await fetchAnthropicUsage(ctx, ctx.model);
    if (!next.length || !isAnthropicOAuth(ctx)) return [];
    limits = next;
    pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
    syncTick();
    requestRender?.();
    return next;
  };

  const refreshCodexLimits = async (ctx: ExtensionContext): Promise<RateLimits> => {
    if (ctx.model?.provider !== "openai-codex") return [];
    const next = await fetchCodexUsage(ctx, ctx.model);
    if (ctx.model?.provider !== "openai-codex") return [];
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

  const installFooter = (ctx: ExtensionContext) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(() => {
        gitStatus = undefined;
        tui.requestRender();
        void refreshGit(ctx);
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
          const branchSymbol = gitBranchSymbol(settings.extras.nerdFont);
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
          const tracking = settings.providerTracking;
          const providerRows = !tracking.enabled ? [] : tracking.order.flatMap((provider) => {
            if (!tracking.selected[provider]) return [];
            const health = providerRefresh?.get(provider);
            if (health?.state !== "fresh") return [];
            const metrics = { ...tracking.metrics, ...tracking.overrides[provider] };
            const windows = health.usage.limits.flatMap((limit) => {
              const usage = metrics.usage ? renderBar(limit.used, 12, barStyle(limit.used)) : "";
              const reset = metrics.reset && limit.resetAt !== undefined
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

  const persist = () => saveSettings(settings, DEFAULT_CONFIG_PATH);
  const availableProviders = (ctx: ExtensionContext) => {
    const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider: string }> } | undefined;
    return registry?.getAvailable ? configuredProviders(registry as { getAvailable(): Array<{ provider: string }> }) : [];
  };

  const openProviderMenu = async (ctx: ExtensionContext) => {
    const providers = availableProviders(ctx);
    const base = providers.length ? reconcileProviderTracking(settings, ctx.modelRegistry) : settings;
    // Deep clone so cancel or a failing save leaves the live `settings` object untouched.
    const draft: Settings = { ...base, providerTracking: structuredClone(base.providerTracking) };
    let accepted = false;
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const tracking = draft.providerTracking;
      const items: SettingItem[] = [
        { id: "enabled", label: "Provider stack", currentValue: tracking.enabled ? "on" : "off", values: ["on", "off"] },
        { id: "usage", label: "Shared usage", currentValue: tracking.metrics.usage ? "on" : "off", values: ["on", "off"] },
        { id: "reset", label: "Shared reset", currentValue: tracking.metrics.reset ? "on" : "off", values: ["on", "off"] },
        ...providers.flatMap((provider) => {
          const override = tracking.overrides[provider] ?? {};
          const health = providerRefresh?.get(provider);
          return [
            { id: `selected:${provider}`, label: provider, description: health?.state === "hidden" ? health.reason : "usage is fresh", currentValue: tracking.selected[provider] ? "selected" : "hidden", values: ["selected", "hidden"] },
            { id: `usage:${provider}`, label: `${provider} usage`, currentValue: override.usage === undefined ? "inherit" : override.usage ? "on" : "off", values: ["inherit", "on", "off"] },
            { id: `reset:${provider}`, label: `${provider} reset`, currentValue: override.reset === undefined ? "inherit" : override.reset ? "on" : "off", values: ["inherit", "on", "off"] },
            { id: `order:${provider}`, label: `${provider} order`, currentValue: String(tracking.order.indexOf(provider) + 1), values: ["move up", "move down"] },
          ];
        }),
        { id: "save", label: "Confirm", currentValue: "save changes", values: ["save changes"] },
      ];
      const list = new SettingsList(items, 14, getSettingsListTheme(), (id, value) => {
        if (id === "save") { accepted = true; done(undefined); return; }
        if (id === "enabled") tracking.enabled = value === "on";
        else if (id === "usage" || id === "reset") tracking.metrics[id] = value === "on";
        else {
          const [kind, provider] = id.split(":");
          if (!provider) return;
          if (kind === "selected") tracking.selected[provider] = value === "selected";
          if (kind === "order") {
            const index = tracking.order.indexOf(provider), target = value === "move up" ? index - 1 : index + 1;
            if (index >= 0 && target >= 0 && target < tracking.order.length) [tracking.order[index], tracking.order[target]] = [tracking.order[target]!, tracking.order[index]!];
          }
          if (kind === "usage" || kind === "reset") {
            const next = { ...(tracking.overrides[provider] ?? {}) };
            if (value === "inherit") delete next[kind]; else next[kind] = value === "on";
            if (Object.keys(next).length) tracking.overrides[provider] = next; else delete tracking.overrides[provider];
          }
        }
      }, () => done(undefined));
      const container = new Container();
      container.addChild({ render: () => [theme.fg("accent", theme.bold("Provider tracking")), ""], invalidate() {} });
      container.addChild(list);
      return { render: (width) => container.render(width), invalidate: () => container.invalidate(), handleInput: (data) => { list.handleInput?.(data); tui.requestRender(); } };
    });
    if (!accepted) return;
    try { saveSettings(draft, DEFAULT_CONFIG_PATH); settings = draft; ctx.ui.notify("Provider tracking saved", "info"); requestRender?.(); }
    catch { ctx.ui.notify("Could not save provider tracking", "error"); }
  };

  pi.registerCommand("statusline", {
    description: "List or toggle statusline segments",
    getArgumentCompletions: (prefix) => {
      const choices = ["on", "off", "toggle project", "toggle model", "toggle effort", "toggle context", "toggle session", "toggle throughput", "toggle time", "toggle branch", "toggle nerdFont", "toggle cost", "toggle sessionElapsed", "toggle lastTurn", "toggle pending"];
      const matches = choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const [action, rawName] = args.trim().split(/\s+/);
      if (!action) {
        await openProviderMenu(ctx);
        return;
      }
      if (action === "on" || action === "off") {
        settings = { ...settings, footerEnabled: action === "on" };
        persist();
        if (settings.footerEnabled) installFooter(ctx);
        else ctx.ui.setFooter(undefined);
        ctx.ui.notify(settings.footerEnabled ? "Statusline enabled" : "Default footer restored", "info");
        return;
      }
      if (action !== "toggle" || !rawName) {
        ctx.ui.notify("Usage: /statusline [on|off|toggle <segment>]", "warning");
        return;
      }
      const aliases: Record<string, string> = { "session-bars": "session", elapsed: "sessionElapsed", "last-turn": "lastTurn" };
      try {
        settings = toggleSetting(settings, aliases[rawName] ?? rawName);
        persist();
        syncTick();
        syncGitTick(ctx);
        await refreshGit(ctx);
        requestRender?.();
        ctx.ui.notify(formatSettings(settings), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionActive = true;
    turnActive = false;
    stopTick();
    stopAnthropicRetry();
    settings = loadSettings();
    if (availableProviders(ctx).length) settings = reconcileProviderTracking(settings, ctx.modelRegistry);
    meter = new TurnMeter();
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    gitStatus = undefined;
    if (settings.footerEnabled) installFooter(ctx);
    void refreshAnthropicLimits(ctx).then((next) => { if (!next.length) scheduleAnthropicRetry(ctx); });
    void refreshCodexLimits(ctx);
    const providers = availableProviders(ctx);
    const adapters = new Map<string, ProviderAdapter>();
    const scoped = async (fetchLimits: () => Promise<RateLimits>) => {
      const next = await fetchLimits();
      return next.length ? { limits: next } : undefined;
    };
    if (providers.includes("anthropic")) adapters.set("anthropic", { refresh: () => scoped(() => fetchAnthropicUsage(ctx, findAvailableModel(ctx, "anthropic"))) });
    if (providers.includes("openai-codex")) adapters.set("openai-codex", { refresh: () => scoped(() => fetchCodexUsage(ctx, findAvailableModel(ctx, "openai-codex"))) });
    providerRefresh?.stop();
    providerRefresh = new ProviderRefreshCoordinator(adapters, () => requestRender?.());
    providerRefresh.start(providers);
    syncGitTick(ctx);
    await refreshGit(ctx);
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
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
