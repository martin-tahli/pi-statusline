import type { StatuslineSettings, ProviderConfiguration, WindowConfiguration, SegmentId } from "./schema.ts";
import { DEFAULT_STATUSLINE_SETTINGS, createProviderConfig, createWindowConfig } from "./defaults.ts";
import { SEGMENT_ORDER } from "../segments.ts";

/** Create a deep clone of settings for draft isolation. */
export function createDraft(settings: StatuslineSettings): StatuslineSettings {
  return structuredClone(settings);
}

/** Reset a selected value in the draft to its default. */
export function resetSelected(draft: StatuslineSettings, path: string): StatuslineSettings {
  const keys = path.split(".");
  let current: unknown = draft;
  let parent: unknown = draft;
  let parentKey: string | number = "";

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (current && typeof current === "object" && key in current) {
      parent = current;
      parentKey = key;
      current = (current as Record<string, unknown>)[key];
    } else {
      return draft; // Path not found, no-op
    }
  }

  // Get default value for this path
  const defaultValue = getDefaultValue(keys);
  if (defaultValue !== undefined && parent && typeof parent === "object") {
    (parent as Record<string, unknown>)[parentKey] = defaultValue;
  }

  return draft;
}

/** Reset a provider's configuration in the draft. */
export function resetProvider(draft: StatuslineSettings, providerId: string): StatuslineSettings {
  if (draft.providers.records[providerId]) {
    draft.providers.records[providerId] = createProviderConfig();
  }
  return draft;
}

/** Reset a section in the draft. */
export function resetSection(draft: StatuslineSettings, section: keyof StatuslineSettings): StatuslineSettings {
  const defaultSettings = DEFAULT_STATUSLINE_SETTINGS;
  if (section in defaultSettings && section !== "version" && section !== "__unknown") {
    (draft as unknown as Record<string, unknown>)[section] = structuredClone(defaultSettings[section]);
  }
  return draft;
}

/** Reset all settings in the draft to defaults (mutates and returns the same draft). */
export function resetAll(draft: StatuslineSettings): StatuslineSettings {
  const defaults = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  defaults.version = draft.version; // Preserve version
  defaults.__unknown = draft.__unknown; // Preserve unknown fields
  // Mutate the existing draft object in place so callers keep their reference.
  for (const key of Object.keys(draft as unknown as Record<string, unknown>)) {
    delete (draft as unknown as Record<string, unknown>)[key];
  }
  Object.assign(draft as unknown as Record<string, unknown>, defaults);
  return draft;
}

/** Get default value for a dot-notation path. */
function getDefaultValue(keys: string[]): unknown {
  const defaults = DEFAULT_STATUSLINE_SETTINGS;
  let current: unknown = defaults;

  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current === undefined ? undefined : structuredClone(current);
}

/** Assert no aliasing between two objects (for testing). Primitives never alias. */
export function assertNoAliasing(original: unknown, clone: unknown, path = ""): void {
  // Only object references can alias; primitives (===) and null are fine.
  if (original === clone && (original === null || typeof original !== "object")) {
    return;
  }
  if (original === clone && original !== null && typeof original === "object") {
    throw new Error(`Aliasing detected at ${path || "root"}: clone is same object as original`);
  }
  if (original && typeof original === "object" && clone && typeof clone === "object") {
    const origKeys = Object.keys(original as object);
    const cloneKeys = Object.keys(clone as object);
    for (const key of origKeys) {
      if (cloneKeys.includes(key)) {
        assertNoAliasing(
          (original as Record<string, unknown>)[key],
          (clone as Record<string, unknown>)[key],
          path ? `${path}.${key}` : key
        );
      }
    }
  }
}