import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SEGMENT_ORDER, type SegmentId } from "./segments.ts";

export const EXTRA_NAMES = ["branch", "nerdFont", "cost", "sessionElapsed", "lastTurn", "pending"] as const;
export type ExtraName = (typeof EXTRA_NAMES)[number];

export interface Settings {
  footerEnabled: boolean;
  segments: Record<SegmentId, boolean>;
  extras: Record<ExtraName, boolean>;
}

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
    nerdFont: true,
    cost: false,
    sessionElapsed: false,
    lastTurn: false,
    pending: false,
  },
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".pi", "agent", "statusline.json");

export function mergeSettings(value: unknown): Settings {
  const input = value && typeof value === "object" ? value as Partial<Settings> : {};
  const segments: Partial<Record<SegmentId, unknown>> = input.segments && typeof input.segments === "object"
    ? input.segments
    : {};
  const extras: Partial<Record<ExtraName, unknown>> = input.extras && typeof input.extras === "object"
    ? input.extras
    : {};
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
  };
}

export function loadSettings(path = DEFAULT_CONFIG_PATH): Settings {
  try {
    return mergeSettings(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return mergeSettings(undefined);
  }
}

export function saveSettings(settings: Settings, path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
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
