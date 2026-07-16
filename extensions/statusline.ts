import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { renderBar } from "../src/bar.ts";
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
import { parseRateLimits, type RateLimits } from "../src/ratelimit.ts";
import { composeSegments, createSegments } from "../src/segments.ts";
import { TurnMeter } from "../src/throughput.ts";

export default function statusline(pi: ExtensionAPI) {
  let settings = loadSettings();
  let meter = new TurnMeter();
  let limits: RateLimits = {};
  let dirty = false;
  let requestRender: (() => void) | undefined;

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
          const throughput = [
            snapshot.inputRate === undefined ? "" : `↑ ${formatRate(snapshot.inputRate)} t/s`,
            snapshot.outputRate === undefined ? "" : `↓ ${formatRate(snapshot.outputRate)} t/s`,
          ].filter(Boolean).join(" ");
          const time = snapshot.lastTurnMs === undefined ? "" : formatTime(
            snapshot.activeMs,
            settings.extras.sessionElapsed ? snapshot.elapsedMs : undefined,
            settings.extras.lastTurn ? snapshot.lastTurnMs : undefined,
          );
          const session = limits.fiveHour && limits.weekly
            ? `${theme.fg("dim", "5h ")}${renderBar(limits.fiveHour.used, 8, (text) => theme.fg("success", text))}`
              + `${theme.fg("dim", " · wk ")}${renderBar(limits.weekly.used, 8, (text) => theme.fg("success", text))}`
            : "";

          const line = composeSegments(createSegments(settings.segments, {
            project: () => theme.fg("dim", project),
            model: () => model ? theme.fg("dim", `${model}${cost === undefined ? "" : ` $${cost.toFixed(3)}`}`) : "",
            effort: () => effort ? theme.fg("dim", effort) : "",
            context: () => context
              ? theme.fg(context.percent >= 90 ? "error" : context.percent >= 75 ? "warning" : "dim", context.label)
              : "",
            session: () => session,
            throughput: () => throughput ? theme.fg("dim", throughput) : "",
            time: () => time ? theme.fg("dim", time) : "",
          }), width);
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
    settings = loadSettings();
    meter = new TurnMeter();
    limits = {};
    dirty = false;
    if (settings.footerEnabled) installFooter(ctx);
    await refreshDirty(ctx);
  });

  pi.on("turn_start", (event) => {
    meter.startTurn(event.timestamp);
    requestRender?.();
  });

  pi.on("message_update", (event) => {
    if (event.message.role === "assistant") meter.markFirstUpdate();
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") meter.markMessageEnd();
  });

  pi.on("turn_end", async (event, ctx) => {
    if (event.message.role === "assistant") {
      meter.finishTurn({ input: event.message.usage.input, output: event.message.usage.output });
    }
    await refreshDirty(ctx);
    requestRender?.();
  });

  pi.on("after_provider_response", (event) => {
    limits = parseRateLimits(event.headers);
    requestRender?.();
  });

  pi.on("model_select", () => {
    limits = {};
    requestRender?.();
  });

  pi.on("thinking_level_select", () => requestRender?.());
}
