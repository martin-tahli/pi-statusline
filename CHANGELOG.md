# Changelog

## 0.11.0

- Group settings into small category menus; add direct Ctrl+S saving, page navigation, readable provider summaries, Unicode-safe editing, and time/token-ledger icon controls.
- Track multiple accounts within a provider without managing authentication. Discover Claude Plus pool accounts through a read-only bridge; expose a credential-free snapshot event for other addons. Support active/selected account scope, per-account visibility and labels.
- Isolate standalone quota caches by credential fingerprint. Ignore legacy provider-only caches and unscoped session quota history. Reuse the Claude pool's quota cache without independent polling; enforce original timestamps and expiry.
- Remove unreliable cloud token-speed estimates. Keep reported API token totals and explicitly approximate local rates. Omit incomplete cost totals.
- Fix response-header quota races, account/model switches, missing-data notices, per-provider context thresholds, narrow-width budgeting, and previously ignored row/separator/window settings.
- Harden display-string and dictionary-key validation. Keep Codex quota credentials on the fixed account-service origin. Use English application text and fixtures.

Verification: unit/integration tests and typechecking; isolated Pi terminal checks at wide and narrow sizes with synthetic account data. Authenticated provider endpoint accuracy is not established by synthetic tests.
