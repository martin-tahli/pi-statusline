# @shvax/pi-statusline

A configurable, single-line footer for [pi](https://github.com/earendil-works/pi-mono). It uses the active pi theme for semantic colors, shows only the data available for the active model and provider, and drops lower-priority segments before truncating at narrow widths.

```text
📁 pi-statusline  main ✓ > 🤖 qwen36-coder > 🧠 medium > 🪟  55.0%/1.0M > ⚡↑1.2k ↓74 t/s > ⏳ 12m34s
📁 pi-statusline  main ↑2 > 🤖 claude-sonnet-5 > 🧠 high > 🪟  30.2%/200K > 5h ╺━━────────╴ 23% ↻2h14m wk ╺━━━━──────╴ 41% ↻4d6h > ⏳ 8m02s
📁 pi-statusline  main ✓ > 🤖 gpt-5 > 🧠 high > 🪟  12.0%/400K > 🧾 ↑128K ↓34K $0.512 > ⏳ 3m20s
```

The first line is a local model (live token rates), the second an Anthropic subscription (quota bars, no throughput at idle), the third an API-key provider (running token totals and session cost). See [Throughput and time](#throughput-and-time).

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

At full width, segments render in the order below. When that line no longer fits, segments switch to compact priority order—`context`, `session`, `model`, `effort`, `project`, `throughput`, then `time`—and the lowest-priority available segment disappears first.

| Segment | Default | Contents |
|---|---:|---|
| `project` | on | Current directory name and compact Git HUD |
| `model` | on | Active model id |
| `effort` | on | Thinking level; hidden for non-reasoning models |
| `context` | on | Context percent and window; green below 120K tokens, orange from 120K, red from 170K (75%/90% also warn for smaller windows) |
| `session` | on | Available subscription usage windows and reset countdowns; Codex labels come from the account's current limits |
| `throughput` | on | Token throughput, adapted to how the model is billed — live `↑/↓` rates, a running `🧾` token/cost ledger, or nothing (see below) |
| `time` | on | Live-ticking cumulative active turn time |

The Git HUD defaults on inside repositories: `main ✓`. It shows `↓` incoming/behind and `↑` outgoing/ahead counts; `✓` means neither is pending. Local working-tree changes are intentionally ignored. Colors use the active theme's accent, success, warning, and error roles.

`nerdFont` defaults off, so the branch name has no leading icon; toggle it on for the `` Nerd Font icon. Other optional extras default off: `cost` (appends session `$cost` to the model segment), `sessionElapsed`, `lastTurn`, and `pending`.

## Configure

```text
/statusline                         list settings
/statusline on                      enable the custom footer
/statusline off                     restore pi's built-in footer
/statusline toggle throughput       toggle a segment
/statusline toggle branch           toggle the Git HUD
/statusline toggle nerdFont         toggle the Nerd Font branch icon
/statusline toggle sessionElapsed   show wall time in the time segment
/statusline toggle lastTurn         show the latest turn duration
```

Settings persist in `~/.pi/agent/statusline.json`.

## Provider applicability

| Data | Local models | Anthropic subscription | OpenAI Codex subscription | Other cloud/API key |
|---|:---:|:---:|:---:|:---:|
| Project, model, effort, context | ✓ | ✓ | ✓ | ✓ |
| Available usage bars | — | ✓ | ✓ | — |
| Live token rates (`↑/↓`) | ✓ | — | — | — |
| Token totals + session cost | — | — | — | ✓ |
| Streaming `↓` speed pulse | ✓ | ✓ | ✓ | ✓ |
| Time | ✓ | ✓ | ✓ | ✓ |

Anthropic OAuth fetches its current `5h` and `wk` limits when the session starts, then updates them from response headers. Codex fetches its current account limits and shows only the windows returned by the account, labeled by duration. Reset countdowns appear for every Claude or Codex window that reports a reset time; absent data is omitted rather than rendered as `—`.

## Throughput and time

The `⚡` segment adapts to how the active model is billed, because a token rate does not mean the same thing in every case:

- **Local models** (loopback/LAN endpoint) show live `↑`/`↓` token rates. `↓` is output tokens over the generation window (first update → message end, so tool execution time is excluded); `↑` is the prompt-processing rate (input tokens over turn start → first update). Both start at `0 t/s` and stay visible while idle. If the generation window is unavailable, `↓` falls back to output tokens over the whole turn.
- **API-key providers** show a running ledger while idle — `🧾 ↑<input> ↓<output> $<cost>` — cumulative session input and output tokens (cached and cache-write tokens folded into input) and total session cost. A per-token rate over a network is just request latency plus prompt caching, so it is dropped in favour of what you are actually spending.
- **Subscription providers** (Anthropic OAuth, OpenAI Codex) show nothing at idle; the `session` usage bars already track the only budget that matters — your quota window.
- **While a turn streams**, every hosted provider shows a live `↓ t/s` speed pulse so you can see generation is progressing and how fast.

Rate coloring compares each direction to its own recent same-model baseline: green at or above 90%, orange from 60–89%, and red below 60%. Until three samples are available it stays neutral; output at or below 15 t/s is always red. Changing models resets both rates and baselines.

Active time is the sum of turn durations and ticks live while a turn is running. The timer stops when pi settles, including interrupted or failed turns. Optional elapsed time is wall-clock time since the session loaded; optional last-turn time is the most recently completed turn duration.

## License

MIT
