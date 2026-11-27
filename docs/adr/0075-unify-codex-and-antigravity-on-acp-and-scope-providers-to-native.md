# ADR 0075: Unify Codex and Antigravity on ACP and Scope ADS Providers to Native Runtime

- **Status**: Accepted
- **Date**: 2026-11-28
- **Issue**: #730
- **Related**: [ADR 0028](0028-cross-runtime-session-continuation-via-history-injection.md), [ADR 0046](0046-native-runtime-as-default.md), [ADR 0066](0066-runtime-unified-actions-reviewer.md), [ADR 0072](0072-generic-acp-v1-runtime-kernel.md), [ADR 0073](0073-agy-driver-and-acp-prompt-runner.md), [ADR 0074](0074-dynamic-runtime-autoprobing-and-multi-account-switcher.md)

## Context

After Phase 2A (ADR 0073) and Phase 2B (ADR 0074), ADS ran Antigravity (`agy` / `agy:<account_id>`) over the shared ACP v1 kernel (`ads-acp`), while Codex (`codex`) still depended on the bespoke `ads-codex-app-server` crate (`codex app-server`), dynamic provider injection, and custom prompt/reviewer loops. Meanwhile, user-configured **Settings → Providers** models could bleed into the `codex` runtime selector even though ACP runtimes manage their own dynamic model/reasoning catalogs and persistent CLI credentials.

Maintaining two parallel external-agent transport stacks increased complexity and blurred the boundary between Native API-key providers and ACP-managed external runtimes.

## Decision

1. **Scope ADS Settings → Providers to the `native` Runtime**:
   - `GET /api/models` (`routes/models.rs`) unconditionally scopes Provider-backed DB conversation models (`provider_id` present) to `allowedAgents: ["native"]` and `runtime: "native"`, and strips `codex` / `agy` / `agy:*` from legacy DB-seeded rows (falling back to `["native"]` when empty while preserving non-ACP agents such as `claude`).
   - `supportsAgentModel` (`client/src/lib/model_agent.ts`) binds Provider-backed models (`providerId` present) and `runtime: "native"` models exclusively to `native`, while `codex` and `agy*` consume dynamically discovered ACP models.
   - `ModelManager.vue` and `AntigravityAccountsPanel.vue` copy explicitly communicate that Providers & model sync serve the **Native** runtime while **Codex** and **Antigravity** discover models via ACP under **Runtimes**.

2. **Unify Codex on the Generic ACP v1 Kernel (`ads-acp::CodexDriver`)**:
   - Added `CodexDriver` (`rust-server/crates/ads-acp/src/drivers/codex.rs`) implementing `AcpDriver`, launching `codex-acp` (`ADS_CODEX_ACP_BIN`, default `codex-acp`, e.g. `@agentclientprotocol/codex-acp`) over stdio.
   - `CodexDriver` reuses persistent `$CODEX_HOME` credentials (`auth.json` / `OPENAI_API_KEY` / `CODEX_API_KEY`) without forcing re-login across turns, runtime switches, or daemon restarts, probes models and reasoning efforts via ACP `initialize` + `session/new`, disambiguates model ID collisions with a `codex:` prefix, coerces session modes, classifies auth errors, and normalizes command tool calls and `update_plan` updates into the shared ACP streaming pipeline.
   - Wired `codex` in `RuntimeRegistry` (`ads-http::runtimes`) through `AcpPromptRunner` + `CodexDriver` and added `discovered_codex_models` / `discovered_acp_models` to `GET /api/models` (with `App.vue` refreshing `/api/models` whenever `codex` or `agy*` transitions to ready).

3. **Preserve ADR 0066 Actions Reviewer Parity via `ads-acp::run_acp_review`**:
   - Added `run_acp_review` and `ReviewVerificationPermissionHandler` in `rust-server/crates/ads-acp/src/reviewer.rs`, enforcing read-only file boundaries, mutating `git`/`gh`/`cargo fmt`/`apply_patch` command rejection, `$CARGO_HOME/bin` `PATH` augmentation, and ADR 0060 verification command capture over any `AcpDriver`.
   - Updated `ads-server` to wire `ReviewQueueOptions.reviewer` through `run_acp_review` + `CodexDriver` when `ADS_AGENT_RUNTIME` opts into Codex.

4. **Retire Legacy `ads-codex-app-server`**:
   - Removed the bespoke `rust-server/crates/ads-codex-app-server` crate from the Rust workspace and `ads-server` dependencies now that `CodexDriver` + `AcpPromptRunner` + `run_acp_review` achieve full chat, scheduling, streaming, history continuation (ADR 0028), and Actions Reviewer (ADR 0066) parity.

## Consequences

- Both Codex and Antigravity share one ACP v1 transport, supervision, config-alignment, permission-gating, streaming, and review stack (`ads-acp`).
- Settings → Providers has a crisp, unambiguous contract dedicated to the `native` runtime.
- Switching between `native`, `codex`, and `agy*` preserves cross-runtime history continuation (ADR 0028) and persistent credentials without forced re-login.
- Deployments opting into Codex require the ACP adapter (`codex-acp` / `@agentclientprotocol/codex-acp` or `ADS_CODEX_ACP_BIN`); when absent, `RuntimeRegistry` cleanly marks `codex` unavailable without blocking `native` or `agy*`.
