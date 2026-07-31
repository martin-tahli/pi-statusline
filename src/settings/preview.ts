import type { StatuslineSettings, PreviewMode } from "./schema.ts";
import { composeFooterLine, type RuntimeSnapshot, type ResolutionContext } from "./resolve.ts";
import type { ProviderCapability } from "./providers/capabilities.ts";

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
    model: { id: "qwen2.5-coder", provider: "ollama", reasoning: true },
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
    hostedSpeed: true,
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
    hostedSpeed: true,
    tokenLedger: true,
    costLedger: true,
    unavailableReason: "usage requires an OpenRouter management key pi doesn't manage",
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
}

/**
 * Render a labelled preview through the SAME production path as the footer
 * (composeFooterLine), so preview and footer can never drift (KTD3). Pure: no
 * network, git, session scans, or mutation of fixtures/settings.
 */
export function renderPreview(input: PreviewInput): string[] {
  const { settings, mode, width } = input;
  if (mode === "current") {
    const ctx = input.current ?? { runtime: {} };
    return [`Current session preview`, composeFooterLine(settings, ctx, width)];
  }
  const fixture = PREVIEW_FIXTURES[mode as "local" | "subscription" | "api" | "narrow"];
  const ctx: ResolutionContext = { capability: fixture.capability, runtime: fixture.snapshot };
  return [`${fixture.label} preview`, composeFooterLine(settings, ctx, width)];
}
