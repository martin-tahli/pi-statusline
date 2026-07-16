import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderBar, type BarStyle } from "../src/bar.ts";
import {
  DEFAULT_CONFIG_PATH,
  formatSettings,
  loadSettings,
  saveSettings,
  toggleSetting,
  type Settings,
} from "../src/config.ts";
import { deriveContext, deriveEffort, deriveModel, deriveProject } from "../src/derive.ts";
import { formatRate, formatResetCountdown, formatTime } from "../src/format.ts";
import { gitBranchSymbol, gitStatusTokens, parseGitStatus, type GitStatusState, type GitTokenKind } from "../src/git.ts";
import { parseAnthropicUsage, parseCodexUsage, parseRateLimits, parseStoredRateLimits, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { composeSegments, createSegments } from "../src/segments.ts";
import { TurnMeter } from "../src/throughput.ts";

const GIT_ROLES: Record<GitTokenKind, "accent" | "success" | "warning" | "error"> = {
  staged: "success",
  modified: "warning",
  deleted: "error",
  dirty: "warning",
  ahead: "accent",
  behind: "warning",
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
  let lastRenderedTime = "";
  let sessionActive = false;
  let turnActive = false;

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
  };
  const syncTick = () => {
    const shouldTick = sessionActive && settings.footerEnabled
      && ((turnActive && settings.segments.time) || (settings.segments.session && hasUpcomingReset()));
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

  const isAnthropicOAuth = (ctx: ExtensionContext) =>
    ctx.model?.provider === "anthropic" && ctx.modelRegistry.authStorage.get("anthropic")?.type === "oauth";

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

  const refreshAnthropicLimits = async (ctx: ExtensionContext) => {
    if (!isAnthropicOAuth(ctx)) return;
    try {
      const access = await ctx.modelRegistry.authStorage.getApiKey("anthropic");
      if (!access) return;
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
      if (!response.ok || !isAnthropicOAuth(ctx)) return;
      const next = parseAnthropicUsage(await response.json());
      if (!next.length) return;
      limits = next;
      pi.appendEntry(ANTHROPIC_LIMITS_ENTRY, limits);
      syncTick();
      requestRender?.();
    } catch {
      // Best effort: unavailable account usage falls back to response headers.
    }
  };

  const refreshCodexLimits = async (ctx: ExtensionContext) => {
    if (ctx.model?.provider !== "openai-codex") return;
    try {
      const access = await ctx.modelRegistry.authStorage.getApiKey("openai-codex");
      const credential = ctx.modelRegistry.authStorage.get("openai-codex");
      const accountId = credential?.type === "oauth" ? credential.accountId : undefined;
      if (!access || typeof accountId !== "string") return;
      const origin = new URL(ctx.model.baseUrl).origin;
      const response = await fetch(`${origin}/backend-api/wham/usage`, {
        headers: {
          authorization: `Bearer ${access}`,
          "chatgpt-account-id": accountId,
          originator: "pi",
        },
        signal: AbortSignal.timeout(3_000),
      });
      if (!response.ok || ctx.model?.provider !== "openai-codex") return;
      limits = parseCodexUsage(await response.json());
      syncTick();
      requestRender?.();
    } catch {
      // Best effort: unavailable account usage simply stays hidden.
    }
  };

  const sessionCost = (ctx: ExtensionContext): number => {
    let total = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        total += (entry.message as AssistantMessage).usage.cost.total;
      }
    }
    return total;
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
          requestRender = undefined;
        },
        invalidate() {},
        render(width: number): string[] {
          const context = deriveContext(ctx.getContextUsage());
          const snapshot = meter.snapshot();
          const branch = settings.extras.branch ? footerData.getGitBranch() : undefined;
          const git = branch
            ? [
              theme.fg("accent", `${gitBranchSymbol(settings.extras.nerdFont)} ${branch}`),
              ...(gitStatus ? gitStatusTokens(gitStatus).map((token) => theme.fg(GIT_ROLES[token.kind], token.text)) : []),
            ].join(" ")
            : "";
          const pending = settings.extras.pending && ctx.hasPendingMessages();
          const model = deriveModel(ctx.model, footerData.getAvailableProviderCount() > 1);
          const cost = settings.extras.cost ? sessionCost(ctx) : undefined;
          const effort = deriveEffort(pi.getThinkingLevel(), ctx.model);
          const input = theme.fg(snapshot.inputLevel ?? "muted", `↑ ${formatRate(snapshot.inputRate ?? 0)} t/s`);
          const output = theme.fg(snapshot.outputLevel ?? "muted", `↓ ${formatRate(snapshot.outputRate ?? 0)} t/s`);
          const throughput = `${input} ${output}`;
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
          const provider = ctx.model?.provider;
          const session = limits.length
            ? limits.map(sessionBar).join(theme.fg("dim", " "))
            : provider === "anthropic" && ctx.modelRegistry.authStorage.get(provider)?.type === "oauth"
              ? theme.fg("muted", "5h — wk —")
              : "";

          const line = composeSegments(createSegments(settings.segments, {
            project: () => `${theme.fg("muted", `📁 ${deriveProject(ctx.cwd)}`)}${git ? `  ${git}` : ""}${pending ? ` ${theme.fg("muted", "queued")}` : ""}`,
            model: () => model ? theme.fg("muted", `🤖 ${model}${cost === undefined ? "" : ` $${cost.toFixed(3)}`}`) : "",
            effort: () => effort ? theme.fg("muted", `🧠 ${effort}`) : "",
            context: () => context
              ? `${theme.fg("muted", "🪟  ")}${theme.fg(context.percent >= 90 ? "error" : context.percent >= 75 ? "warning" : "dim", context.label)}`
              : "",
            session: () => session,
            throughput: () => `${theme.fg("muted", "⚡ ")}${throughput}`,
            time: () => time ? theme.fg("muted", time) : "",
          }), width, theme.fg("dim", " > "));
          return [line];
        },
      };
    });
    syncTick();
  };

  const persist = () => saveSettings(settings, DEFAULT_CONFIG_PATH);

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
        ctx.ui.notify(formatSettings(settings), "info");
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
    settings = loadSettings();
    meter = new TurnMeter();
    limits = isAnthropicOAuth(ctx) ? restoreAnthropicLimits(ctx) : [];
    gitStatus = undefined;
    if (settings.footerEnabled) installFooter(ctx);
    void refreshAnthropicLimits(ctx);
    void refreshCodexLimits(ctx);
    await refreshGit(ctx);
  });

  pi.on("session_shutdown", () => {
    sessionActive = false;
    turnActive = false;
    stopTick();
  });

  pi.on("turn_start", (event) => {
    turnActive = true;
    meter.startTurn(event.timestamp);
    syncTick();
    requestRender?.();
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") meter.markFirstUpdate();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("turn_end", async (event, ctx) => {
    turnActive = false;
    if (event.message.role === "assistant") {
      meter.finishTurn({ input: event.message.usage.input, output: event.message.usage.output });
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
    void refreshAnthropicLimits(ctx);
    void refreshCodexLimits(ctx);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
