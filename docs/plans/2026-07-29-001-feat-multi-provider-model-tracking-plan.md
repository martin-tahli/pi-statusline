---
title: Multi-provider Model Tracking - Plan
type: feat
date: 2026-07-29
topic: multi-provider-model-tracking
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Multi-provider Model Tracking - Plan

## Goal Capsule

- **Objective:** Let pi-statusline users compare live available capacity across their configured model providers without switching models or sessions.
- **Product authority:** pi-statusline user requirements captured for work-1.1.
- **Open blockers:** Every visible quota row needs a provider-authorized live usage source. GLM additionally needs documented authorization for pi and the account's eligible plan before it can render live usage.

---

## Product Contract

### Summary

pi-statusline will add a default-on, registry-driven provider stack beneath the active-session line.
`/statusline` will open an interactive settings menu that discovers pi-configured providers, tracks them by default, and lets users control order and metric visibility.

### Problem Frame

A user with more than one subscription cannot currently compare account capacity without creating sessions or switching models.
The footer only exposes the active provider's data, so an exhausted account and an available alternative are not visible together when the decision is needed.

### Key Decisions

- **Configured pi providers define the available set.** A provider is available when pi's public model registry exposes at least one model for it with configured authentication. This excludes pi's entire catalog and extension-only provider registrations without usable authentication.
- **The provider stack is default-on.** Existing users receive the multi-provider capability after upgrade, and every currently available provider starts selected while only usable providers occupy footer rows.
- **The active-session line and provider rows have separate jobs.** Session-specific metrics remain on the first line. A provider's quota is removed from that line only while its selected provider row is actually visible.
- **Metric configuration cascades.** Shared row defaults apply to every provider, and a provider override changes only explicitly selected metrics until reset.
- **Usage access fails closed.** A provider row needs a live account-usage source callable with credentials pi already holds and permitted by that provider's documented terms. The feature never scrapes web UI or asks for separate credentials.

### Actors

- A1. **Multi-subscription pi user** — configures provider tracking and chooses an available account without switching sessions.
- A2. **pi agent** — supplies the runtime configured-provider set and the active session context.
- A3. **Provider account service** — exposes authorized account-usage data when available.

### Requirements

**Provider discovery and display**

- R1. The extension derives tracking choices from the unique providers represented by pi's auth-configured runtime models and exposes no full-catalog, extension-registered provider without configured authentication, or user-invented provider choices.
- R2. Multi-provider tracking is enabled by default after upgrade. All currently available providers start selected, and a provider newly available in a later session starts selected unless the user previously deselected it.
- R3. The footer keeps the active-session status line first and renders every usable selected provider as a distinct, single-line row beneath it in the user's saved order. Horizontal width adapts row contents without silently dropping a usable provider row.
- R4. Bare `/statusline` replaces the current settings-list output with an interactive settings menu that enables or disables the provider stack, selects providers, reorders selected providers, changes shared metrics, and manages provider overrides. Existing `/statusline on`, `off`, and `toggle <segment>` commands remain supported.
- R5. A provider that is active in the session does not duplicate quota metrics on the active-session line while that provider row is visible. If the stack is disabled, the provider is unselected, or its row is hidden, the active-session line retains applicable quota metrics.
- R6. Selection, order, and overrides persist across sessions. A temporarily unavailable provider retains its saved configuration and position; if it returns it resumes there, while a newly available provider follows R2.

**Metrics and availability**

- R7. Provider rows always identify their provider and offer shared defaults for the current quota metrics: usage bar/percentage and reset countdown when that source supplies them. Defaults are initially enabled.
- R8. A provider may override either metric independently. Every metric without an override continues to inherit the shared default, the menu can reset an override to inheritance, and a row with no enabled available metrics is hidden.
- R9. Each provider row uses that provider's live usage data and preserves provider-specific window labels and availability rather than fabricating a common quota value.
- R10. A selected provider with no configured account, expired access, missing permitted usage source, stale data, or unavailable live data is hidden from the footer until a fresh authorized result is available.
- R11. The settings menu communicates a sanitized latest reason a selected provider is hidden, including setup, authentication, source, plan-eligibility, or refresh status; it never exposes credentials or raw provider error bodies.

**Reliability, migration, and documentation**

- R12. Usage refresh runs independently of footer rendering. Every provider has a bounded refresh cadence, a documented maximum result age tied to that cadence, and a retry path; non-active providers are not refreshed on every turn, a result older than its maximum age is hidden as stale, and recovery restores a row automatically.
- R13. Configuration changes are atomic: canceling a menu change or a failed save preserves the previous runtime and persisted configuration.
- R14. Documentation explains the default-on provider stack, configured-provider discovery, ordering, shared defaults, sparse overrides, availability and hidden-row behavior, command compatibility, and provider-specific usage limitations.

### Key Flows

- F1. **Startup and discovery**
  - **Trigger:** pi starts a session with the extension enabled.
  - **Actors:** A1, A2.
  - **Steps:** The extension derives configured providers from the registry, reconciles them with saved selection/order/metric rules, starts bounded background refreshes, then renders the active-session line plus every selected provider with fresh usable data.
  - **Outcome:** The user sees comparable usable provider capacity without changing the active model.

- F2. **Configure the provider stack**
  - **Trigger:** A1 runs bare `/statusline`.
  - **Actors:** A1, A2.
  - **Steps:** The interactive menu shows configured providers, global metrics, inherited or overridden provider metrics, selection, order, and hidden-row health. The user confirms a change or cancels it.
  - **Outcome:** A confirmed change persists atomically; a canceled or failed change leaves the previous configuration intact.

- F3. **Provider becomes unavailable or usable**
  - **Trigger:** A provider account loses fresh authorized usage, or a later bounded refresh succeeds.
  - **Actors:** A2, A3.
  - **Steps:** The provider row disappears when no fresh result exists; the settings menu retains a sanitized reason. A successful refresh restores the row in its saved position without waiting for other providers.
  - **Outcome:** The footer stays uncluttered and responsive without concealing the configuration problem.

### Visualization

```mermaid
flowchart TB
  M[Pi auth-configured models] --> P[Unique configured providers]
  P --> S[/statusline interactive settings]
  S --> C[Saved selection, order, and metric rules]
  C --> F[Provider stack beneath active-session line]
  U[Fresh permitted provider usage] --> F
  X[Missing, stale, or unauthorized usage] --> H[Hidden row with menu health explanation]
```

### Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given pi exposes configured models for Anthropic, Codex, GLM, and another provider, while its catalog also contains unauthenticated providers, the settings menu lists only the four configured providers. On first use after upgrade all four are selected, and each with fresh usage appears beneath the active-session line.
- AE2. **Covers R2, R6.** Given the user deselected Codex and ordered GLM first, when Codex disappears from the configured set and later returns while a newly configured provider appears, Codex returns deselected in its old position and the new provider starts selected.
- AE3. **Covers R4, R7, R8, R13.** Given shared defaults show usage and reset time, when the user moves GLM first and disables only Codex's reset time, GLM appears first and Codex still inherits usage. Canceling a later change or encountering a save failure preserves those prior settings and on-disk configuration.
- AE4. **Covers R5.** Given Codex is active and its selected provider row is visible, its quota appears only on that row. When the stack is off or the Codex row is hidden, applicable quota returns to the active-session line.
- AE5. **Covers R9, R10, R11.** Given a selected configured provider has no permitted fresh usage source, when the footer renders it has no provider row and the settings menu gives a sanitized source or eligibility explanation.
- AE6. **Covers R12.** Given one selected provider times out while another returns usage, when the background refresh runs the responsive provider row updates, the failed row stays hidden, and footer rendering never waits for either request. A result older than its documented maximum age also hides until a fresh result arrives, and a later successful bounded retry restores the hidden row.
- AE7. **Covers R14.** Given the feature ships, the README documents the interactive bare command, compatible argument commands, default-on migration, configured-provider filtering, metric inheritance, ordering, and unavailable-row behavior.

### Scope Boundaries

- No hard-coded fixed provider catalog, arbitrary user-defined provider protocol, or synthetic cross-provider quota metric.
- No web-UI scraping, credentials outside pi's configured authentication, or display of stale/unavailable quota as live capacity.
- Generic active-session metrics remain on the first line; the stack is for provider-account tracking.

### Dependencies / Assumptions

- Pi's public `ModelRegistry.getAvailable()` surface supplies the auth-configured models from which configured providers can be derived.
- Each visible quota row depends on a provider-permitted live usage source callable with credentials pi already holds.
- Z.AI documents its GLM quota plugin for Claude Code Personal plans. GLM can render only after planning verifies an equivalent documented authorization for pi and the user's plan.

### Sources / Research

- `node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts` — public `getAvailable()`, provider auth, and display-name surfaces.
- `extensions/statusline.ts` — current footer renders a single active-provider quota area and contains Anthropic/Codex refresh paths.
- `src/config.ts` — current persisted settings are simple global segment/extra toggles.
- `src/ratelimit.ts` — current rate-limit data is provider-specific.
- `README.md` — current provider applicability and `/statusline` behavior.
- https://docs.z.ai/devpack/extension/usage-query-plugin — official GLM Coding Plan usage plugin documentation; it limits that plugin to Claude Code Personal plans.
- https://docs.z.ai/devpack/usage-policy — official GLM Coding Plan usage restrictions and subscription context.

### wo:divergent-analysis

- **Inversion and adversary — `anthropic/claude-opus-5`:** Retained independent refresh/render isolation and provider-source provenance; rejected stale fallback and a pointer-only active line because unavailable rows must hide and the active-session line remains intact.
- **3am operator — `openai-codex/gpt-5.6-sol`:** Retained safe hidden-row health in settings and atomic configuration persistence; rejected a footer health ledger because it would violate the chosen uncluttered hidden-row behavior.
