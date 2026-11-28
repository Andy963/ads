# ADR 0078: Host-Owned `review_action` Agent Handoff for ACP Runtimes and User-Initiated Actions Turns

- **Status**: Accepted
- **Date**: 2026-11-28
- **Issue**: #758
- **Related**: [ADR 0048](0048-two-role-architecture-with-actions-review-queue.md), [ADR 0050](0050-review-verdicts-published-through-issue.md), [ADR 0054](0054-review-verdicts-hand-off-through-durable-agent-messages.md), [ADR 0059](0059-complete-review-rework-declarations.md), [ADR 0061](0061-rust-agent-handoff-boundary.md), [ADR 0072](0072-generic-acp-v1-runtime-kernel.md), [ADR 0075](0075-unify-codex-and-antigravity-on-acp-and-scope-providers-to-native.md)

## Context

ADS coordinates coding and PR review through two peer agents: **Acopilot** (implementation and rework) and the **Actions Reviewer** (isolated read-only verification and PR review). Previously, `review_action` was wired exclusively into `NativePromptRunner` (`native_options.action_tools_factory`) and hidden across all `WEB_ACTIONS_NAMESPACE` turns. As a result:

1. ACP runtimes (`codex` via `codex-acp` and `agy*` via `agy acp`) had no path to enqueue PR reviews into `ReviewQueue` or submit post-`REJECT` ADR 0059 `rework` declarations, breaking the core Acopilot ↔ Reviewer loop on Codex and Antigravity.
2. When a human user proactively initiated a prompt in the Actions lane (`WEB_ACTIONS_NAMESPACE` `LaneTurnKind::UserPrompt`) to request a PR review, neither Native nor ACP exposed `review_action`.
3. Wrapping `review_action` as an MCP server would mismodel an internal peer-agent handoff as an external tool server, leak or bounce server-verified lane identity (`auth_user_id`, `project_id`, `lane_generation`, `chat_session_id`, `workspace_root`) across subprocess boundaries, and couple core ADS workflow correctness to driver-specific MCP transport support.

## Decision

Expose `review_action` across both Native and ACP runtimes via an **in-process, host-owned agent handoff boundary** with zero MCP servers:

1. **Shared Server-Enforced Scope (`allows_review_action_for_turn`)**:
   - **Allowed**: `WEB_ACOPILOT_NAMESPACE` (`UserPrompt` and `AgentHandoff` turns) and `WEB_ACTIONS_NAMESPACE` human-initiated `UserPrompt` turns.
   - **Forbidden**: Non-user-initiated turns in `WEB_ACTIONS_NAMESPACE` (`AgentHandoff`, `Scheduler`), `"scheduler"` turns, and automated queued `ReviewQueue` Reviewer executions (`run_default_reviewer` / `run_acp_review`), which never receive `ActionToolsFactory` and remain strictly read-only.
   - Both `ads-actions::review_action_tools_factory`, `ads-native::NativePromptRunner`, and `ads-acp::AcpPromptRunner` enforce this aligned rule.
2. **Unified `ActionToolsFactory` Wiring (`ads-acp`, `ads-http`, `ads-server`)**:
   - Add `action_tools_factory: Option<ActionToolsFactory>` to `AcpPromptRunnerConfig` and `RuntimeRegistryConfig`.
   - `ads-server` passes the same `review_action_tools_factory(Arc::clone(&review_queue))` instance to `NativePromptRunnerOptions` and `RuntimeRegistryConfig`, which propagates it to `codex`, host-default `agy`, and every persisted or dynamically created isolated `agy:<account_id>` runner.
   - All workspace/branch/head resolution, authenticated lane identity, and ADR 0059 `rework` validation execute strictly in-process inside `ads-server` from the server-verified `LaneTurn`.
3. **Host-Intercepted In-Band Handoff Envelope & Bounded Repair Loop (`ads-acp/src/review_handoff.rs`)**:
   - Authorized ACP turns receive concise `[Review Action Handoff Protocol]` instructions (bootstrapped per session and reinforced on `AgentHandoff` wakes) specifying a fenced ```` ```ads-review-action ```` JSON block (`{}` for initial review / operational retry, or `{"rework": {...}}` with all ADR 0059 fields after `REJECT`; `<<<tool.review_action>>>` is also accepted as a compatible alias).
   - `AcpPromptRunner` strips raw handoff blocks from visible prose and assistant phases, executes `ActionTools::review_action_with_arguments` in-process, and emits visible `"command"` (`review_action`) and structured `"review_action_handoff"` events plus a formatted acknowledgement summary in output/history.
   - If argument parsing or `ReviewQueue::dispatch` validation fails (for example, missing or mismatched ADR 0059 `rework` fields), `AcpPromptRunner` feeds the exact validation error back into the same live ACP session for up to `MAX_REVIEW_HANDOFF_REPAIR_ROUNDS` (2) bounded repair rounds so the agent can correct the declaration without silently dropping the dispatch.
   - In user-initiated Actions lane turns on ACP, the session remains in read-only `SessionMode::Plan` (`AutoDenyPermissionHandler`) while still allowing the host-owned `review_action` handoff.

## Consequences

- Acopilot on `native`, `codex`, and all `agy*` runtimes now share identical `ReviewQueue` dispatch, deduplication, and ADR 0059 rework validation invariants without any MCP server dependency.
- Human users can trigger PR reviews directly from the Actions lane in both Native and ACP runtimes without compromising read-only workspace isolation or automated Reviewer boundaries.
- Invalid post-`REJECT` declarations produce immediate in-session repair feedback rather than silent loss.
