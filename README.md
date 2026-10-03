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
| **Statusline & Providers** | Compact provider list; open a provider for visibility overrides, refresh/cache policy, and individual quota windows. Window controls include labels, bars, percentages, resets, zero visibility, and available USD amounts. Source and freshness appear in the detail screens. |
| **Display** | Eight small categories: presets, visibility, extras, ordering/provider rows, separators, bars, context warnings, and refresh/missing data. |
| **Icons** | Style/segment symbols (including time and token totals), plus a separate screen for each provider icon. Emoji, Unicode, ASCII, Nerd Font, minimal, none, and custom styles are supported. |

Use arrows to navigate, Enter to open a category, and Escape to go back. Home/End jump to the first/last control; Page Up/Down move eight rows. Text controls accept case-sensitive characters and emoji; Backspace removes a whole character. **Ctrl+S saves and closes from any screen.**

Edits affect a draft and its preview; only **Save** writes them. Escape with unsaved edits offers Save / Discard / Cancel. Save writes the file before activating settings, so a write failure leaves live settings unchanged. Settings persist in `~/.pi/agent/statusline.json`. Legacy documents migrate on load and become durable on the next save. Future-version documents render through a safe compatible view but remain read-only and are not overwritten.

### Progressive detail

Apply a preset in **Display**, then customize it:

- **Minimal:** model, context and critical quota warnings.
- **Balanced:** project/Git, model, effort, context, active-provider percentages; local speed and active time appear while working.
- **Detailed:** selected-provider rows, bars and percentages, available used/remaining amounts, token/cache totals, estimated cost, timing and other extensions' status messages.

Presets replace presentation choices (including window/active-model overrides), not provider selections or refresh policies. Fresh installs use active-provider scope, quota bars and automatic local-speed/time visibility. Existing explicit boolean segment choices remain supported.

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
| Throughput | Approximate local generation/prompt rates, or reported hosted API token totals; no cloud speed estimate |
| Time | Active turn time, optionally elapsed and last-turn time |

Git shows ahead/behind counts, dirty-file counts and explicit merge conflicts. A clean tick appears only when there are no changes, conflicts or ahead/behind counts. Git polling continues independently of turns and survives opening/closing settings.

The footer's context defaults are **80% warning / 95% critical**, based on the model's context-window utilization. Bar thresholds are separately configurable and also govern truecolor rendering.

Extras include cost, elapsed time, last-turn time, pending work and **other extensions' status messages**. They default off; Git branch defaults on. Provider rows can be separate, inline, or wrapped; placement (above/below) and maximum width are configurable. Quota-window, inline-provider and label separators are honored. Per-provider context thresholds can also be set in JSON.

ASCII uses ASCII built-in indicators and bars; custom labels/symbols and model/project names retain their own text. Icons **none** removes built-in segment/provider icons.

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

A cross-process cache lives at `~/.pi/agent/statusline/provider-usage/` (or under `PI_CODING_AGENT_DIR`). Standalone quota cache entries are isolated by a SHA-256 credential fingerprint; raw credentials are never written to this cache. Older provider-only caches and unscoped session-history quota entries are ignored. A rotated credential may need a fresh fetch. Cached results retain the original successful-fetch timestamp and display their age as `Nm`; fallback never renews their age. The default maximum age is five minutes. Expired data is hidden or shown as unavailable according to the missing-data policy. Authorization denials invalidate cached quotas. HTTP 429 applies shared increasing backoff.

Polling honors enabled/scope settings and provider refresh/cache policies. Disabling optional provider tracking does not disable the active session's quota; disable its session segment or active refresh as well if unwanted. No background fetches occur with the footer disabled. The polling cadence is ten seconds; provider intervals may be longer, with an additional three-minute Anthropic endpoint floor. Manual refresh remains subject to shared cache freshness and rate-limit backoff.

Refresh controls are available in Display and provider detail screens. Settings JSON also supports provider defaults and per-provider `refresh` overrides: `refreshIntervalMs`, `maxCacheAgeMs`, `useCache`, `keepAfterFailure`, `refreshWhileActive`, `refreshDisabledProvider`, and a separate per-provider `missingDataPolicy`. The default missing-data policy permits bounded cached fallback; `hide` suppresses missing rows, while `na`/`warning`/`provider-name` show availability notices without reusing failed-refresh data. Credentials are always obtained from Pi, never stored in statusline settings.

## Multiple accounts

Authentication, adding/removing accounts, token rotation and switching remain owned by the provider addon—not Statusline.

**Claude Plus / `DrunkenDonkey80/pi-provider-claude-ex`:** Statusline automatically reads its pool metadata and shared usage cache from Pi’s agent directory. No extra usage requests or token rotations are made. Account UUID + organization UUID identifies each subscription; the active account is matched to Pi’s actual credential, not guessed from a pool pin. Token fingerprints are the conservative fallback when identity metadata is absent. Statusline rereads the source every two seconds while enabled. It does not copy pool credentials into settings, session history, or its cache.

- Add accounts using the addon’s `/login anthropic` → `/claude-pool-add <label>` flow.
- In **Display → Order & provider rows**, set **Accounts per provider** to **selected** to show multiple accounts. **active** is the compact default.
- In **Statusline & Providers → provider → Accounts**, select/hide accounts and set display labels. `*` marks the active account within that provider.
- Provider scope still chooses which providers appear; account scope chooses accounts within each provider. Quota-window formatting is shared by a provider’s accounts.
- Pooled quota snapshots include available 5-hour, weekly and per-model weekly windows. Their original timestamps are retained. Refresh them through the addon; Statusline’s **Reload account snapshots** rereads rather than spends the provider’s request budget.

### Integration for other account addons

Publish a complete, credential-free replacement snapshot on Pi’s event bus when accounts, selection, or usage change. IDs must be stable across token rotation and distinct across organizations/subscriptions. Do not include tokens, API keys or raw error messages.

```ts
pi.events.emit("statusline:accounts", {
  provider: "your-provider-id",
  source: "Your account addon",
  accounts: [{
    id: "stable-account-and-organization-id",
    label: "Work",
    active: true, // at most one active account per provider
    updatedAt: Date.now(), // actual successful usage-fetch time, never repaint time
    windows: [{ key: "weekly", label: "wk", used: 0.42, resetAt: resetEpochMs }],
    // unavailable: true, // use on explicit account/auth denial
  }],
});
```

Statusline emits `statusline:accounts:request` at startup and on a snapshot reload (`{ provider }` for a targeted request). Respond with the current snapshot; the addon decides whether any network refresh is warranted. An empty `accounts` array clears that provider’s account rows. While an account source owns a provider, Statusline does not independently fetch its quotas. Unsupported addons need to implement this interface; Statusline does not automatically discover arbitrary credential stores.

## Throughput and time

- **Local models:** approximate client-observed prompt `↑` and output `↓` rates, marked **`~`**. They include client latency and are not server-side inference benchmarks. IPv4/IPv6 loopback and private IPv4 LAN endpoints are recognized.
- **Hosted API providers:** with throughput set to Always, output shows cumulative reported session input/output tokens and available estimated cost. Cache reads/writes are included in input; Detailed additionally breaks them out.
- **Subscriptions:** idle speed is omitted; quota represents the available budget.
- **Cloud generation:** speed is deliberately omitted. Stream events contain chunks, not token arrival times; characters divided by four cannot reliably measure cloud token speed. Reported token totals remain available.
- **Local generation:** live output uses characters divided by four; completed turns use reported counts where available. Rates remain marked approximate because timing is client-observed.
- **During tools:** the indicator says **tools**; generation timing stops at message end instead of making speed decay throughout tool execution.

`~$` cost is a token-price estimate, not a provider invoice. Missing or partially reported cost is omitted rather than presented as a complete total. Rate colors compare to recent same-model measurements; low output rates (15 t/s or below) are red. Model changes reset rates/baselines.

Active time sums turn durations, including tool work, and stops on settle/interruption. Elapsed time measures wall-clock time since session load. Optional elapsed time continues ticking at idle.

## Development

```bash
npm test
npm run typecheck
```

Provider tests use synthetic responses. Passing tests do not establish live authenticated endpoint accuracy; Z.AI is especially subject to upstream changes. Account-source integrations are read-only and depend on the addon’s snapshot freshness. Unknown, denied, future-dated or expired snapshots never become a made-up zero quota.

## License

MIT
