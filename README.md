# @shvax/pi-statusline

A configurable, single-line footer for [pi](https://github.com/earendil-works/pi-mono). It uses the active pi theme for semantic colors, shows only the data available for the active model and provider, and drops lower-priority segments before truncating at narrow widths.

```text
📁 pi-statusline > 🤖 qwen2.5-coder > 🧠 medium > 🪟  55.0%/1.0M > ⚡ ↑ 0 t/s ↓ 0 t/s > ⏳ 12m34s
📁 pi-statusline > 🤖 claude-sonnet-4-5 > 🧠 high > 🪟  30.2%/200K > 5h (█▉) 23% wk (███▍) 41% > ⚡ ↑ 1.2k t/s ↓ 74 t/s > ⏳ 8m02s
```

The terminal renders these usage bars with rounded Nerd Font endcaps; the web-safe preview uses parentheses because npm and GitHub fonts do not include those glyphs. Their consumed fill is `success`, `warning`, or `error` from your selected pi theme; the empty portion is the terminal background.

## Install

```bash
pi install npm:@shvax/pi-statusline
```

Try a local checkout without installing it:

```bash
pi -e .
```

## Segments

Segments render in this order and disappear only when disabled or inapplicable.

| Segment | Default | Contents |
|---|---:|---|
| `project` | on | Current directory name |
| `model` | on | Active model id |
| `effort` | on | Thinking level; hidden for non-reasoning models |
| `context` | on | Context percent and window; hidden while usage is unknown |
| `session` | on | Anthropic and OpenAI Codex subscription 5-hour and weekly usage pills; shows `—` until values arrive |
| `throughput` | on | Latest prompt and generation token rates, independently speed-colored; starts at `0 t/s` |
| `time` | on | Live-ticking cumulative active turn time |

Optional extras default off: `branch` (with dirty `*`), `cost`, `sessionElapsed`, `lastTurn`, and `pending`.

## Configure

```text
/statusline                         list settings
/statusline on                      enable the custom footer
/statusline off                     restore pi's built-in footer
/statusline toggle throughput       toggle a segment
/statusline toggle branch           toggle an optional extra
/statusline toggle sessionElapsed   show wall time in the time segment
/statusline toggle lastTurn         show the latest turn duration
```

Settings persist in `~/.pi/agent/statusline.json`.

## Provider applicability

| Data | Local models | Anthropic subscription | OpenAI Codex subscription | Other cloud/API key |
|---|:---:|:---:|:---:|:---:|
| Project, model, effort, context | ✓ | ✓ | ✓ | ✓ |
| 5-hour and weekly bars | — | ✓ | ✓ | — |
| Throughput and time | ✓ | ✓ | ✓ | ✓ |

For Anthropic and OpenAI Codex OAuth subscriptions, the `5h` and `wk` labels are shown immediately. Their values are best-effort: unavailable rate-limit data retains `—`.

## Throughput and time

`↑` is input tokens divided by the prompt-processing window from turn start to first streamed update. `↓` is output tokens divided by the generation window from first update to message end, so tool execution time is excluded. Both rates start at `0 t/s` and remain visible while idle. If either streaming window is unavailable, that direction falls back to its token count over the whole turn.

Each direction compares to its own recent same-model baseline: green at or above 90%, orange from 60–89%, and red below 60%. Until three samples are available it stays neutral; output at or below 15 t/s is always red. Changing models resets both rates and baselines.

Active time is the sum of turn durations and ticks live while a turn is running. The timer stops when pi settles, including interrupted or failed turns. Optional elapsed time is wall-clock time since the session loaded; optional last-turn time is the most recently completed turn duration.

## License

MIT
