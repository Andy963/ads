# ADR 0076: Unified Bounded Transient Retry Policy for Native and ACP Runtimes

## Status

Accepted

## Context

ADR 0025 established bounded transient retries with side-effect fencing for the Native runtime, defaulting `ADS_UPSTREAM_RETRY_COUNT` to `1` (two total attempts). However:

1. A default of `1` retry is too low for common upstream rate-limit (`429`) and gateway (`500`/`502`/`503`/`504`) blips, and the Native context-compaction summary completion bypassed `complete_with_retry`.
2. After unifying Codex and Antigravity onto the ACP v1 kernel (ADR 0072, ADR 0073, ADR 0075), `AcpPromptRunner` and `run_acp_review` performed zero automatic retries on transient failures (`AcpError::Transport`, non-graceful subprocess `Closed`, retryable `Driver` errors, or transient upstream `Rpc` failures) and hardcoded `"retryable": false` on error events.

Retrying blindly across ACP turns would be unsafe because ACP subprocesses encapsulate tool execution and emit incremental output. Retrying after assistant streaming or tool execution could duplicate side effects or corrupt streamed output.

## Decision

Unify bounded transient retry across both the Native and ACP runtimes under a shared default of `3` retries (up to 4 total attempts, configurable via `ADS_UPSTREAM_RETRY_COUNT`, including `0` to disable):

1. **Native Runtime (`ads-native`)**:
   - Raise `DEFAULT_RETRY_COUNT` from `1` to `3`.
   - Extend `is_transient_upstream_model_error` to recognize transient HTTP `408`, `425`, `500`, `502`, and `504` status messages alongside `429`, `503`, `520..=524`, and connection/stream resets while preserving strict rejection of authentication and permanent 4xx errors.
   - Route the side-effect-free context-compaction summary completion through `complete_with_retry`.

2. **ACP Runtime (`ads-acp`)**:
   - Add `AcpError::is_retryable()` to classify transient failures (`Transport`, non-graceful `Closed`, `Driver { retryable: true }`, and non-protocol `Rpc` errors whose payload or message matches `ads-native`'s transient upstream classifier) while keeping permanent errors (`AuthenticationRequired`, `Cancelled`, `Spawn`, `Timeout`, `UnsupportedCapability`, `InvalidState`, `MalformedFrame`, `InvalidResponse`, and JSON-RPC protocol/parameter errors `-32700`/`-32600`/`-32601`/`-32602`) terminal.
   - Add per-attempt side-effect and output fencing (`AcpPromptRequest.retry_fence` wired into `AcpEventBridge` and `AcpSession`'s `session/request_permission` handler). Any non-empty assistant/thought delta, tool call notification, or approved permission marks the attempt unsafe to retry.
   - Add bounded retry with `Retry-After` / exponential backoff, cancellation-aware sleep, and `"type": "retry"` status events to `AcpPromptRunner::run_inner`, and report accurate `retryable` metadata in error events.
   - Add symmetric bounded retry to `run_acp_review` constrained by the remaining `request.timeout` deadline and cancellation token.

## Consequences

- Both Native and ACP users recover automatically from up to 3 transient upstream or transport blips by default, with consistent backoff and `"type": "retry"` UI visibility.
- Side-effect and output fencing guarantees retries never replay approved tool actions or duplicate partial streamed assistant responses.
- Permanent authentication, configuration, and parameter errors fail fast without wasting backoff delays.
- Operators retain full override control through `ADS_UPSTREAM_RETRY_COUNT` (including `0` for strict fail-fast test environments).
