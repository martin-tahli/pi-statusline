# @shvax/pi-statusline

A configurable, single-line footer for [pi](https://github.com/earendil-works/pi-mono). It shows only the data available for the active model and provider, and truncates cleanly to the terminal width.

```text
pi-statusline · qwen2.5-coder · medium · 55.0%/1.0M · ↑ 850 t/s ↓ 62 t/s · ⏱ 12m34s
pi-statusline · claude-sonnet-4-5 · high · 30.2%/200K · 5h [██░░░░░░] 23% · wk [███░░░░░] 41% · ↑ 1.2k t/s ↓ 74 t/s · ⏱ 8m02s
```

## Install

```bash
pi install npm:@shvax/pi-statusline
```

Try a local checkout without installing it:

```bash
pi -e .
```

## Segments

Segments always render in this order and disappear when disabled or unavailable.

| Segment | Default | Contents |
|---|---:|---|
| `project` | on | Current directory name |
| `model` | on | Active model id |
| `effort` | on | Thinking level; hidden for non-reasoning models |
| `context` | on | Context percent and window; hidden while usage is unknown |
| `session` | on | Anthropic subscription 5-hour and weekly usage bars |
| `throughput` | on | Latest prompt and generation token rates |
| `time` | on | Cumulative active turn time |

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

| Data | Local models | Anthropic subscription | Other cloud/API key |
|---|:---:|:---:|:---:|
| Project, model, effort, context | ✓ | ✓ | ✓ |
| 5-hour and weekly bars | — | ✓ when unified headers are exposed | — |
| Throughput and time | ✓ | ✓ | ✓ |

Session bars are best-effort: transports that do not expose both `anthropic-ratelimit-unified-5h-utilization` and `anthropic-ratelimit-unified-7d-utilization` headers show no bars.

## Throughput and time

`↑` is input tokens divided by the prompt-processing window from turn start to first streamed update. `↓` is output tokens divided by the generation window from first update to message end, so tool execution time is excluded. The latest result remains visible while idle.

Active time is the sum of completed turn durations. It updates at turn boundaries rather than using a polling timer. Optional elapsed time is wall-clock time since the session loaded; optional last-turn time is the most recently completed turn.

## License

MIT
