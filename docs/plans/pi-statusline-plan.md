---
title: pi-statusline — configurable statusline footer extension for pi
created: 2026-07-15
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
plan_depth: standard
output_format: md
---

# pi-statusline — configurable statusline footer for the pi agent

## Goal Capsule

Ship a single-line, configurable **statusline footer** as a publishable pi
package. It replaces pi's built-in footer with a compact, information-dense
strip that shows — left to right — project, model, effort, context usage,
(for subscription/cloud models) 5-hour and weekly session-usage bars, and
throughput (↑/↓ tokens per second). Every segment self-hides when its data is
not applicable to the current provider/model, and every segment can be
manually enabled/disabled. Works identically for local and cloud models.
Published to npm as a scoped pi package installable with `pi install`.

**Problem frame.** pi's built-in footer shows working dir, session, token/cache
usage, cost, context, model. It is fine but fixed. Users who run mixed local
(Ollama/LM Studio) and cloud (Anthropic subscription) models want one glanceable
strip with the *right* signals per provider — subscription users care about
their 5h/weekly quota burn; local users care about generation speed — plus the
ability to turn segments off. No existing extension does this.

**Non-goals (YAGNI).** Multi-line footers, history graphs, sparklines, clickable
segments, per-project themes, remote telemetry, a settings TUI/GUI. Deferred
until asked. See `## Non-Goals`.

## Technical Grounding (verified against pi 0.80.7 docs)

The plugin is a thin enrichment of the shipped `examples/extensions/custom-footer.ts`
pattern. Confirmed API surface:

- **Footer replacement:** `ctx.ui.setFooter((tui, theme, footerData) => ({ render(width): string[], invalidate(), dispose? }))`. `ctx.ui.setFooter(undefined)` restores the built-in footer. Render returns styled lines; use `truncateToWidth` / `visibleWidth` from `@earendil-works/pi-tui`, colors via `theme.fg(role, text)`.
- **footerData:** `getGitBranch()`, `onBranchChange(cb)`, `getExtensionStatuses()`.
- **Model:** `ctx.model` → `{ id, provider, contextWindow, reasoning, ... }` (fields are **camelCase** — verified in `pi-ai/dist/types.d.ts`; there is no `context_window`).
- **Effort (reasoning level):** `ctx.getThinkingLevel()` / `setThinkingLevel()`; non-reasoning models are always `"off"`.
- **Context usage:** `ctx.getContextUsage()` → `{ tokens: number|null, contextWindow: number, percent: number|null }` (verified `extensions/types.d.ts`). Consume `.percent` and `.contextWindow` directly — do NOT recompute. `tokens`/`percent` are `null` immediately after compaction → treat as "hide segment", never divide.
- **Throughput:** token counts from assistant messages `usage.input` / `usage.output` (see custom-footer example) and timing from `turn_start` / `turn_end` (`event.turnIndex`, `event.message.usage`) plus `message_update` streaming events.
- **Session-limit bars (cloud subscription):** `after_provider_response` event exposes normalized `event.headers`. Anthropic subscription responses carry `anthropic-ratelimit-unified-*` headers (usage + reset windows) — the data source for the 5h and weekly bars. "Header availability depends on provider and transport" → the segment self-hides when absent (exactly matches the "don't display if not applicable" requirement).
- **Commands/config:** `pi.registerCommand(...)` for a `/statusline` toggle command; settings persist to a small JSON file.
- **Packaging:** pi package via `package.json` `pi` key or a conventional `extensions/` directory; publish to npm; install with `pi install npm:@scope/pkg`.

## Product Contract

Product Contract preservation: N/A — bootstrapped from user request; no prior brainstorm to preserve.

### Actors
- **A1 — pi user (local models):** runs Ollama/LM Studio/other local providers; wants project, model, effort, context %, ↑/↓ t/s. No session bars.
- **A2 — pi user (cloud subscription):** runs Anthropic Claude subscription; wants everything A1 has plus 5h + weekly session-usage bars.
- **A3 — pi user (cloud API key / other cloud):** cloud provider without unified session-limit headers; gets everything except the session bars.

### Requirements

- **R1 — Single-line footer, fixed left→right order.** Segments render in order:
  `project · model · effort · context · [session bars] · throughput`. Truncates to terminal width without wrapping.
- **R2 — Project segment.** Shows the project name (cwd basename; git branch appended only if the branch segment is enabled — default off).
- **R3 — Model segment.** Shows active model id (and provider when it disambiguates).
- **R4 — Effort segment.** Shows current thinking level (off/low/medium/high). Hidden when the model is non-reasoning (`getThinkingLevel()` is `"off"` and model `reasoning` is false).
- **R5 — Context segment.** Shows `NN.N%/<window>` e.g. `55.0%/1.0M` from `getContextUsage().percent` and `.contextWindow` (never recomputed from raw tokens, never from `ctx.model`). Window formatted compactly (128K, 200K, 1.0M). Color escalates by threshold (dim → warn → error). **Hidden when `percent` is `null`** (e.g. right after compaction) — no `NaN`, no crash.
- **R6 — Session bars (conditional).** For providers exposing unified session-limit headers (Anthropic subscription): render a **5-hour** bar and a **weekly** bar, each a fixed-width ASCII loading bar filled in **light green**, followed by a percent number (e.g. `23%`). Fill = used fraction of the window. Entirely hidden when the headers are absent (R3-key: local, API-key, or non-supporting providers).
- **R7 — Throughput segment.** Shows `↑ <n> t/s` (input rate) and `↓ <n> t/s` (output rate), computed from the most recent turn's token usage and duration. Persists last value while idle; hidden until at least one turn has produced a measurement.
- **R8 — Applicability self-hide.** Any segment whose underlying data is unavailable for the current provider/model renders nothing (no placeholder), and the layout recomposes without gaps.
- **R9 — Manual enable/disable.** Each segment has an on/off setting. A `/statusline` command lists current state and toggles segments. Settings persist across sessions. Defaults: project, model, effort, context, session-bars, throughput = **on**; all optional extras = **off**.
- **R10 — Local + cloud parity.** All settings and applicable segments behave identically regardless of provider; only data availability (not code paths) differs.
- **R11 — Non-destructive.** `/statusline off` (or disable) restores pi's built-in footer via `setFooter(undefined)`; enabling re-installs it. No crash if data hooks return undefined.
- **R12 — Optional extras (default off), brainstormed additions:**
  - **R12a — Session cost `$`:** cumulative `usage.cost.total` for the session.
  - **R12b — Git branch + dirty flag:** branch name from `footerData.getGitBranch()`, optional `*` dirty marker.
  - **R12c — Elapsed session time:** wall-clock since session start.
  - **R12d — Queued/steering indicator:** small marker when `ctx.hasPendingMessages()`.
  (Explicitly deferred, cheap to add later; listed so scope is visible.)

### Key Flows
- **F1 — Load:** extension loads → reads settings → installs footer → renders from current ctx. If a segment's data source isn't ready yet, that segment is blank until data arrives.
- **F2 — Turn:** `turn_start` marks t0 → streaming updates → `turn_end` records tokens+duration → throughput segment updates → `tui.requestRender()`.
- **F3 — Provider response:** `after_provider_response` parses rate-limit headers → updates session-bar state → re-render. Missing headers → bars stay hidden.
- **F4 — Toggle:** `/statusline` command flips a segment, persists, re-renders.
- **F5 — Model switch:** `model_select` → re-evaluate applicability (effort/context window/session bars) → re-render.

### Acceptance Examples
- **AE1:** Local Ollama `qwen2.5-coder`, medium effort, 55% context of 1M → footer:
  `pi-statusline · qwen2.5-coder · medium · 55.0%/1.0M · ↑ 850 t/s ↓ 62 t/s` (no session bars).
- **AE2:** Anthropic subscription `claude-sonnet-4-5`, 5h at 23% / weekly at 41% →
  `pi-statusline · claude-sonnet-4-5 · high · 30.2%/200K · 5h [██░░░░░░] 23% · wk [███░░░░] 41% · ↑ 1.2k t/s ↓ 74 t/s`, the two bar fills rendered light green.
- **AE3:** Cloud API-key provider without unified headers → same as AE1 shape (session bars omitted, throughput shown).
- **AE4:** `/statusline toggle throughput` → throughput disappears, everything else recomposes on one line; persists to next session.
- **AE5:** Non-reasoning model → effort segment absent.
- **AE6:** Terminal narrowed to 40 cols → line truncates cleanly (no wrap, no crash).

## Non-Goals
Multi-line/stacked footer, history/sparkline graphs, clickable or mouse regions,
per-project or themeable color schemes beyond theme roles, remote telemetry/analytics,
a full settings UI (command-line toggles only), cost budgeting/alerts. Add when a
user actually asks.

## Architecture & Design Decisions

- **D1 — One extension, pure-core split.** Ship one extension entry
  (`extensions/statusline.ts`) that wires ctx/events to a set of **pure functions**
  in `src/` (formatters, bar renderer, layout/truncation, throughput math, header
  parsing, config merge). Rationale: pure functions are the only non-trivial logic
  and the only thing worth testing without a TUI harness. ponytail: no plugin
  framework, no segment class hierarchy — segments are just `{ id, enabled, render(state) }` entries in one array that defines order.
- **D2 — Ship TypeScript source directly (no build step).** pi loads `.ts`
  extensions; the npm package ships source under a conventional `extensions/`
  dir + `src/` helpers, declared via the `pi` key. Rationale: no compile/dist
  pipeline to maintain. ponytail: skipped tsc/bundler; add a build only if pi
  ever requires precompiled JS.
- **D3 — Settings storage: one JSON file at `~/.pi/agent/statusline.json`.**
  Load on start, merge over defaults, write on toggle. Rationale: simplest
  durable per-user store; no dependency. ponytail: user-scope only; add
  project-scope override only if requested.
- **D4 — Session bars are Anthropic-header-driven and best-effort.** Parse
  `anthropic-ratelimit-unified-*` from `after_provider_response`; compute
  used-fraction and reset window. If any required header is missing, keep the
  bars hidden. Rationale: this is the only path to the data and it degrades to
  the required "hide when not applicable" behavior automatically.
- **D5 — Throughput definition (streaming-windowed, not whole-turn).**
  The extension timestamps with `Date.now()` at three points — `turn_start` (t0),
  first `message_update` (tFirst), `message_end` (tEnd) — because `TurnEndEvent`
  carries no timestamp and whole-turn wall-time would fold in tool-execution
  seconds. `↓` = output tokens ÷ (tEnd − tFirst) (**generation** window only,
  excludes tool time); `↑` = input tokens ÷ (tFirst − t0) (prompt-processing
  window). Falls back to hidden if a window is 0/unmeasurable. README documents
  the definition; values are settings-tunable later. Rationale: uses only
  confirmed events, and windowing on the streaming phase keeps `↓` an honest
  generation rate for a tool-heavy coding agent.
- **D6 — Light-green bar.** Use the theme's closest green role for the filled
  cells (`theme.fg("success", …)` or a green when the theme exposes one),
  ASCII `█`/`░` cells, fixed width (default 8). Rationale: theme-consistent,
  ANSI-safe, width-stable for truncation math.
- **D7 — Render is cheap + event-driven.** Recompute state on the events that
  change it (turn_end, after_provider_response, model_select, branch change,
  toggle) and call `tui.requestRender()`; `render(width)` only formats cached
  state. Rationale: no polling timers, no per-frame git/network calls.

### File / Module Layout (repo-relative)
- `package.json` — name `@shvax/pi-statusline`, `pi` manifest object `"pi": { "extensions": ["./extensions"] }` (dir/glob arrays — verified `docs/packages.md`; NOT a file path string), `peerDependencies` `{ "@earendil-works/pi-tui": "*", "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-ai": "*" }` (host-provided, never bundled), `publishConfig.access=public`.
- `extensions/statusline.ts` — entry: registers footer + `/statusline` command, subscribes to events, owns cached render state.
- `src/segments.ts` — ordered segment definitions + layout/compose/truncate.
- `src/format.ts` — number/percent/window formatting (`k`/`M`, `NN.N%`).
- `src/bar.ts` — ASCII loading-bar renderer (fraction → filled/empty cells).
- `src/throughput.ts` — turn timing accumulator + t/s math.
- `src/ratelimit.ts` — Anthropic unified-header parsing → `{ fiveHour?, weekly? }`.
- `src/config.ts` — defaults, load/save/merge, segment enable/disable.
- `test/*.test.ts` — pure-function checks (see Implementation Units).
- `README.md`, `LICENSE` (MIT), `.gitignore`, `tsconfig.json` (types only).

## Implementation Units

Each feature-bearing unit names its test file and exact scenarios so an
implementer tests without inventing coverage.

### IU1 — Package scaffold & pi manifest
Files: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, dir skeleton.
- `package.json` `name=@shvax/pi-statusline`, `version=0.1.0`, `"pi": { "extensions": ["./extensions"] }`, `peerDependencies` for the three `@earendil-works/*` hosts set to `"*"` (must NOT appear in `dependencies`/`bundledDependencies`), `files` includes `extensions/`,`src/`, `publishConfig.access=public`, MIT, repo/keywords.
- Verify pi discovers the extension AND resolves peer imports (`truncateToWidth`, `visibleWidth`, types): `pi -e . ` (or `pi install ./`) loads without a resolution error.
Proof: `npm pack --dry-run` lists intended files; manual `pi -e .` smoke (AC4).
No dedicated test (config-only, IU1 is smoke-verified).

### IU2 — Segment framework, layout & formatting (pure)
Files: `src/segments.ts`, `src/format.ts`; test `test/format.test.ts`, `test/segments.test.ts`.
Scenarios:
- format: 128000→`128K`, 200000→`200K`, 1000000→`1.0M`; 0.55→`55.0%`; t/s 1200→`1.2k`.
- segment order is exactly project,model,effort,context,session,throughput.
- a disabled or data-less segment produces `""` and is dropped from the join (no double separators).
- compose truncates to width via `truncateToWidth`, never exceeds `width`, never wraps.

### IU3 — Live data collectors (model, effort, context, project)
Files: extend `extensions/statusline.ts`; unit-test the pure derivations in `test/derive.test.ts`.
Scenarios:
- context percent = tokens/window; hides when `getContextUsage()` undefined.
- effort hides when level `off` AND model non-reasoning (`ctx.model.reasoning === false`); shows label otherwise.
- context uses `getContextUsage().percent`/`.contextWindow`; hides when `percent` is `null` or `getContextUsage()` is `undefined` (asserted).
- project = cwd basename; model = `ctx.model.id`.

### IU4 — Throughput meter (↑/↓ t/s)
Files: `src/throughput.ts`; test `test/throughput.test.ts`.
Scenarios:
- tokens=620,output over 10.0s → `62 t/s`; input=8500 over 10s → `850 t/s` / formatted `1.2k` past 1000.
- zero-duration guard (no divide-by-zero → segment hidden).
- retains last value when idle; resets on new turn start.

### IU5 — Session-limit bars (Anthropic unified headers)
Files: `src/ratelimit.ts`, `src/bar.ts`; tests `test/ratelimit.test.ts`, `test/bar.test.ts`.
Scenarios:
- ratelimit: given a captured Anthropic header fixture, parse 5h + weekly used-fraction; given headers absent OR unrecognized names → returns `{}` (bars hidden). Parser matches by known header prefix only; any parse miss ⇒ hidden, never a guess.
- NOTE: the fixture is authored only *after* IU5's one-time live capture (AC2); until captured, the parser ships defensive and the segment stays hidden.
- bar: fraction 0.23, width 8 → 2 filled + 6 empty cells, `23%`; fraction 1.0 → all filled; fraction 0 → all empty; clamps >1 and <0.
- filled cells carry the green theme role (assert the style wrapper is applied).

### IU6 — Settings + `/statusline` command
Files: `src/config.ts`; extend entry; test `test/config.test.ts`.
Scenarios:
- defaults merge: missing file → all core segments on, extras off.
- toggle flips one segment and persists (round-trip load returns the new value).
- unknown segment name is rejected (no silent corrupt write).
- `/statusline` with no args returns a readable on/off listing (pure formatter tested).

### IU7 — README, license, examples
Files: `README.md`, `LICENSE`.
- README: what it is, install (`pi install npm:@shvax/pi-statusline`), the segment table, `/statusline` usage, provider applicability matrix (local vs Anthropic subscription vs other cloud), the throughput definition (D5), a text mock of AE1/AE2.
- No test (docs).

### IU8 — Publish to npm
- `npm whoami` (expect `shvax`) → confirm scope; `npm publish --access public`.
- Post-publish smoke: `pi install npm:@shvax/pi-statusline` in a scratch dir loads the footer.
- Tag `v0.1.0`, push if a remote is configured (none currently — skip push, note it).
Proof: published version resolves via `npm view @shvax/pi-statusline version`.

## Acceptance Contracts

- **AC1 — Footer layout/behavior.**
  - Source of truth: R1/R8 + AE1–AE6.
  - Must match: single line; exact segment order; inapplicable segments omitted with clean recompose; truncates to width, never wraps.
  - Must not regress: no crash when any data hook returns `undefined` **or `null`** (post-compaction context); `setFooter(undefined)` fully restores built-in footer.
  - Regression guard: `test/derive.test.ts` includes a `getContextUsage()` = `{ tokens: null, percent: null, contextWindow: 200000 }` case → context segment renders `""`.
  - Proof: `test/segments.test.ts` + `test/format.test.ts` green; manual `pi -e .` at 40/80/120 cols.
  - Approver: maintainer visual smoke + passing unit tests.

- **AC2 — Session-bar data fidelity.**
  - Source of truth: R6 + Anthropic `anthropic-ratelimit-unified-*` semantics + AE2/AE3.
  - Must match: used-fraction and window parsed from real header shape; light-green fill; percent label.
  - Must not regress: bars NEVER shown for providers/responses lacking the headers (local, API-key) — assert hidden-on-absent.
  - Proof: `test/ratelimit.test.ts` header fixture (captured from a real Anthropic subscription response during IU5) + `test/bar.test.ts`.
  - Approver: passing tests + one live Anthropic subscription smoke confirming real headers parse.

- **AC3 — Throughput math.**
  - Source of truth: R7 + D5 + AE1.
  - Must match: t/s = tokens ÷ turn-seconds; formatting thresholds.
  - Proof: `test/throughput.test.ts`.

- **AC4 — Package installability.**
  - Source of truth: R11 + IU1/IU8.
  - Must match: `pi -e .` and `pi install npm:@shvax/pi-statusline` both load the extension and render the footer; `npm pack` contents = declared files only.
  - Proof: `npm pack --dry-run` + install smoke.

## Risks & Mitigations
- **Anthropic header names/shape uncertain until observed live.** Mitigation: IU5 captures a real fixture before finalizing the parser; parser is defensive (missing → hidden), so a wrong guess degrades gracefully, never crashes. This is the single biggest unknown and is contained by AC2's live smoke.
- **Throughput definition may not match user's mental model of "up/down t/s".** Mitigation: D5 now windows on the streaming phase (excludes tool-execution wall time) and documents it in README; values are settings-tunable later. Low risk (cosmetic).
- **pi footer render contract (`render`/`invalidate`/`dispose`) details.** Mitigation: mirror the shipped `custom-footer.ts` example verbatim for the wiring; only the pure formatting is novel.
- **Terminal width / ANSI width miscalc breaks truncation.** Mitigation: use `visibleWidth`/`truncateToWidth` from `@earendil-works/pi-tui` (as the example does); AC1 tests width bounds.

## Sequencing
IU1 → IU2 → IU3 → (IU4 ∥ IU5 ∥ IU6) → IU7 → IU8.
IU2 is the backbone (all rendering flows through it). IU5 needs a live Anthropic
response once to capture the header fixture; until then its parser+bar are built
and tested against the fixture, and the segment simply stays hidden.

## Resolved Decisions (no open questions remain)
Every design fork is settled as Decisions D1–D7; the two the user explicitly confirmed on 2026-07-15 are recorded here so nothing stays open:
- npm scope = `@shvax` (from `npm whoami`); reconfirm at publish (IU8).
- Throughput semantics CONFIRMED: `↑` = input/prompt rate over the prompt-processing window, `↓` = generation rate over the streaming window (tool time excluded), per D5; tunable in settings later.
- Optional extras R12a–d CONFIRMED: built but shipped disabled by default; core segments ship enabled.
- Session-bar header shape is resolved live in IU5 before the parser is finalized (AC2); it self-hides until then, so it is not an open blocker.

## Advisor Hardening (folded in 2026-07-15)
Read-only advisor pass against the installed pi 0.80.7 `.d.ts` corrected four grounding errors before implementation:
- `ctx.model.context_window` → `contextWindow`; context now read from `getContextUsage().percent`/`.contextWindow` (BLOCKING, fixed R5/IU3/Grounding).
- `getContextUsage()` `null` tokens/percent post-compaction now hide the segment instead of rendering `NaN` (BLOCKING, fixed R5/IU3/AC1).
- Added `peerDependencies` (`"*"`, unbundled) for the three `@earendil-works/*` hosts (BLOCKING, fixed IU1/AC4).
- `pi` manifest corrected to object form `{ "extensions": ["./extensions"] }` (fixed D2/IU1).
- Throughput redefined to streaming windows since `TurnEndEvent` has no timestamp (fixed D5/AC3).
