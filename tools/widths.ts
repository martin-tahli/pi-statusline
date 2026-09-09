/**
 * Width-sweep diagnostic: render the footer exactly as pi would at several terminal widths,
 * using the REAL settings file (~/.pi/agent/statusline.json) and a fixture shaped like a live
 * session, so narrow-screen problems (phone) are reproducible without a phone.
 *
 *   npm run widths            # sweep 80..40
 *   npm run widths -- 55      # just one width
 */
import { renderMainLine, renderProviderRows, type ProviderRowSource } from "../src/render.ts";
import { loadRuntimeSettings, DEFAULT_STATUSLINE_CONFIG_PATH } from "../src/settings/runtime.ts";
import { truncateToWidth } from "@earendil-works/pi-tui";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Fixture mirrors a live phone session: glm-5.3 active, three subscription providers tracked.
const settings = loadRuntimeSettings(DEFAULT_STATUSLINE_CONFIG_PATH);
const now = Date.now();
const windows = {
  anthropic: [
    { key: "five-hour", label: "5h", used: 0.11, resetAt: now + 100 * 60_000 },
    { key: "seven-day", label: "wk", used: 0.42, resetAt: now + 3.4 * 86_400_000 },
  ],
  "openai-codex": [
    { key: "primary", label: "wk", used: 0.63, resetAt: now + 5.1 * 86_400_000 },
    { key: "secondary", label: "5h", used: 1.0, resetAt: now + 95 * 60_000 },
  ],
  zai: [
    { key: "five-hour", label: "5h", used: 0.03, resetAt: now + 178 * 60_000 },
    { key: "weekly", label: "wk", used: 0.01, resetAt: now + 12 * 86_400_000 },
  ],
};
const sources: ProviderRowSource[] = Object.entries(windows).map(([provider, ws]) => ({ provider, windows: ws }));
const activeProvider = "zai";

for (const width of process.argv[2] ? [Number(process.argv[2])] : [80, 70, 60, 56, 50, 45, 40]) {
  if (!Number.isFinite(width) || width <= 0) continue;
  const main = renderMainLine(settings, {
    cwd: "/mnt/active/projects/github/pi-statusline",
    model: { id: "glm-5.3", provider: activeProvider, reasoning: true },
    thinkingLevel: "high",
    contextUsage: { percent: 4.8, tokens: 48_000, contextWindow: 1_000_000 },
    gitBranch: "main",
    subscription: true,
    sessionWindows: windows[activeProvider],
    activeProviderHasRow: settings.providers.enabled,
  }, width);
  const rows = renderProviderRows(settings, sources, undefined, now, width)
    .map((row) => truncateToWidth(row, width, ""));
  const ruler = ("|----+----").repeat(Math.ceil(width / 10)).slice(0, Math.max(0, width - 1)) + "|";
  console.log(`\nw=${width}`);
  console.log(`  ${ruler}`);
  for (const line of [main, ...rows]) console.log(`  ${strip(line)}`);
}
