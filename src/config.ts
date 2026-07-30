import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SEGMENT_ORDER, type SegmentId } from "./segments.ts";

export const EXTRA_NAMES = ["branch", "nerdFont", "cost", "sessionElapsed", "lastTurn", "pending"] as const;
export type ExtraName = (typeof EXTRA_NAMES)[number];

export const PROVIDER_METRICS = ["usage", "percent", "reset"] as const;
export type ProviderMetricId = (typeof PROVIDER_METRICS)[number];

export interface ProviderMetrics {
  usage: boolean;
  percent: boolean;
  reset: boolean;
}

export interface ProviderTrackingSettings {
  enabled: boolean;
  selected: Record<string, boolean>;
  order: string[];
  metrics: ProviderMetrics;
  overrides: Record<string, Partial<ProviderMetrics>>;
}

export interface Settings {
  footerEnabled: boolean;
  segments: Record<SegmentId, boolean>;
  extras: Record<ExtraName, boolean>;
  providerTracking: ProviderTrackingSettings;
}

const DEFAULT_PROVIDER_TRACKING: ProviderTrackingSettings = {
  enabled: true,
  selected: {},
  order: [],
  metrics: { usage: true, percent: true, reset: true },
  overrides: {},
};

export const DEFAULT_SETTINGS: Settings = {
  footerEnabled: true,
  segments: {
    project: true,
    model: true,
    effort: true,
    context: true,
    session: true,
    throughput: true,
    time: true,
  },
  extras: {
    branch: true,
    nerdFont: false,
    cost: false,
    sessionElapsed: false,
    lastTurn: false,
    pending: false,
  },
  providerTracking: DEFAULT_PROVIDER_TRACKING,
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "statusline.json");

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function providerName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function mergeProviderTracking(value: unknown): ProviderTrackingSettings {
  const input = record(value);
  const selected = Object.fromEntries(Object.entries(record(input.selected)).flatMap(([provider, enabled]) =>
    providerName(provider) && typeof enabled === "boolean" ? [[provider, enabled]] : []
  ));
  const order = Array.from(new Set((Array.isArray(input.order) ? input.order : [])
    .map(providerName).filter((provider): provider is string => provider !== undefined)));
  const metrics = record(input.metrics);
  const overrides = Object.fromEntries(Object.entries(record(input.overrides)).flatMap(([provider, override]) => {
    const values = record(override);
    const sparse = Object.fromEntries(PROVIDER_METRICS.flatMap((metric) =>
      typeof values[metric] === "boolean" ? [[metric, values[metric]]] : []
    )) as Partial<ProviderMetrics>;
    return providerName(provider) && Object.keys(sparse).length ? [[provider, sparse]] : [];
  }));
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    selected,
    order,
    metrics: Object.fromEntries(PROVIDER_METRICS.map((metric) =>
      [metric, typeof metrics[metric] === "boolean" ? metrics[metric] : true]
    )) as unknown as ProviderMetrics,
    overrides,
  };
}

export function mergeSettings(value: unknown): Settings {
  const input = record(value);
  const segments = record(input.segments) as Partial<Record<SegmentId, unknown>>;
  const extras = record(input.extras) as Partial<Record<ExtraName, unknown>>;
  return {
    footerEnabled: typeof input.footerEnabled === "boolean" ? input.footerEnabled : true,
    segments: Object.fromEntries(SEGMENT_ORDER.map((name) => [
      name,
      typeof segments[name] === "boolean" ? segments[name] : DEFAULT_SETTINGS.segments[name],
    ])) as Record<SegmentId, boolean>,
    extras: Object.fromEntries(EXTRA_NAMES.map((name) => [
      name,
      typeof extras[name] === "boolean" ? extras[name] : DEFAULT_SETTINGS.extras[name],
    ])) as Record<ExtraName, boolean>,
    providerTracking: mergeProviderTracking(input.providerTracking),
  };
}

export interface AvailableModelRegistry {
  getAvailable(): Array<{ provider: string }>;
}

/** Providers with configured pi authentication, in registry order. */
export function configuredProviders(registry: AvailableModelRegistry): string[] {
  return Array.from(new Set(registry.getAvailable().map((model) => providerName(model.provider))
    .filter((provider): provider is string => provider !== undefined)));
}

/** Preserve saved providers while appending newly authenticated providers as selected. */
export function reconcileProviderTracking(settings: Settings, registry: AvailableModelRegistry): Settings {
  const providers = configuredProviders(registry);
  const tracking = settings.providerTracking;
  const selected = { ...tracking.selected };
  const order = [...tracking.order];
  for (const provider of providers) {
    if (!(provider in selected)) selected[provider] = true;
    if (!order.includes(provider)) order.push(provider);
  }
  return { ...settings, providerTracking: { ...tracking, selected, order } };
}

export function loadSettings(path = DEFAULT_CONFIG_PATH): Settings {
  try {
    return mergeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return mergeSettings(undefined);
  }
}

export interface SaveOperations {
  mkdir(path: string, options: { recursive: true }): void;
  writeFile(path: string, data: string, encoding: "utf8"): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

const saveOperations: SaveOperations = { mkdir: mkdirSync, writeFile: writeFileSync, rename: renameSync, unlink: unlinkSync };

export function saveSettings(settings: Settings, path = DEFAULT_CONFIG_PATH, operations = saveOperations): void {
  const temporary = `${path}.tmp`;
  operations.mkdir(dirname(path), { recursive: true });
  try {
    operations.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    operations.rename(temporary, path);
  } catch (error) {
    try { operations.unlink(temporary); } catch { /* The original document remains untouched. */ }
    throw error;
  }
}

export function toggleSetting(settings: Settings, name: string): Settings {
  if ((SEGMENT_ORDER as readonly string[]).includes(name)) {
    const id = name as SegmentId;
    return { ...settings, segments: { ...settings.segments, [id]: !settings.segments[id] } };
  }
  if ((EXTRA_NAMES as readonly string[]).includes(name)) {
    const id = name as ExtraName;
    return { ...settings, extras: { ...settings.extras, [id]: !settings.extras[id] } };
  }
  throw new Error(`Unknown statusline segment: ${name}`);
}

export function formatSettings(settings: Settings): string {
  const rows = [
    ["footer", settings.footerEnabled],
    ...SEGMENT_ORDER.map((name) => [name, settings.segments[name]] as const),
    ...EXTRA_NAMES.map((name) => [name, settings.extras[name]] as const),
  ];
  return rows.map(([name, enabled]) => `${name}: ${enabled ? "on" : "off"}`).join("\n");
}
