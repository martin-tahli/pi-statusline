# @shvax/pi-statusline

A configurable, single-line footer for [pi](https://github.com/earendil-works/pi-mono). It uses the active pi theme for semantic colors, shows only the data available for the active model and provider, and drops lower-priority segments before truncating at narrow widths.

```text
🪟  55.0%/1.0M > 🤖 qwen2.5-coder > 🧠 medium > 📁 pi-statusline   main ✓ > ⚡ ↑ 0 t/s ↓ 0 t/s > ⏳ 12m34s
🪟  30.2%/200K > 5h ╺━━────────╴ 23% ↻2h14m wk ╺━━━━──────╴ 41% ↻4d6h > 🤖 claude-sonnet-4-5 > 🧠 high > 📁 pi-statusline   main ~2 ?1 ↑2 > ⚡ ↑ 1.2k t/s ↓ 74 t/s > ⏳ 8m02s
```

Usage is a thin continuous line with rounded half-line ends and a dark-gray track. Its bright truecolor fill gives a restrained glow, moving smoothly from neon green through vivid orange to blood red as usage rises. Each provider-reported window includes a compact live reset countdown.

## Install

```bash
pi install npm:@shvax/pi-statusline
```

Try a local checkout without installing it:

```bash
pi -e .
```

## Segments

Segments render in priority order. As the window narrows, the lowest-priority available segment disappears first.

| Segment | Default | Contents |
|---|---:|---|
| `context` | on | Context percent and window; hidden while usage is unknown |
| `session` | on | Available subscription usage windows and reset countdowns; Codex labels come from the account's current limits |
| `model` | on | Active model id |
| `effort` | on | Thinking level; hidden for non-reasoning models |
| `project` | on | Current directory name and compact Git HUD |
| `throughput` | on | Latest prompt and generation token rates, independently speed-colored; starts at `0 t/s` |
| `time` | on | Live-ticking cumulative active turn time |

The Git HUD defaults on inside repositories: ` main ✓`, with only relevant counters (`+` staged, `~` modified, `?` untracked, `-` deleted, `↑` ahead, `↓` behind, `!` conflict/error). `●` covers otherwise-unclassified dirty state such as a changed submodule. Colors use the active theme's accent, success, warning, and error roles.

`nerdFont` defaults on for the `` branch icon; toggle it off to use the Unicode `⎇` fallback. Other optional extras default off: `cost`, `sessionElapsed`, `lastTurn`, and `pending`.

## Configure

```text
/statusline                         list settings
/statusline on                      enable the custom footer
/statusline off                     restore pi's built-in footer
/statusline toggle throughput       toggle a segment
/statusline toggle branch           toggle the Git HUD
/statusline toggle nerdFont         use the Unicode branch fallback
/statusline toggle sessionElapsed   show wall time in the time segment
/statusline toggle lastTurn         show the latest turn duration
```

Settings persist in `~/.pi/agent/statusline.json`.

## Provider applicability

| Data | Local models | Anthropic subscription | OpenAI Codex subscription | Other cloud/API key |
|---|:---:|:---:|:---:|:---:|
| Project, model, effort, context | ✓ | ✓ | ✓ | ✓ |
| Available usage bars | — | ✓ | ✓ | — |
| Throughput and time | ✓ | ✓ | ✓ | ✓ |

Anthropic OAuth restores the last limits captured in the current session, then updates them from response headers; a first run shows `5h` and `wk` placeholders. Codex fetches its current account limits and shows only the windows returned by the account, labeled by duration. Reset countdowns appear for every Claude or Codex window that reports a reset time; absent data is omitted rather than rendered as `—`.

## Throughput and time

`↑` is input tokens divided by the prompt-processing window from turn start to first streamed update. `↓` is output tokens divided by the generation window from first update to message end, so tool execution time is excluded. Both rates start at `0 t/s` and remain visible while idle. If either streaming window is unavailable, that direction falls back to its token count over the whole turn.

Each direction compares to its own recent same-model baseline: green at or above 90%, orange from 60–89%, and red below 60%. Until three samples are available it stays neutral; output at or below 15 t/s is always red. Changing models resets both rates and baselines.

Active time is the sum of turn durations and ticks live while a turn is running. The timer stops when pi settles, including interrupted or failed turns. Optional elapsed time is wall-clock time since the session loaded; optional last-turn time is the most recently completed turn duration.

## License

MIT
