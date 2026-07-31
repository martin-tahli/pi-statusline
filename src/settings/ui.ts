import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";
import { renderPreview } from "./preview.ts";
import type { PreviewMode, StatuslineSettings } from "./schema.ts";

export const ROOT_ROWS = [
  { id: "providers", label: "Providers" },
  { id: "separators", label: "Separators" },
  { id: "emojis", label: "Emojis" },
] as const;

export type RootRowId = (typeof ROOT_ROWS)[number]["id"];
export type DirtyChoice = "save" | "discard" | "cancel";
export type UiAction = "none" | "open" | "close" | "confirm-close";

export interface SettingsUiState {
  original: StatuslineSettings;
  draft: StatuslineSettings;
  selected: number;
  openRow?: RootRowId;
  confirmClose: boolean;
  error?: string;
}

export interface NavigationResult {
  state: SettingsUiState;
  action: UiAction;
}

export function createSettingsUi(settings: StatuslineSettings): SettingsUiState {
  return {
    original: structuredClone(settings),
    draft: structuredClone(settings),
    selected: 0,
    confirmClose: false,
  };
}

export function isDirty(state: SettingsUiState): boolean {
  return JSON.stringify(state.draft) !== JSON.stringify(state.original);
}

export function replaceDraft(state: SettingsUiState, draft: StatuslineSettings): SettingsUiState {
  return { ...state, draft: structuredClone(draft), error: undefined };
}

export function resetDraft(state: SettingsUiState): SettingsUiState {
  const draft = structuredClone(DEFAULT_STATUSLINE_SETTINGS);
  draft.version = state.draft.version;
  draft.__unknown = structuredClone(state.draft.__unknown);
  return { ...state, draft, error: undefined };
}

/** Pure, deterministic routing. I/O is represented as an action for the caller. */
export function routeSettingsKey(state: SettingsUiState, key: string): NavigationResult {
  if (state.confirmClose) return { state, action: "confirm-close" };

  if (key === "Escape") {
    if (state.openRow) return { state: { ...state, openRow: undefined }, action: "none" };
    return isDirty(state)
      ? { state: { ...state, confirmClose: true }, action: "confirm-close" }
      : { state, action: "close" };
  }

  if (state.openRow) return { state, action: "none" };

  let selected = state.selected;
  if (key === "ArrowUp" || key === "k") selected = Math.max(0, selected - 1);
  if (key === "ArrowDown" || key === "j") selected = Math.min(ROOT_ROWS.length - 1, selected + 1);
  if (key === "Home") selected = 0;
  if (key === "End") selected = ROOT_ROWS.length - 1;
  if (selected !== state.selected) return { state: { ...state, selected }, action: "none" };

  if (key !== "Enter") return { state, action: "none" };
  const row = ROOT_ROWS[selected];
  return { state: { ...state, openRow: row.id }, action: "open" };
}

/** Resolve the dirty-close prompt. Save is the only function allowed to perform I/O. */
export async function resolveDirtyChoice(
  state: SettingsUiState,
  choice: DirtyChoice,
  save: (settings: StatuslineSettings) => void | Promise<void>,
): Promise<NavigationResult> {
  if (choice === "cancel") return { state: { ...state, confirmClose: false }, action: "none" };
  if (choice === "discard") {
    return {
      state: { ...state, draft: structuredClone(state.original), confirmClose: false, error: undefined },
      action: "close",
    };
  }

  try {
    await save(structuredClone(state.draft));
    const saved = structuredClone(state.draft);
    return {
      state: { ...state, original: saved, draft: structuredClone(saved), confirmClose: false, error: undefined },
      action: "close",
    };
  } catch (error) {
    return {
      state: { ...state, confirmClose: true, error: error instanceof Error ? error.message : String(error) },
      action: "confirm-close",
    };
  }
}

export interface RenderSettingsUiOptions {
  width: number;
  previewMode?: PreviewMode;
}

/** Pure component rendering; previews use the production footer renderer. */
export function renderSettingsUi(state: SettingsUiState, options: RenderSettingsUiOptions): string[] {
  const lines = ["Statusline settings"];
  for (let index = 0; index < ROOT_ROWS.length; index++) {
    const row = ROOT_ROWS[index];
    lines.push(`${index === state.selected ? ">" : " "} ${row.label}`);
  }
  if (options.width >= 80) {
    lines.push("", ...renderPreview({
      settings: state.draft,
      mode: options.previewMode ?? state.draft.preview.mode,
      width: options.width,
    }));
  }
  if (state.confirmClose) lines.push("", "Unsaved changes: Save / Discard / Cancel");
  if (state.error) lines.push(`Save failed: ${state.error}`);
  return lines;
}
