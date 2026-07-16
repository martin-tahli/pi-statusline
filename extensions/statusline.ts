import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_STOPS, renderBar, type BarStyle, type Rgb } from "../src/bar.ts";
import {
  DEFAULT_CONFIG_PATH,
  formatSettings,
  loadSettings,
  saveSettings,
  toggleSetting,
  type Settings,
} from "../src/config.ts";
import { deriveContext, deriveEffort, deriveModel, deriveProject } from "../src/derive.ts";
import { formatRate, formatTime } from "../src/format.ts";
import { parseCodexUsage, parseRateLimits, type RateLimits, type RateLimitWindow } from "../src/ratelimit.ts";
import { composeSegments, createSegments } from "../src/segments.ts";
import { TurnMeter } from "../src/throughput.ts";

export default function statusline(pi: ExtensionAPI) {
  let settings = loadSettings();
  let meter = new TurnMeter();
  let limits: RateLimits = [];
  let dirty = false;
  let requestRender: (() => void) | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let lastRenderedTime = "";

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
  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = undefined;
    lastRenderedTime = "";
  };
  const startTick = () => {
    stopTick();
    lastRenderedTime = timeLabel();
    tick = setInterval(() => {
      const next = timeLabel();
      if (next !== lastRenderedTime) {
        lastRenderedTime = next;
        requestRender?.();
      }
    }, 1_000);
  };

  const refreshDirty = async (ctx: ExtensionContext) => {
    if (!settings.extras.branch) return;
    try {
      const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 2_000 });
      dirty = result.code === 0 && result.stdout.trim().length > 0;
    } catch {
      dirty = false;
    }
    requestRender?.();
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
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
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
          const projectSuffix = [
            branch ? `(${branch}${dirty ? "*" : ""})` : "",
            settings.extras.pending && ctx.hasPendingMessages() ? "queued" : "",
          ].filter(Boolean).join(" ");
          const project = `${deriveProject(ctx.cwd)}${projectSuffix ? ` ${projectSuffix}` : ""}`;
          const model = deriveModel(ctx.model, footerData.getAvailableProviderCount() > 1);
          const cost = settings.extras.cost ? sessionCost(ctx) : undefined;
          const effort = deriveEffort(pi.getThinkingLevel(), ctx.model);
          const input = theme.fg(snapshot.inputLevel ?? "muted", `↑ ${formatRate(snapshot.inputRate ?? 0)} t/s`);
          const output = theme.fg(snapshot.outputLevel ?? "muted", `↓ ${formatRate(snapshot.outputRate ?? 0)} t/s`);
          const throughput = `${input} ${output}`;
          const time = timeLabel();
          lastRenderedTime = time;
          const rgbOf = (ansi: string): Rgb | undefined => {
            const m = /38;2;(\d+);(\d+);(\d+)/.exec(ansi);
            return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
          };
          const truecolor = theme.getColorMode() === "truecolor";
          const themeStops = (truecolor
            ? [rgbOf(theme.getFgAnsi("success")), rgbOf(theme.getFgAnsi("warning")), rgbOf(theme.getFgAnsi("error"))]
            : []
          ).filter((rgb): rgb is Rgb => rgb !== undefined);
          const stops = themeStops.length === 3 ? themeStops : DEFAULT_STOPS;
          const barStyle: BarStyle = {
            fill: truecolor
              ? (text, [r, g, b]) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
              : (text, [r, g]) => theme.fg(r >= 200 && g < 120 ? "error" : r >= 200 ? "warning" : "success", text),
            track: (text) => theme.fg("dim", text),
          };
          const sessionBar = (limit: RateLimitWindow) =>
            `${theme.fg("muted", `${limit.label} `)}${renderBar(limit.used, 6, barStyle, stops)}`;
          const provider = ctx.model?.provider;
          const session = limits.length
            ? limits.map(sessionBar).join(theme.fg("dim", " "))
            : provider === "anthropic" && ctx.modelRegistry.authStorage.get(provider)?.type === "oauth"
              ? theme.fg("muted", "5h — wk —")
              : "";

          const line = composeSegments(createSegments(settings.segments, {
            project: () => theme.fg("muted", `📁 ${project}`),
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
  };

  const persist = () => saveSettings(settings, DEFAULT_CONFIG_PATH);

  pi.registerCommand("statusline", {
    description: "List or toggle statusline segments",
    getArgumentCompletions: (prefix) => {
      const choices = ["on", "off", "toggle project", "toggle model", "toggle effort", "toggle context", "toggle session", "toggle throughput", "toggle time", "toggle branch", "toggle cost", "toggle sessionElapsed", "toggle lastTurn", "toggle pending"];
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
        await refreshDirty(ctx);
        requestRender?.();
        ctx.ui.notify(formatSettings(settings), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    stopTick();
    settings = loadSettings();
    meter = new TurnMeter();
    limits = [];
    dirty = false;
    if (settings.footerEnabled) installFooter(ctx);
    void refreshCodexLimits(ctx);
    await refreshDirty(ctx);
  });

  pi.on("session_shutdown", () => stopTick());

  pi.on("turn_start", (event) => {
    meter.startTurn(event.timestamp);
    if (settings.footerEnabled) startTick();
    requestRender?.();
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") meter.markFirstUpdate();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("turn_end", async (event, ctx) => {
    stopTick();
    if (event.message.role === "assistant") {
      meter.finishTurn({ input: event.message.usage.input, output: event.message.usage.output });
    }
    void refreshCodexLimits(ctx);
    await refreshDirty(ctx);
    requestRender?.();
  });

  pi.on("agent_settled", () => {
    meter.finalizeActiveTurn();
    stopTick();
    requestRender?.();
  });

  pi.on("after_provider_response", (event) => {
    limits = parseRateLimits(event.headers);
    requestRender?.();
  });

  pi.on("model_select", (_event, ctx) => {
    limits = [];
    meter.resetThroughput();
    requestRender?.();
    void refreshCodexLimits(ctx);
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
