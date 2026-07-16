---
title: Statusline Redesign - Plan
type: feat
date: 2026-07-16
topic: statusline-redesign
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Statusline Redesign - Plan

## Goal Capsule

- **Objective:** Redesign the pi-statusline footer to be emoji-forward, theme-native, and color-coded by meaning — solid-fill usage bars, always-visible speed-colored throughput, and a live-ticking timer — while staying 100% code-computed (zero LLM tokens).
- **Product authority:** Repo owner (statusline author and primary user); redesign becomes the extension's default look for all users.
- **Open blockers:** None. All Outstanding Questions from the Product Contract were technical/research items owned by planning; each is resolved below (Planning Contract) rather than left blocking.
- **Product Contract preservation:** Changed: R4 — the owner clarified that the reference image specifies a small, smooth, **rounded pill** shape with no dotted empty track; the screenshot does not specify colors. The bar remains theme `success`/`warning`/`error` by raw consumed usage. The former deferred planning inputs are resolved below as KTDs without changing product scope.

## Product Contract

### Summary

Replace the current ASCII-flavored footer with an emoji-forward "Balanced" layout: one icon per segment, `>` separators, solid screenshot-style usage bars, throughput that is always visible and colored by speed, and a live-ticking hourglass timer. All color is drawn from the active PI theme's named tokens, so the statusline matches the selected theme and traffic-lights meaning (green/orange/red) with the same mechanism. Coloring is semantic-only to keep the line calm and scannable.

### Problem Frame

The current footer reads as flat and low-signal: everything is rendered in one dim color, the usage bars use bracketed `[██░░]` ASCII that is hard to parse at a glance, and the time icon (`⏱`) is nearly invisible. Throughput is defined in code but is not showing for the author's setup, so real-time speed — the thing most worth watching during a turn — is absent. The result is a status line that carries data but takes effort to read, which is the opposite of what a footer is for.

### Key Decisions

- **Theme tokens are the single color lever.** pi's `theme.fg()` accepts only named tokens (`success`/`warning`/`error`/`accent`/`muted`/`dim`/`text`), not raw hex. Mapping green→`success`, orange→`warning`, red→`error` satisfies both "traffic-light by usage/speed" and "match the active PI theme" with one mechanism, and guarantees no hard-coded colors.
- **Throughput color is adaptive-plus-floor.** Color relative to a rolling baseline of the session's recent same-model turns (red = notably slower than usual, green = at/above), with an absolute floor so output ↓ ≤ ~15 t/s always reads red regardless of model. Input ↑ (prompt processing, often thousands of t/s) colors adaptively only, no floor.
- **Semantic-only coloring.** Segment text stays calm (theme `muted`/`text`); color is reserved for things that change and carry signal — usage bars, throughput speed, and context filling up. Emoji supply the visual pop instead of per-segment tints, to avoid the "rainbow = noisy" failure the owner explicitly wants to avoid.
- **Emoji is the default look, no ASCII fallback in v1.** Ship the emoji redesign as the default rendering; add a text/ASCII fallback only if a real terminal-compatibility problem is reported.
- **Bars are smooth rounded pills, not blocky.** The reference screenshot dictates the *shape only* — a compact continuous fill with Nerd Font Powerline rounded endcaps (`` and ``) and a partial-block edge (`▏▎▍▌▋▊▉█`) for sub-cell precision. It renders **no empty-track glyph** (`░`, dots, or bracketed blocks); the terminal background is the unfilled space. The screenshot's blue/green coloring is ignored; the whole pill uses the theme green/orange/red from R5.

### Requirements

**Layout and icons**

- R1. The footer renders in a "Balanced" layout: each segment is `<emoji> <short text>`, segments joined by a ` > ` separator rendered in `dim`.
- R2. Segments carry these icons: 📁 project, 🤖 model, 🧠 effort, 🪟 context, ⚡ throughput, ⏳ time. The 5h/weekly usage bars keep their short text labels (`5h`, `wk`).
- R3. The current ` · ` separator and bracketed bar style (`[████░░░░]`) are removed.

**Usage bars (5h / weekly)**

- R4. Each non-zero usage bar renders as a compact smooth rounded pill matching the reference screenshot: `` + up to 8 `█` cells with a partial-block glyph (`▏▎▍▌▋▊▉`) for the fractional last cell + ``, all styled as one fill. It has no surrounding `[ ]` and **no rendered empty track** (`░`/dots), then shows the integer percentage. At zero usage, omit the empty pill and show `0%`.
- R5. Bar fill color keys off the raw utilization fraction (not the rounded percent): `success` below 0.75, `warning` from 0.75 to under 0.90, `error` at 0.90 or above.
- R6. Bars remain best-effort: when the provider does not expose both unified rate-limit headers, no bars render (unchanged from today).

**Throughput**

- R7. Throughput (`⚡ ↑ <input> ↓ <output> t/s`) is present on every completed turn and stays visible while idle. When streamed timing windows are available, ↑ uses the prompt-processing window and ↓ uses the generation window (as today); when either window is unavailable, that direction falls back to its token count divided by whole-turn duration. A zero-length measured duration displays `0 t/s`, so neither rate is blank.
- R8. ↑ and ↓ are colored independently against their own adaptive current-model baselines — the rolling mean of the prior 5 input or output rates: `success` at or above 90% of baseline, `warning` from 60% to under 90%, `error` below 60%. A rate that is objectively fast can still read `error` when it is far below that direction's own norm; this is intended.
- R9. An absolute floor overrides the adaptive band for output ↓: at or below 15 t/s it always reads `error`. Input ↑ has no floor and colors adaptively only.
- R10. Cold start: until a direction's baseline holds at least 3 samples for the current model — true at every session start and after each model switch — that direction colors `muted` (neutral), except the R9 output floor, which still applies. A model switch resets both displayed rates and both baseline histories.

**Time**

- R11. The time segment uses the ⏳ hourglass icon (replacing `⏱`).
- R12. During an active turn the time counts up live; between turns it shows cumulative active time as today. A lightweight repaint timer starts when a turn begins, and its cadence tracks the displayed granularity (repaint each second while seconds are shown, coarser once only minutes/hours show) so it never repaints without changing the value.
- R13. The timer stops on any turn termination — normal end, abort, error, or interrupt — never runs while idle, and is disposed when the footer unmounts.

**Robustness and width**

- R14. Under width pressure the line sheds whole segments in a defined low-to-high priority order that keeps throughput and time visible as long as possible, rather than always truncating the trailing segments. The exact drop order is pinned in planning.

**Coloring, theme, and constraints**

- R15. All colors come from `theme.fg()` named tokens; no hard-coded hex or ANSI. Switching the PI theme recolors the statusline with no code change.
- R16. Coloring is semantic-only: base segment text is `muted`, separators are `dim`, and color is applied only to usage-bar fills, throughput speed, and the context percentage (context already escalates to `warning`/`error` when high — keep that).
- R17. The statusline is computed entirely in the extension with no model/LLM calls; rendering stays cheap and synchronous.

### Acceptance Examples

- AE1. **Covers R4, R5.** Given 5h utilization 0.62 and weekly 0.23, when the footer renders, then both rounded pills are `success` (green); at 0.75 the pill becomes `warning` (orange), and at 0.90 or above it becomes `error` (red). The fill has Powerline ``/`` caps and no dotted/`░` empty track.
- AE2. **Covers R8, R9, R10.** Given the current model's output baseline is ~70 t/s: a 68 t/s ↓ reads `success`, a 48 t/s ↓ (≈69%) reads `warning`, and a 12 t/s ↓ reads `error` via the floor. Given a 1.2k t/s input baseline, a 1.0k t/s ↑ reads `warning` and has no absolute floor. Given the first turn after a model switch (both baselines empty), each direction reads `muted` unless ↓ is at or below 15 t/s, which still reads `error`.
- AE3. **Covers R12, R13.** Given a turn is in progress, when the display granularity advances (each second while seconds are shown), then the time value advances; given the turn ends, aborts, or errors, then the timer stops and the value holds.
- AE4. **Covers R7.** Given a completed turn on a streaming provider, throughput shows ↑ and ↓ from their streamed windows; given a completed turn without one or both streamed windows, the missing direction shows its whole-turn fallback rate. Neither rate is blank on a completed turn.

### Scope Boundaries

- Out of scope: any browser/GUI surface; configurable emoji sets; per-model configurable speed/usage thresholds; a text/ASCII-only fallback mode.
- Deferred (add only on demand): ASCII fallback toggle if a terminal cannot render the emoji/bar glyphs cleanly.

### Dependencies / Assumptions

- Requires a Nerd Font terminal: the rounded-pill endcaps use Powerline glyphs ``/``, alongside the chosen emoji and block glyphs. Width/rendering against `truncateToWidth` from `@earendil-works/pi-tui` must be manually verified on the author's terminal. No fallback is in v1.
- Assumes `theme.fg()` token set (`success`/`warning`/`error`/`muted`/`dim`/`accent`/`text`) is stable across themes (confirmed in pi theme docs: all themes define these).
- Adaptive throughput coloring requires the meter to retain short current-model input and output histories, and to expose independent whole-turn fallback rates when streamed timing windows are absent (R7).

### Resolved Planning Inputs

- Throughput now falls back independently for ↑ and ↓ when their streamed timing window is absent (KTD3/U2), which covers the likely cause of the author's missing t/s display.
- Nerd Font glyph coverage and width (including ``/``, 🪟, ⚡, and ⏳) remain a manual `pi -e .` smoke check; tofu or width breakage revisits the deferred fallback, but does not alter the rounded-pill v1 scope.
- R8 ships the 5-sample / 90%-60% baselines as fixed v1 defaults, with no configuration surface (KTD2/U2).
- Width pressure uses KTD6's whole-segment drop order, keeping throughput and time as long as possible.

### Sources / Research

- `extensions/statusline.ts` — footer render, segment composition, throughput/time assembly, event wiring.
- `src/bar.ts` — current bracketed `[██░░] %` bar; target of the solid-fill + level-color change.
- `src/throughput.ts` — `TurnMeter` computing last-turn input/output rates; needs rolling per-model history for adaptive coloring.
- `src/format.ts` — `formatRate`, `formatTime`, `formatDuration`; time icon and live-tick formatting land here.
- `src/segments.ts` — segment order and `composeSegments` separator (` · ` → ` > `).
- pi theme tokens and `theme.fg()` API (green/orange/red = `success`/`warning`/`error`); reference screenshot shows the target solid-fill bar look.
- `docs/extensions.md` (pi SDK) — `turn_start`/`turn_end`/`agent_settled` lifecycle: `agent_end` fires when a low-level run ends but pi may auto-retry or auto-compact; `agent_settled` is the point pi guarantees `ctx.isIdle()` is true, making it the reliable catch-all for "stop the live timer" regardless of success/abort/error/retry (resolves R13's stop condition).
- No local precedent for adaptive-baseline throughput coloring exists in the repo or in common CLI resource monitors (`top`/`htop`/`docker stats`/`k9s` all color CPU/mem/disk against fixed absolute thresholds, because the reference range for those metrics is known and stable). Token/sec has no such stable reference across models, which is exactly why R8's adaptive-baseline-per-model design (not a fixed-threshold one) is the right fit here — corroborates rather than changes the brainstorm's decision, so no KTD reversal.

---

## Planning Contract

### Key Technical Decisions

- **KTD1 — Shared utilization-level function, but bars and context stay visually distinct.** `barLevel(fraction)` (new, `src/bar.ts`) returns `success`/`warning`/`error` at the R5 thresholds (0.75/0.90) for usage bars. Context keeps its existing `warning`/`error`-only escalation (no `success`/`dim` unification) per R16's explicit "keep that" — the two are visually distinct on purpose (bars always show a color; context shows `dim` until it needs to warn), so no shared three-band function is introduced across both.
- **KTD2 — One current-model baseline, reset on every selection.** `TurnMeter` holds two plain five-sample arrays: one for input rates and one for output rates. It compares a newly completed rate against the relevant history **before** appending that rate, then appends/caps it. The existing `model_select` handler calls a small meter reset that clears both histories and both displayed rates. This is the literal R10 behavior, avoids a `Map`/model-id plumbing abstraction, and makes every selection — including A → B → A — a cold start.
- **KTD3 — Missing streamed windows fall back independently.** If the prompt or generation window is absent or zero-length, `finishTurn` computes that direction as its token count divided by whole-turn duration. ↑ and ↓ use the same existing `formatRate` display path, so both stay present without special-case rendering.
- **KTD4 — Live tick: one 1s interval, render-gated by string equality.** Rather than reconfiguring the interval at the 60-minute granularity boundary, run one 1s `setInterval` while a turn is active and call `requestRender()` only when the formatted time string differs. The *render* cadence therefore tracks displayed granularity without stateful interval swapping.
- **KTD5 — Settle finalizes a dangling active turn.** `turn_end` handles ordinary completed assistant turns. `agent_settled` catches abort/error/interrupt paths: it clears the interval and asks `TurnMeter` to finalize any still-active turn (add its elapsed duration to active time, clear its start marker, and leave rates unset). This makes later renders hold rather than continue counting.
- **KTD6 — Width-pressure drop order + styled separator injection.** `composeSegments` accepts a caller-supplied separator and tries the full line first; the footer supplies `theme.fg("dim", " > ")`. If the line does not fit, composition drops whole enabled segments lowest-priority-first until it fits or only `throughput`+`time` remain: `session` → `effort` → `project` → `model` → `context`. `truncateToWidth` remains last-resort fallback if even the protected pair overflow.
- **KTD7 — Base text token changes from `dim` to `muted`; only separators stay `dim`.** R16 specifies `muted` base text and `dim` separators — today's code uses `dim` for everything. The rounded pill has no rendered empty track, so it has no track color to apply.
- **KTD8 — Nerd Font Powerline caps make the fill a pill.** `renderBar` wraps each non-zero fill in `` and ``; `styleFill` colors caps, full blocks, and partial edge as one continuous pill. This is the smallest way to reproduce the screenshot's rounded ends in a terminal. It deliberately requires a Nerd Font (already accepted in R4's assumptions) rather than adding a fallback/config mode.

### Throughput Color Decision (resolves R7–R10 as one table)

| Condition | Color | Rationale |
|---|---|---|
| ↓ output rate ≤ 15 t/s | `error` | Output-only absolute floor (R9) — overrides everything else |
| Direction has < 3 samples in its own history | `muted` | Cold start (R10) — no baseline yet to judge against |
| Direction rate ≥ 90% of its own rolling mean | `success` | At/above that direction's own norm (R8) |
| Direction rate 60–89% of its own rolling mean | `warning` | Moderately below norm (R8) |
| Direction rate < 60% of its own rolling mean | `error` | Well below norm (R8) |

Evaluated independently for ↑ and ↓. The floor applies only to ↓ and is checked before cold-start/adaptive bands.

### Assumptions

- Input and output each use the same fixed five-sample / 90%-60% defaults, with no configuration surface; revise only if real usage proves them wrong.
- Every `model_select` deliberately clears the current histories and displayed rates (including a return to a previously selected model), as R10 requires.
- `agent_settled` (KTD5) is available on the installed `@earendil-works/pi-coding-agent` version; if unavailable, implementation must retain a cleanup fallback, but the tested target behavior is settle-finalization.

---

## Implementation Units

### U1. Smooth utilization bar + level function

- **Goal:** Replace the bracketed block bar with a continuous smooth-fill bar and expose a pure `success`/`warning`/`error` level function for it.
- **Requirements:** R3, R4, R5
- **Dependencies:** none
- **Files:** `src/bar.ts`, `test/bar.test.ts`
- **Approach:** Rewrite `renderBar(fraction, width, styleFill)` to render only the consumed portion: Powerline left cap ``, full `█` cells for `Math.floor(fraction * width)`, one partial-block glyph (`▏▎▍▌▋▊▉`) selected from the fractional remainder in eighths, and right cap ``. It renders no `[`/`]` or unfilled `░`/dot cells; `styleFill` wraps the entire pill. The 8-cell width is maximum fill length, not a fixed-width track. At zero, omit caps/fill. Add `barLevel(fraction): "success" | "warning" | "error"` from raw 0.75/0.90 thresholds.
- **Test scenarios:**
  - Happy path: `renderBar(0.54, 8)` has ``/``, no `[`/`]` or `░`, ends in `54%`, and contains one continuous pill.
  - Happy path: `barLevel(0.23) === "success"`, `barLevel(0.62) === "success"`, `barLevel(0.76) === "warning"`, `barLevel(0.91) === "error"`.
  - Edge case: `fraction = 0` renders no cap/fill and `0%`; `fraction = 1` renders both caps plus eight full `█` cells, no partial glyph, and `100%`.
  - Edge case: boundary inclusivity — `barLevel(0.75) === "warning"`, `barLevel(0.9) === "error"`.
  - Edge case: a fraction landing mid-cell (e.g. 0.5625 at width 8) selects the correct partial-block glyph for that eighth.
- **Verification:** `bar.test.ts` covers all of the above; `npm test` passes.

### U2. Adaptive directional throughput + whole-turn fallbacks

- **Goal:** `TurnMeter` always exposes both rates and independent ↑/↓ color levels without carrying stale data across a model switch.
- **Requirements:** R7, R8, R9, R10
- **Dependencies:** none
- **Files:** `src/throughput.ts`, `test/throughput.test.ts`
- **Approach:** Hold two plain five-sample histories: input and output. For each completed turn, calculate each streamed-window rate when its duration is positive; otherwise calculate that direction from whole-turn duration. Classify a new rate against its direction's history **before** appending it, then append/cap five entries. A shared pure helper accepts a rate, its history, and an optional output floor to return `muted`/`success`/`warning`/`error`. Add a small `resetThroughput()` that clears both histories and displayed rates; `model_select` calls it (KTD2/KTD3).
- **Test scenarios:**
  - Happy path: output baseline `[70,71,69,70,70]` classifies 68 as `success`, 48 as `warning`, and 30 as `error`; input baseline `[1200,1200,1200]` classifies 1000 as `warning` with no floor.
  - Edge case: either history with <3 samples is `muted`; output ≤15 is `error` even during cold start or against a fast history.
  - Edge case: adding a sixth sample evicts only that direction's oldest sample.
  - Edge case: `resetThroughput()` clears both histories and both displayed rates; an A → B → A selection sequence remains cold at every switch.
  - Error path: absent/zero-length input or output streamed window with positive whole-turn duration returns that direction's fallback rate, not `undefined`; a zero-length whole turn displays `0 t/s` without division by zero.
  - Error path: `finishTurn` with no active turn remains a no-op.
  - Integration: `turn_start → message_end → turn_end`, with no `message_update`, produces two non-`undefined`, independently colorable fallback rates.
- **Verification:** `throughput.test.ts` covers all of the above; `npm test` passes.

### U3. Live-ticking time segment with robust stop

- **Goal:** Restyle the time segment with ⏳ and make it tick live during an active turn, stopping cleanly on any termination path.
- **Requirements:** R11, R12, R13
- **Dependencies:** none
- **Files:** `src/format.ts`, `src/throughput.ts`, `extensions/statusline.ts`, `test/format.test.ts`, `test/throughput.test.ts`, `test/statusline.test.ts`
- **Approach:** `format.ts` swaps `⏱` for `⏳`. `TurnMeter.liveElapsedMs(now)` returns `now - turnStartedAt` only while active; the footer displays persisted active time plus this live value. Add a minimal finalization method for `agent_settled`: when a turn is still active, it commits that elapsed duration, clears the start marker, and leaves rates unset (KTD5). The footer starts one 1s interval on `turn_start`, requests a render only when the formatted time changed, and clears/finalizes on `agent_settled`, `turn_end`, and footer disposal.
- **Test scenarios:**
  - Happy path: the rendered time string uses `⏳`, not `⏱`.
  - Happy path: `liveElapsedMs(now)` two calls one second apart during an active turn returns an increasing value.
  - Edge case: no active turn — `liveElapsedMs` returns 0 and the displayed value equals persisted `activeMs` across repeated calls.
  - Edge case: duration crossing 60 minutes — the formatted string is unchanged tick-to-tick except when the displayed minute/hour actually changes (no per-second flicker once past 60 minutes, verified via `formatDuration`, not the interval itself).
  - Integration: simulate `turn_start` then `agent_settled` without assistant `turn_end` — the interval is cleared, later time reads hold, and no further `requestRender` calls occur.
  - Integration: extension `dispose()` during an active turn clears the interval (no timer fires after footer teardown).
- **Verification:** `format.test.ts` and `throughput.test.ts` cover pure functions; `test/statusline.test.ts` uses fake timers to cover interval/lifecycle behavior, plus a manual check after an interrupted turn.

### U4. Width-pressure segment drop priority

- **Goal:** Under narrow width, drop whole segments by priority instead of always truncating the tail.
- **Requirements:** R14
- **Dependencies:** none
- **Files:** `src/segments.ts`, `test/segments.test.ts`
- **Approach:** Extend `composeSegments` with an optional separator argument while retaining the current ` · ` default for its direct unit tests. The footer will supply the themed ` > ` separator. Compose the full line first; if it would truncate, retry after dropping segments in KTD6 order (`session → effort → project → model → context`) until it fits or only `throughput`+`time` remain, then apply `truncateToWidth` as the residual fallback.
- **Test scenarios:**
  - Happy path: default separator preserves the existing pure-module behavior; an injected separator joins enabled segments exactly once.
  - Happy path: width fits everything except `session` — only `session` is dropped.
  - Edge case: width fits only `throughput`+`time` — every other enabled segment is dropped.
  - Edge case: width narrower than `throughput`+`time` combined — `truncateToWidth` still trims the tail as a last resort (documented fallback, not a regression).
  - Integration: a segment disabled via `/statusline toggle` never consumes a drop slot (drop order only applies to enabled segments).
- **Verification:** `segments.test.ts` covers all of the above; `npm test` passes.

### U5. Wire icons, separators, and semantic coloring into the footer

- **Goal:** Assemble U1–U4 into the final rendered footer: icons, `>` separators, `muted`/`dim` text split, and the new bar/throughput coloring.
- **Requirements:** R1, R2, R6, R7, R8, R9, R10, R15, R16, R17
- **Dependencies:** U1, U2, U3, U4
- **Files:** `extensions/statusline.ts`, `test/statusline.test.ts`
- **Approach:** Prefix segment renderers with 📁/🤖/🧠/🪟/⚡/⏳. Pass `theme.fg("dim", " > ")` into U4's separator argument and style base segment text with `muted`. Render the ↑ value and ↓ value as separate `theme.fg()` spans using their independent U2 levels; do not color the combined throughput string once. Wire `model_select` to `meter.resetThroughput()` and preserve the current `limits.fiveHour && limits.weekly` best-effort bar gate.
- **Test scenarios:**
  - Representative footer smoke: all six icons and dim `>` separators render in order.
  - Directional-color integration: a green ↑ and warning ↓ are separately styled in one throughput segment; a model selection clears the old displayed rates.
  - Test expectation: bar, rate, and timing math remains covered by U1–U3; this unit owns only footer wiring/lifecycle assertions.
- **Verification:** manual `pi -e .` visual check plus the smoke assertion above; `npm test` and `npm run typecheck` pass.

### U6. Update README for the new look and behavior

- **Goal:** Keep the published example output and segment/behavior descriptions accurate for npm consumers.
- **Requirements:** documents R1–R17 (no new product behavior)
- **Dependencies:** U5
- **Files:** `README.md`
- **Approach:** Replace the example output lines with the new emoji/smooth-bar/`>`-separator look; note live-ticking time, always-visible colored throughput, and that colors come from the active PI theme.
- **Test scenarios:** Test expectation: none — documentation-only change, no executable behavior.
- **Verification:** manual read-through against the actual rendered footer from U5's smoke check.

---

## Verification Contract

| Command | Applies to | Gate |
|---|---|---|
| `npm test` (`node --test test/*.test.ts`) | U1–U5 | All existing and new assertions pass |
| `npm run typecheck` (`tsc --noEmit`) | All units | No type errors |
| Manual: `pi -e .` visual check | U1, U3, U5 | Nerd Font glyphs (``/``), emoji, and blocks render without tofu; bar is a compact smooth rounded pill with no `░`/dotted track; time visibly ticks during a turn; green/orange/red track consumed usage in the active theme |

No CI/build step exists beyond these two `package.json` scripts; no additional gate is introduced.

---

## Definition of Done

- All Requirements R1–R17 are satisfied by at least one Implementation Unit and traced test scenario or verification step above.
- `npm test` and `npm run typecheck` both pass with no regressions to existing segments (project/model/effort/context) not touched by this redesign.
- The old bracketed bar code path, `░`/dotted empty-track glyph, and old `⏱`/`·`-separator strings are fully removed; non-zero bars use the Nerd Font `…` pill caps, with no dead alternative path.
- `README.md` reflects the shipped look and behavior (U6).
- Manual glyph/smoke check performed on the author's terminal per the Verification Contract; if it reveals real rendering breakage, that becomes a follow-up decision to add the ASCII-fallback deferred in Scope Boundaries — it does not block this Definition of Done, which targets the emoji-default design as scoped.

