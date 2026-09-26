# ADR 0028: Allow Cross-Runtime Session Continuation via History Injection

## Status

Accepted (Supersedes ADR 0021 item 2)

## Context

ADS supports two agent runtime backends: `codex-app-server` and `native`.
ADR 0021 item 2 strictly prohibited cross-runtime continuation and required throwing `RuntimeBackendMismatchError` when a persisted session record in `thread_state` had a `runtimeBackend` differing from the active runtime backend.
This caused the WebSocket server to close client connections with code 4400 on backend switches, stranding web clients in a disconnected state.

ADS provides backend-independent history injection using SQLite `history_entries` before prompt dispatch.
ADR 0021 item 5 already accepted history injection for untagged legacy sessions without provider thread resume IDs.
Extending this history injection fallback to mismatched runtime backends allows sessions to continue across backend transitions without connection failure.

## Decision

1. When a persisted session record contains a `runtimeBackend` differing from the active runtime backend, `resolveResumeState` omits the incompatible provider thread identifier and returns `restoreMode: "history_injection"` with `shouldInjectHistory: true`.
2. The server creates a fresh session on the active runtime backend instead of closing the WebSocket connection with error code 4400.
3. The first prompt sent after a runtime switch injects the previous conversation history into the active adapter before turn execution.
4. Session state synchronization updates `runtimeBackend` in `thread_state` to the active runtime backend and clears incompatible provider thread IDs and native transcript bindings.
5. Direct cross-runtime provider thread reuse remains unsupported. History injection is the designated degraded continuation path.

## Consequences

- Switching `ADS_AGENT_RUNTIME` no longer triggers WebSocket connection closure with code 4400.
- Existing sessions continue uninterrupted across runtime backend changes.
- Persisted session state cleanly migrates to the active backend on subsequent turns.
