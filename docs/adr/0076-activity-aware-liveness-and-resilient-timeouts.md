# ADR 0076: Activity-Aware Liveness Watchdogs and Resilient Transport Timeouts Across Native and ACP Runtimes

- **Status**: Accepted
- **Date**: 2026-11-28
- **Issue**: #757
- **Related**: [ADR 0025](0025-native-bounded-retry-and-recovery.md), [ADR 0038](0038-progress-based-execution.md), [ADR 0066](0066-runtime-unified-actions-reviewer.md), [ADR 0072](0072-generic-acp-v1-runtime-kernel.md), [ADR 0073](0073-agy-driver-and-acp-prompt-runner.md), [ADR 0075](0075-unify-codex-and-antigravity-on-acp-and-scope-providers-to-native.md)

## Context

Long-running coding turns and PR reviews routinely execute multi-minute test suites (`cargo test`, `cargo clippy`), deep `high`/`xhigh` reasoning passes, and multi-file audits. However, ADS's timeout behavior across `ads-acp`, `ads-native`, `ads-actions`, and `ads-http` relied on rigid wall-clock deadlines and narrow UI-event timers that repeatedly terminated healthy turns while failing to recover from genuine network stalls:

1. **ACP watchdog false positives**: `AcpPromptRunner` defaulted to a 120-second idle timeout (`DEFAULT_IDLE_TIMEOUT`) that refreshed only when `AcpEventBridge` emitted an ADS WebSocket event, ignoring wire-level `session/update` frames (such as `SessionUpdate::Unknown`), stderr progress, startup/resume time, and in-flight tool execution.
2. **ACP lifecycle traps**: Hardcoded 20-second startup probes ignored `ADS_AGENT_PROBE_TIMEOUT_MS`, 60-second uniform RPC timeouts truncated large `session/load` replays, `AcpSessionSupervisor` refused to fall back to `session/new` after a resume/load timeout (leaving lanes trapped in repeated timeouts), a 5-minute idle TTL triggered frequent cold-start resumes, 10-second cancel-drain tore down busy subprocesses prematurely, and `-32000` errors were mapped unconditionally to non-retryable `AuthenticationRequired`.
3. **Native transport hangs and unretried disconnects**: `completion.rs` and `responses.rs` built a fresh `reqwest::Client` per round with no TCP keepalive and no per-chunk idle read timeout, classified abrupt SSE EOF (before `[DONE]` or `response.completed`) as permanent `NativeError::Malformed`, and `runner.rs` disabled upstream retries for every subsequent round after the very first tool call (even read-only `read_file`).
4. **Hard wall-clock Reviewer kills & fragile lease heartbeats**: Both Native and ACP Reviewers enforced a fixed 30-minute total wall-clock cutoff (and Native returned `ReviewError::Other` without cancelling `request.cancellation`), Native Reviewer's `GIT_TIMEOUT` was only 5 seconds, and `AgentMessageService::spawn_heartbeat` aborted active lane turns on a single transient SQLite busy error.

## Decision

Adopt an activity-aware, progress-based liveness model inspired by `pingdotgg/t3code` (`watchPromptInactivity` + `ProviderSessionManager` + configurable probe timeouts) and aligned with [ADR 0038](0038-progress-based-execution.md):

1. **No Hard Wall-Clock Turn Kills by Default**:
   - Active Native turns (`ADS_NATIVE_RUNTIME_TURN_TIMEOUT_MS = 0`), ACP turns, and Actions Reviewer executions (`ADS_REVIEWER_MAX_DURATION_MS = 0`) are never terminated by a hard wall-clock deadline while actively making progress. Explicit operator-configured caps remain opt-in and enforce clean cancellation (`ReviewerError::Incomplete` for Reviewer).
2. **ACP Activity-Aware, Tool-Paused Inactivity Watchdog (`AcpTurnLiveness`)**:
   - Introduce `AcpTurnLiveness` and `spawn_inactivity_watchdog` in `ads-acp`, shared by both `AcpPromptRunner` and `run_acp_review`.
   - Default inactivity timeout is **15 minutes** (`ADS_ACP_IDLE_TIMEOUT_MS` / `ADS_AGENT_IDLE_TIMEOUT_MS` for chat turns; `ADS_REVIEWER_IDLE_TIMEOUT_MS` for Reviewer; `0` disables).
   - Refresh liveness on **all** incoming ACP wire traffic (stdout JSON-RPC lines, stderr lines, every `session/update` including `Unknown`, and permission requests), begin tracking only after `session/prompt` starts, and **pause** inactivity checks while any tool call or permission approval is in flight.
   - When genuine inactivity expires, cancel the turn, never persist the timed-out `sessionId`, and recycle the stalled subprocess cleanly.
3. **ACP Lifecycle, Probe, Fallback, and Error Resilience**:
   - Raise warm session `idle_ttl` default from 5 minutes to **30 minutes** (`ADS_ACP_SESSION_IDLE_TTL_MS`, `0` disables reaping).
   - Honor `ADS_ACP_PROBE_TIMEOUT_MS` / `ADS_AGENT_PROBE_TIMEOUT_MS` (default **60 seconds**) across `RuntimeRegistry`, `AgyDriver`, and `CodexDriver`.
   - Give heavy lifecycle RPCs (`initialize`, `session/new`, `session/resume`, `session/load`) a 180-second default timeout (`lifecycle_rpc_timeout`), raise `DEFAULT_CANCEL_DRAIN_TIMEOUT` to 30 seconds, recycle and fall back to `session/new` when `session/resume`/`session/load` times out, and avoid misclassifying `-32000` errors carrying transient upstream signals as `AuthenticationRequired`.
4. **Native Transport Keepalive, Per-Chunk Idle Timeout, and Per-Round Retry**:
   - Reuse a shared `reqwest::Client` configured with 30-second `tcp_keepalive`, 30-second `connect_timeout`, and 90-second `pool_idle_timeout`.
   - Enforce a **per-chunk stream inactivity timeout** (`ADS_NATIVE_STREAM_IDLE_TIMEOUT_MS`, default **10 minutes**, `0` disables) rather than a whole-request wall-clock limit, classifying both stream inactivity timeouts and abrupt premature SSE EOF (without `[DONE]` / `response.completed`) as transient retryable errors.
   - Fence Native upstream retries per model round (before the current round emits deltas or executes tools) so later rounds of a multi-tool turn recover from transient gateway errors without replaying already-checkpointed tools.
5. **Reviewer Liveness & Heartbeat Resilience**:
   - Route both Native and ACP Reviewers through the shared 15-minute inactivity model (`ADS_REVIEWER_IDLE_TIMEOUT_MS`), classify Reviewer timeouts consistently as `ReviewError::Incomplete` after calling `request.cancellation.cancel()`, raise Native Reviewer `GIT_TIMEOUT` from 5s to 30s, and retry transient SQLite contention in `AgentMessageService::spawn_heartbeat` before aborting an active turn (while still aborting immediately on authoritative lease loss).

## Consequences

- Long-running builds, tests, reasoning passes, and deep reviews no longer die from arbitrary wall-clock cutoffs or 2-minute UI silence while tools are running.
- Half-open proxy sockets and abrupt gateway SSE cuts fail fast and recover cleanly via bounded retries instead of hanging indefinitely or failing as `Malformed`.
- Stalled ACP sessions are recycled automatically on genuine inactivity or resume timeout rather than poisoning subsequent turns on the lane.
- Operators retain full override control via environment variables (`ADS_ACP_IDLE_TIMEOUT_MS`, `ADS_ACP_SESSION_IDLE_TTL_MS`, `ADS_ACP_PROBE_TIMEOUT_MS`, `ADS_AGENT_PROBE_TIMEOUT_MS`, `ADS_ACP_RPC_TIMEOUT_MS`, `ADS_NATIVE_STREAM_IDLE_TIMEOUT_MS`, `ADS_REVIEWER_IDLE_TIMEOUT_MS`, `ADS_REVIEWER_MAX_DURATION_MS`).
