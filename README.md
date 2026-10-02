# @shvax/pi-statusline

A configurable footer for [pi](https://github.com/earendil-works/pi-mono). Start with a compact view, then enable the detail you need. Missing data is omitted or marked unavailable—not invented as zero. Lower-priority segments disappear first on narrow terminals; quota compaction prioritizes the most-used window, including exhausted limits.

## Install

```bash
pi install npm:@shvax/pi-statusline
```

Try a local checkout: `pi -e .`

## Configure

Run `/statusline` in Pi's interactive terminal. The command takes no arguments; RPC/JSON/print mode cannot open this settings UI.

| Section | Controls |
|---|---|
| **Statusline & Providers** | Footer/tracking toggles, provider selection/order, manual refresh, active-model overrides, per-window visibility, labels, bars, percentages and resets. Provider detail includes source, freshness, last successful refresh, absolute reset times and sanitized failure reasons. |
| **Display** | Presets, Off/Auto/Always visibility, provider scope, quota format, extras, ordering, narrow-drop priorities, separators, bar styling and thresholds. |
| **Icons** | Emoji, Unicode, ASCII, Nerd Font, minimal or none; symbol and provider-icon overrides. |

Edits affect a draft and its preview; only **Save** writes them. Escape with unsaved edits offers Save / Discard / Cancel. Save writes the file before activating settings, so a write failure leaves live settings unchanged. Settings persist in `~/.pi/agent/statusline.json`. Legacy documents migrate on load and become durable on the next save. Future-version documents render through a safe compatible view but remain read-only and are not overwritten.

### Progressive detail

Apply a preset in **Display**, then customize it:

- **Minimal:** model, context and critical quota warnings.
- **Balanced:** project/Git, model, effort, context, active-provider percentages; speed and active time appear while working.
- **Detailed:** selected-provider rows, bars and percentages, available used/remaining amounts, token/cache totals, estimated cost, timing and other extensions' status messages.

Presets replace presentation choices (including window/active-model overrides), not provider selections or refresh policies. Fresh installs use active-provider scope, quota bars and automatic speed/time visibility. Existing explicit boolean segment choices remain supported.

**Auto** hides idle speed/time; enabling elapsed or last-turn extras reveals that timing. Auto quota shows only warning/critical usage. **Always** keeps applicable, available information visible; it never manufactures unavailable measurements.

Provider scope is **active** or **selected**. Quota format is **percent**, **bar** (bar + optional percentage), or **detailed** (adds available used/remaining amounts). Percentages are explicitly labeled **used**. Bar, percentage and reset controls remain independent.

## Segments

| Segment | Information |
|---|---|
| Project | Current directory and optional Git branch/HUD |
| Model | Active model, optionally estimated session cost |
| Effort | Thinking level, when applicable |
| Context | Context utilization/window, when available |
| Session | Available provider quota windows or a sanitized availability notice |
| Throughput | Live generation rate, local prompt rate, or hosted API token ledger |
| Time | Active turn time, optionally elapsed and last-turn time |

Git shows ahead/behind counts, dirty-file counts and explicit merge conflicts. A clean tick appears only when there are no changes, conflicts or ahead/behind counts. Git polling continues independently of turns and survives opening/closing settings.

The footer's context defaults are **80% warning / 95% critical**, based on the model's context-window utilization. Bar thresholds are separately configurable and also govern truecolor rendering.

Extras include cost, elapsed time, last-turn time, pending work and **other extensions' status messages**. They default off; Git branch defaults on. ASCII uses ASCII built-in indicators and bars; custom labels/symbols and model/project names retain their own text. Icons **none** removes built-in segment/provider icons.

## Providers and freshness

The Providers screen lists Pi's available authenticated models, preserving saved selection, order and overrides. New providers are selected automatically, but active-only scope avoids displaying or polling every account. Selected scope enables simultaneous rows for selected providers. A visible active-provider row suppresses duplicate quota on the main line.

| Provider | Quota source |
|---|---|
| Anthropic OAuth | Subscription usage endpoint and response headers; available 5-hour/weekly windows |
| OpenAI Codex | ChatGPT account usage; windows labeled by reported duration |
| OpenRouter | `GET /api/v1/key` with Pi's regular API key; finite **key budget**, not account-wide credits. Unlimited/missing limits do not become a fake percentage. Detailed mode shows available USD used/remaining amounts. |
| Z.AI | Best-effort, undocumented `GET https://api.z.ai/api/monitor/usage/quota/limit` |
| Other providers | Listed with a sanitized unavailable reason when no quota adapter exists |

Z.AI windows have neutral `quota1`, `quota2`, … labels in response order. Reset times cannot reliably distinguish a five-hour window from a weekly window. You can rename them, but the endpoint and its identities remain best-effort and may change without notice.

A cross-process cache lives at `~/.pi/agent/statusline/provider-usage/`. Cached results retain the original successful-fetch timestamp and display `cached Nm`; fallback never renews their age. The default maximum age is five minutes. Expired data is hidden or shown as unavailable according to the missing-data policy. Authorization denials invalidate cached quotas. HTTP 429 applies shared increasing backoff.

Polling honors enabled/scope settings and provider refresh/cache policies. Disabling optional provider tracking does not disable the active session's quota; disable its session segment or active refresh as well if unwanted. No background fetches occur with the footer disabled. The polling cadence is ten seconds; provider intervals may be longer, with an additional one-minute Anthropic endpoint floor. Manual refresh remains subject to shared cache freshness and rate-limit backoff.

Settings JSON supports provider defaults and per-provider `refresh` overrides: `refreshIntervalMs`, `maxCacheAgeMs`, `useCache`, `keepAfterFailure`, `refreshWhileActive`, `refreshDisabledProvider`, and a separate per-provider `missingDataPolicy`. The default missing-data policy permits bounded cached fallback; `hide` suppresses missing rows, while `na`/`warning`/`provider-name` show availability notices without reusing failed-refresh data. Credentials are always obtained from Pi, never stored in statusline settings.

## Throughput and time

- **Local models:** prompt-processing `↑` and generation `↓` rates, when measured. IPv4/IPv6 loopback and LAN endpoints are recognized.
- **Hosted API providers:** with throughput set to Always, idle output shows cumulative reported session input/output tokens and available estimated cost. Cache reads/writes are included in input; Detailed additionally breaks them out.
- **Subscriptions:** idle speed is omitted; quota represents the available budget.
- **During generation:** live output rates use a character-based estimate and carry **`~`**. Provider-reported counts replace estimates after the turn. Missing reported counts use explicitly marked estimates rather than fake zero rates.
- **During tools:** the indicator says **tools**; generation timing stops at message end instead of making speed decay throughout tool execution.

`~$` cost is a token-price estimate, not a provider invoice. Missing cost is omitted. Rate colors compare to recent same-model measurements; low output rates (15 t/s or below) are red. Model changes reset rates/baselines.

Active time sums turn durations, including tool work, and stops on settle/interruption. Elapsed time measures wall-clock time since session load. Optional elapsed time continues ticking at idle.

## Development

```bash
npm test
npm run typecheck
```

Provider tests use synthetic responses. Passing tests do not establish live authenticated endpoint accuracy; Z.AI is especially subject to upstream changes.

## License

MIT
