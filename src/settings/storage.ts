import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { StatuslineSettings, ParsedSettings } from "./schema.ts";
import { parseStatuslineSettings } from "./validation.ts";
import { DEFAULT_STATUSLINE_SETTINGS } from "./defaults.ts";

/** Operations interface for atomic save (injectable for testing). */
export interface SaveOperations {
  mkdir(path: string, options: { recursive: true }): void;
  writeFile(path: string, data: string, encoding: "utf8"): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

/** Default operations using synchronous fs. */
const defaultSaveOps: SaveOperations = {
  mkdir: mkdirSync,
  writeFile: writeFileSync,
  rename: renameSync,
  unlink: unlinkSync,
};

/**
 * Save settings atomically:
 * 1. Validate/normalize first
 * 2. Write uniquely-named sibling temp file
 * 3. Atomic rename
 * 4. Clean temp on failure
 * Original file and runtime settings left untouched on failure.
 */
export function saveStatuslineSettings(
  settings: StatuslineSettings,
  path: string,
  operations: SaveOperations = defaultSaveOps
): void {
  // Validate and normalize first (throws if future version/readOnly)
  const parsed = parseStatuslineSettings(settings);
  if (parsed.readOnly) {
    throw new Error("Cannot save read-only settings (future schema version)");
  }
  const normalized = parsed.settings;

  // Generate unique temp filename: ${path}.${pid}.${random}.tmp
  const pid = process.pid;
  const unique = randomUUID().replace(/-/g, "").slice(0, 12);
  const temporary = `${path}.${pid}.${unique}.tmp`;

  operations.mkdir(dirname(path), { recursive: true });

  try {
    operations.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    operations.rename(temporary, path);
  } catch (error) {
    // Clean up temp file on any failure
    try {
      operations.unlink(temporary);
    } catch {
      // Ignore cleanup failure - original file is untouched
    }
    throw error;
  }
}

/**
 * Read settings from file.
 * Missing file -> defaults (not readOnly).
 * Invalid JSON/types -> defaults via parseStatuslineSettings fallback.
 */
export function readStatuslineSettings(path: string): ParsedSettings {
  try {
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    return parseStatuslineSettings(parsed);
  } catch {
    // Missing file, invalid JSON, or parse error -> a CLONE of defaults (never the singleton).
    return { settings: structuredClone(DEFAULT_STATUSLINE_SETTINGS) };
  }
}