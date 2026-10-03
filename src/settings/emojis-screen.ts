import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import { setProviderIcon } from "./provider-ui.ts";
import type { StatuslineSettings } from "./schema.ts";
import { parseStatuslineSettings } from "./validation.ts";
import { isTextInput, editText } from "./text.ts";

export interface EmojisScreenRow {
  id: string;
  label: string;
}

type Row = EmojisScreenRow & (
  | { kind: "style" }
  | { kind: "symbol"; symbol: string }
  | { kind: "provider-mode" | "provider-value"; providerId: string }
  | { kind: "reset" }
);

export const ICON_SYMBOLS = ["project", "model", "thinking", "context", "throughput", "time", "ledger"] as const;

const ICON_STYLES = ["emoji", "unicode", "ascii", "nerdfont", "minimal", "none", "custom"] as const;
// "default" already renders no provider glyph, so exposing "hidden" would be a duplicate control.
const PROVIDER_ICON_MODES = ["default", "custom"] as const;

function shown(value: string): string {
  return JSON.stringify(value);
}

function rows(draft: StatuslineSettings, providerIds: readonly string[]): Row[] {
  const result: Row[] = [{ id: "icons.style", label: `Global icon style: ${draft.icons.style}`, kind: "style" }];
  for (const symbol of ICON_SYMBOLS) {
    result.push({ id: `icons.symbols.${symbol}`, label: `${symbol} symbol: ${shown(draft.icons.symbols[symbol] ?? "")}`, kind: "symbol", symbol });
  }
  const ids = [...new Set([...providerIds, ...Object.keys(draft.providers.records), ...Object.keys(draft.icons.providers)])];
  for (const providerId of ids) {
    const icon = draft.icons.providers[providerId] ?? { mode: "default", value: "" };
    result.push(
      { id: `icons.providers.${providerId}.mode`, label: `Provider ${providerId} icon mode: ${icon.mode}`, kind: "provider-mode", providerId },
      { id: `icons.providers.${providerId}.value`, label: `Provider ${providerId} icon value: ${shown(icon.value)}`, kind: "provider-value", providerId },
    );
  }
  result.push({ id: "reset.icons", label: "Reset to default", kind: "reset" });
  return result;
}

export function buildEmojisScreen(draft: StatuslineSettings, providerIds: readonly string[] = []): readonly EmojisScreenRow[] {
  return rows(draft, providerIds);
}

function cycle<T>(values: readonly T[], current: T, backwards: boolean): T {
  const index = Math.max(0, values.indexOf(current));
  return values[(index + (backwards ? values.length - 1 : 1)) % values.length];
}

export function routeEmojisKey(
  draft: StatuslineSettings,
  selected: number,
  key: string,
  providerIds: readonly string[] = [],
  group?: string,
): { draft: StatuslineSettings; selected: number } {
  const screenRows = rows(draft, providerIds).filter((row) => !group || (group === "symbols" ? !row.id.startsWith("icons.providers.") : row.id.startsWith(`icons.providers.${group}.`)));
  const row = screenRows[selected];
  if (!row) return { draft, selected };
  if ((row.kind === "symbol" || row.kind === "provider-value") && isTextInput(key)) {
    const next = structuredClone(draft);
    if (row.kind === "symbol") {
      const value = next.icons.symbols[row.symbol] ?? "";
      next.icons.symbols[row.symbol] = editText(value, key);
    } else {
      const icon = next.icons.providers[row.providerId] ?? { mode: "default", value: "" };
      const value = editText(icon.value, key);
      setProviderIcon(next, row.providerId, { mode: "custom", value });
    }
    next.icons = parseStatuslineSettings({ ...DEFAULT_STATUSLINE_SETTINGS, icons: next.icons }).settings.icons;
    return { draft: next, selected };
  }
  if (key === "ArrowUp" || key === "k") return { draft, selected: Math.max(0, selected - 1) };
  if (key === "ArrowDown" || key === "j") return { draft, selected: Math.min(screenRows.length - 1, selected + 1) };
  if (key === "Home") return { draft, selected: 0 };
  if (key === "End") return { draft, selected: Math.max(0, screenRows.length - 1) };

  const backwards = key === "ArrowLeft" || key === "h";
  const forwards = key === "ArrowRight" || key === "l" || key === "Enter" || key === " " || key === "Space";
  const next = structuredClone(draft);
  if (row.kind === "style" && (forwards || backwards)) {
    next.icons.style = cycle(ICON_STYLES, next.icons.style, backwards);
  } else if (row.kind === "provider-mode" && (forwards || backwards)) {
    const icon = next.icons.providers[row.providerId] ?? { mode: "default", value: "" };
    setProviderIcon(next, row.providerId, { ...icon, mode: cycle(PROVIDER_ICON_MODES, icon.mode, backwards) });
  } else if (row.kind === "reset" && forwards) {
    next.icons = structuredClone(DEFAULT_STATUSLINE_SETTINGS.icons);
  } else {
    return { draft, selected };
  }
  if (row.kind !== "reset") {
    next.icons = parseStatuslineSettings({ ...DEFAULT_STATUSLINE_SETTINGS, icons: next.icons }).settings.icons;
  }
  return { draft: next, selected };
}
