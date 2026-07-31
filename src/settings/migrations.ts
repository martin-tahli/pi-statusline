import type { StatuslineSettings, ProviderConfiguration, WindowConfiguration, SegmentId } from "./schema.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig } from "./defaults.ts";
import { mergeSettings } from "../config.ts";
import { SEGMENT_ORDER } from "../segments.ts";

/** Legacy settings shape (from src/config.ts). */
interface LegacySettings {
  footerEnabled?: boolean;
  segments?: Record<SegmentId, boolean>;
  extras?: Record<string, boolean>;
  providerTracking?: {
    enabled?: boolean;
    selected?: Record<string, boolean>;
    order?: string[];
    metrics?: Record<string, boolean>;
    overrides?: Record<string, Record<string, boolean>>;
  };
}

/** Migrate legacy settings to new schema (partial, for merging). */
export function migrateLegacySettings(legacy: unknown): Partial<StatuslineSettings> {
  const input = legacy && typeof legacy === "object" ? legacy as LegacySettings : {};
  const merged = mergeSettings(input); // Use existing safe merge for legacy shape

  const result: Partial<StatuslineSettings> = {};

  // Global footer enabled is the legacy footerEnabled ONLY; provider tracking is a separate toggle
  // (providers.enabled below), so footer-on + tracking-off keeps the footer on (parity).
  result.enabled = merged.footerEnabled;

  // Provider settings
  const providers: StatuslineSettings["providers"] = {
    enabled: merged.providerTracking.enabled,
    order: [...merged.providerTracking.order],
    defaults: structuredClone(DEFAULT_STATUSLINE_SETTINGS.providers.defaults),
    records: {},
  };

  // Migrate selected providers to records
  for (const [providerId, enabled] of Object.entries(merged.providerTracking.selected)) {
    const cleanId = providerId.trim();
    if (!cleanId) continue;
    const providerConfig = createProviderConfig();
    providerConfig.enabled = enabled;
    // Seed the default window from the shared metrics, overlaid with per-provider overrides, so the
    // future per-window renderer preserves legacy shared toggles for providers without overrides.
    const overrides = merged.providerTracking.overrides[cleanId] ?? {};
    const windowConfig = createWindowConfig();
    windowConfig.showBar = overrides.usage ?? merged.providerTracking.metrics.usage;
    windowConfig.showPercent = overrides.percent ?? merged.providerTracking.metrics.percent;
    windowConfig.showReset = overrides.reset ?? merged.providerTracking.metrics.reset;
    providerConfig.windows["default"] = windowConfig;
    providers.records[cleanId] = providerConfig;
  }

  // Preserve unknown legacy provider keys as disabled/stored records
  for (const providerId of merged.providerTracking.order) {
    if (!(providerId in providers.records)) {
      const providerConfig = createProviderConfig();
      providerConfig.enabled = false;
      providers.records[providerId] = providerConfig;
    }
  }

  result.providers = providers;

  // Layout: segments -> segmentOrder, narrowPriority from compact behavior
  result.layout = {
    providerRows: "newline",
    placement: "below",
    maxWidth: 0,
    segmentOrder: SEGMENT_ORDER.map((id) => id),
    narrowPriority: ["time", "throughput", "project", "effort", "model", "session"] as SegmentId[],
  };

  // Segments global visibility
  result.segments = { ...merged.segments };

  // Separators from extras (clone so future nested fields can't alias the singleton)
  const separators = structuredClone(DEFAULT_STATUSLINE_SETTINGS.separators);
  if (merged.extras.nerdFont) {
    separators.preset = "Unicode";
  }
  result.separators = separators;

  // Icons from extras (deep clone: symbols/providers are nested objects)
  const icons = structuredClone(DEFAULT_STATUSLINE_SETTINGS.icons);
  if (merged.extras.nerdFont) {
    icons.style = "nerdfont";
  }
  result.icons = icons;

  // Extras: preserve the remaining legacy display toggles (nerdFont migrated to icons above).
  result.extras = {
    branch: merged.extras.branch,
    cost: merged.extras.cost,
    sessionElapsed: merged.extras.sessionElapsed,
    lastTurn: merged.extras.lastTurn,
    pending: merged.extras.pending,
  };

  // Timing: providerTracking refresh interval would be in provider defaults
  // (legacy had no timing config, use defaults)
  result.timing = structuredClone(DEFAULT_STATUSLINE_SETTINGS.timing);

  // Bars, thresholds remain defaults
  result.bars = structuredClone(DEFAULT_STATUSLINE_SETTINGS.bars);
  result.thresholds = structuredClone(DEFAULT_STATUSLINE_SETTINGS.thresholds);

  // Preview remains default
  result.preview = structuredClone(DEFAULT_STATUSLINE_SETTINGS.preview);

  // NEVER copy secrets - no API keys, tokens, or auth data migrated
  // No fake provider adapter created
  // Unknown legacy provider keys preserved as disabled records above

  return result;
}