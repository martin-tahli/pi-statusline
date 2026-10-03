import { accountSources, accountWindows } from "../accounts.ts";
import type { StatuslineSettings, PreviewMode } from "./schema.ts";
import { composeFooterLine, type RuntimeSnapshot, type ResolutionContext } from "./resolve.ts";
import { renderProviderRows, providerHasRow, arrangeFooterLines, missingUsageLabel, usageFreshness, type ProviderRowSource, type RenderTheme } from "../render.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";
import type { ProviderUiContext } from "./provider-ui.ts";

/** An immutable preview fixture: a runtime snapshot + capability + human label. */
export interface PreviewFixture {
  snapshot: RuntimeSnapshot;
  capability: ProviderCapability;
  label: string;
}

const localFixture: PreviewFixture = Object.freeze({
  label: "Local model",
  snapshot: Object.freeze({
    cwd: "/home/user/project",
    model: { id: "qwen2.5-coder", provider: "ollama", reasoning: true, baseUrl: "http://localhost:11434" },
    activeProvider: "ollama",
    thinkingLevel: "medium",
    contextUsage: { percent: 55, tokens: 550_000, contextWindow: 1_000_000 },
    throughput: { inputRate: 850, outputRate: 62 },
    activeMs: 0,
  } as RuntimeSnapshot),
  capability: Object.freeze({
    available: true,
    authenticated: true,
    modelCount: 1,
    billing: "local",
    quotaSupport: "none",
    quotaReliability: "none",
    localSpeed: true,
    hostedSpeed: false,
    tokenLedger: false,
    costLedger: false,
  } as ProviderCapability),
});

const subscriptionFixture: PreviewFixture = Object.freeze({
  label: "Subscription provider",
  snapshot: Object.freeze({
    cwd: "/home/user/project",
    model: { id: "claude-sonnet-4-5", provider: "anthropic", reasoning: true },
    activeProvider: "anthropic",
    thinkingLevel: "high",
    contextUsage: { percent: 30.2, tokens: 60_400, contextWindow: 200_000 },
    sessionWindows: [
      { label: "5h", used: 0.23 },
      { label: "wk", used: 0.41 },
    ],
    throughput: { inputRate: 1200, outputRate: 74 },
    activeMs: 0,
  } as RuntimeSnapshot),
  capability: Object.freeze({
    available: true,
    authenticated: true,
    modelCount: 1,
    billing: "subscription",
    quotaSupport: "official",
    quotaReliability: "high",
    localSpeed: false,
    hostedSpeed: false,
    tokenLedger: false,
    costLedger: false,
  } as ProviderCapability),
});

const apiFixture: PreviewFixture = Object.freeze({
  label: "API provider",
  snapshot: Object.freeze({
    cwd: "/home/user/project",
    model: { id: "gpt-4o", provider: "openrouter", reasoning: true },
    activeProvider: "openrouter",
    thinkingLevel: "medium",
    contextUsage: { percent: 40, tokens: 51_200, contextWindow: 128_000 },
    throughput: { outputRate: 58 },
    totals: { input: 128_000, output: 34_000, cost: 0.512 },
    activeMs: 0,
  } as RuntimeSnapshot),
  capability: Object.freeze({
    available: true,
    authenticated: true,
    modelCount: 1,
    billing: "api",
    quotaSupport: "none",
    quotaReliability: "none",
    localSpeed: false,
    hostedSpeed: false,
    tokenLedger: true,
    costLedger: true,
    unavailableReason: "no key budget in this example",
  } as ProviderCapability),
});

/** Fixed preview fixtures keyed by non-current mode. Immutable; render never mutates them. */
export const PREVIEW_FIXTURES: Readonly<Record<"local" | "subscription" | "api" | "narrow", PreviewFixture>> =
  Object.freeze({
    local: localFixture,
    subscription: subscriptionFixture,
    api: apiFixture,
    // Narrow reuses the local fixture; the caller passes a small width to show truncation.
    narrow: { ...localFixture, label: "Narrow terminal" } as PreviewFixture,
  });

export interface PreviewInput {
  settings: StatuslineSettings;
  mode: PreviewMode;
  width: number;
  /** Live snapshot/capability, required only for the "current" mode. */
  current?: ResolutionContext;
  /** Caller-owned discovery/capability/window snapshot, so the "current" preview can render the
   *  provider-tracking rows and refocus on the provider whose detail is being edited. */
  providers?: ProviderUiContext;
  /** Provider whose detail screen is open; the preview refocuses on it (e.g. editing OpenAI shows
   *  no 5h windows). When unset, the preview reflects the live session. */
  selectedProviderId?: string;
  /** Live terminal theme, so the preview renders with the same colors as the footer. */
  theme?: RenderTheme;
}

/**
 * Build provider-row sources for the live preview: every tracked provider (draft order, draft
 * enabled) with its cached windows, falling back to the live session's windows for the active
 * provider. Mirrors the footer's own source-building so the preview rows match the saved footer.
 */
function liveSources(
  settings: StatuslineSettings,
  providers: ProviderUiContext | undefined,
  live: ResolutionContext,
): ProviderRowSource[] {
  if (!settings.providers.enabled || !providers) return [];
  const order = settings.providers.order;
  const activeProvider = live.runtime.activeProvider;
  return order.flatMap<ProviderRowSource>((provider) => {
    if (settings.providers.records[provider]?.enabled === false || (settings.providers.scope === "active" && provider !== activeProvider)) return [];
    if (providers.accounts?.[provider]) return accountSources(settings, providers.accounts[provider], live.runtime.now);
    const windows = providers.windows?.[provider] ?? (provider === activeProvider ? (live.runtime.sessionWindows ?? []) : []);
    const health = providers.health?.[provider];
    if (windows.length && (!health || health.state === "fresh")) return [{ provider, windows, freshness: usageFreshness(health?.updatedAt ?? 0, health?.cached ?? false, live.runtime.now) }];
    const reason = provider === "anthropic" && providers.capabilities[provider]?.billing !== "subscription" ? "log in" : health?.reason;
    const placeholder = missingUsageLabel(settings, provider, reason);
    return placeholder ? [{ provider, windows: [], placeholder }] : [];
  });
}

/** Resolve the main-line context, provider-row sources, and label for the "current" preview. */
function resolveCurrentPreview(input: PreviewInput): { label: string; ctx: ResolutionContext; sources: ProviderRowSource[] } {
  const { settings, current, providers, selectedProviderId } = input;
  const live = current ?? { runtime: {} };
  const liveProvider = live.runtime.activeProvider;
  const target = selectedProviderId ?? liveProvider;
  const sources = liveSources(settings, providers, live);

  // No provider detail open, or editing the live provider: the preview mirrors the live session.
  if (!target || !providers || target === liveProvider) {
    const activeProviderHasRow = providerHasRow(settings, sources, liveProvider);
    return {
      label: "Current session preview",
      ctx: { capability: live.capability, runtime: { ...live.runtime, activeProviderHasRow,
        sessionPlaceholder: activeProviderHasRow ? "" : live.runtime.sessionPlaceholder ?? (liveProvider && live.capability && live.capability.quotaSupport !== "none" ? missingUsageLabel(settings, liveProvider) : ""),
      } },
      sources,
    };
  }

  // Editing a different provider: refocus the main line on it (its capability + its quota windows),
  // so e.g. OpenAI shows no 5h session. The provider rows still show every tracked provider, so
  // per-window display settings for the edited provider are visible on its own row.
  const cap = providers.capabilities[target];
  const accounts = providers.accounts?.[target];
  const activeAccount = accounts?.accounts.find((account) => account.active);
  const windows = accounts ? accountWindows(settings, target, activeAccount, live.runtime.now) : providers.windows?.[target] ?? [];
  const displayName = providers.descriptors.find((d) => d.id === target)?.displayName ?? target;
  const activeProviderHasRow = providerHasRow(settings, sources, target);
  const ctx: ResolutionContext = {
    capability: cap ?? live.capability,
    runtime: {
      cwd: live.runtime.cwd,
      gitBranch: live.runtime.gitBranch,
      gitStatus: live.runtime.gitStatus,
      pending: live.runtime.pending,
      activeProvider: target,
      model: { id: displayName, provider: target, baseUrl: providers.descriptors.find((d) => d.id === target)?.models[0]?.baseUrl },
      sessionWindows: [...windows],
      sessionFreshness: accounts ? usageFreshness(activeAccount?.updatedAt ?? 0, true, live.runtime.now) : undefined,
      activeProviderHasRow,
    },
  };
  return { label: `${displayName} preview`, ctx, sources };
}

/**
 * Render a labelled preview through the SAME production path as the footer
 * (renderMainLine via composeFooterLine, plus renderProviderRows), so preview and footer can
 * never drift. The "current" mode reflects the draft: it refocuses on the provider whose detail is
 * being edited and renders the provider-tracking rows. Pure: no network, git, session scans, or
 * mutation of fixtures/settings.
 */
export function renderPreview(input: PreviewInput): string[] {
  const { settings, mode, width, theme } = input;
  if (mode === "current") {
    const { label, ctx, sources } = resolveCurrentPreview(input);
    if (!settings.enabled) return [label, "Statusline disabled"];
    const now = ctx.runtime.now ?? Date.now();
    const main = composeFooterLine(settings, ctx, width, theme);
    const rows = renderProviderRows(settings, sources, theme, now, width);
    return [label, ...arrangeFooterLines(settings, main, rows)];
  }
  const fixture = PREVIEW_FIXTURES[mode as "local" | "subscription" | "api" | "narrow"];
  if (!settings.enabled) return [`${fixture.label} preview`, "Statusline disabled"];
  const ctx: ResolutionContext = { capability: fixture.capability, runtime: fixture.snapshot };
  return [`${fixture.label} preview`, composeFooterLine(settings, ctx, width, theme)];
}
