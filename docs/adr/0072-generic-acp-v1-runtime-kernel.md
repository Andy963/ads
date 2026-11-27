# ADR 0072: Generic ACP v1 Runtime Kernel

## Status

Accepted

## Context

ADS supports `ads-native` and `codex` (`codex app-server`), but lacked a reusable runtime layer for integrating external CLI agents that implement the **Agent Client Protocol (ACP v1)**. Building bespoke process supervision, JSON-RPC framing, session state tracking, permission bridging, and event translation for each external agent CLI (such as `agy`, OpenCode, or Kiro) would duplicate fragile lifecycle code and couple ADS core logic to individual CLI quirks.

## Decision

Introduce a dedicated, agent-agnostic `ads-acp` crate in the Rust workspace (`rust-server/crates/ads-acp`) that implements the ACP v1 client kernel while delegating agent-specific quirks to a narrow `AcpDriver` trait:

- **Per-Active-Session Subprocess Isolation + Idle TTL**: `AcpSessionSupervisor` spawns one isolated ACP subprocess per active ADS session/thread rather than sharing a single process across threads or workspaces. Idle subprocesses are reclaimed after a configurable TTL (`AcpSupervisorConfig::idle_ttl`), preserving their `sessionId` mapping and seamlessly re-attaching via `session/resume` (or `session/load` when replay is needed) on the next turn.
- **Protocol-Declared Capabilities and Config Alignment**: The kernel never hardcodes model catalogs or slash commands. Capabilities, available commands, modes, and `configOptions` are populated strictly from `initialize`, `session/new` / `session/resume` / `session/load`, and live `session/update` notifications (`config_option_update`, `available_commands_update`, `current_mode_update`). Local `configOptions` are indexed by `configId` and `category` (never array index). Pre-turn alignment (`AcpSession::align_config`) is idempotent and always applies `model` before `thought_level` when both change.
- **Ordered JSON-RPC 2.0 Transport and Graceful Process-Group Supervision**: `AcpTransport` communicates via newline-delimited JSON-RPC 2.0 over stdio with configurable RPC timeouts, inline sequential notification dispatch (preserving wire order), and fail-fast structured errors (`AcpError::MalformedFrame`, `AcpError::Timeout`, `AcpError::Closed`) on malformed frames, timeouts, or crashes. Each subprocess runs in its own Unix process group (`process_group(0)`). Shutdown closes `stdin` first to allow external agents to flush session state cleanly, then escalates to process-group `SIGTERM` and once-only `SIGKILL` if the process fails to exit.
- **Streaming Event and Permission Bridges**: `AcpEventBridge` translates `session/update` notifications (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `config_option_update`, `current_mode_update`, `usage_update`, `compaction_update`) into strongly-typed `AcpStreamEvent`s and ADS `PromptRunContext` frames while preserving assistant phase boundaries across tool calls. `InteractivePermissionBroker` routes `session/request_permission` requests through ADS's approval lifecycle and automatically cancels pending prompts on turn cancellation or subprocess exit.
- **Cancellation Drain Semantics**: Sending `session/cancel` transitions the session to `Cancelling`, cancels pending permission requests, and continues draining trailing `session/update` notifications until `session/prompt` resolves (within `cancel_drain_timeout`), returning the session cleanly to idle (`Ready`).
- **Narrow `AcpDriver` Extension Boundary**: Concrete Phase 2 drivers only implement `AcpDriver` to customize launch command/args/env, extra `session/new` parameters, optional model/thought/mode alias mapping, and driver-specific JSON-RPC error classification (e.g., `-32000` -> `AcpError::AuthenticationRequired`).

## Consequences

Phase 2 integrations (such as the `agy` driver) can plug into ADS by implementing the narrow `AcpDriver` trait without re-implementing stdio transport, process supervision, idle reclamation, permission cleanup, or event translation. The kernel itself is verified independently of any external agent CLI via a deterministic in-workspace Mock ACP stdio server (`ads-acp-mock-server`) and integration test suite.

Because Phase 1 isolates protocol mechanics from concrete agent CLI binaries, concrete runtime wiring (`ADS_AGENT_RUNTIME` selection and agent-specific auth/catalog probing) remains cleanly scoped to Phase 2.
