import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import type { StatuslineSettings } from "./schema.ts";

export type Preset = "minimal" | "balanced" | "detailed";

/** Presets change presentation only; credentials, refresh policy and provider selection stay put. */
export function applyPreset(settings: StatuslineSettings, preset: Preset): StatuslineSettings {
  const next = structuredClone(settings);
  next.segments = { ...DEFAULT_STATUSLINE_SETTINGS.segments };
  next.extras = { ...DEFAULT_STATUSLINE_SETTINGS.extras };
  next.bars.format = preset === "detailed" ? "detailed" : "percent";
  next.providers.scope = preset === "detailed" ? "selected" : "active";
  next.providers.enabled = preset === "detailed";
  if (preset === "minimal") {
    next.segments = { project: false, model: true, effort: false, context: true, session: "auto", throughput: false, time: false };
  } else if (preset === "detailed") {
    next.segments.throughput = true;
    next.segments.time = true;
    next.extras = { branch: true, cost: true, sessionElapsed: true, lastTurn: true, pending: true, extensionStatuses: true };
  }
  for (const record of Object.values(next.providers.records)) {
    record.windows = {};
    for (const segment of Object.keys(record.activeModel) as Array<keyof typeof record.activeModel>) record.activeModel[segment] = "default";
  }
  return next;
}
