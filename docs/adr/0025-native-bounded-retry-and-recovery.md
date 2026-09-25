# ADR 0025: Harden Native Retry, Cancellation, and Recovery

## Status

Accepted

## Context

The Native runtime talks directly to OpenAI-compatible providers and can execute tools between provider rounds. A transient provider failure must be retried without replaying commands, file changes, or dispatches. Malformed and incomplete provider responses must fail explicitly, while user cancellation must reach provider I/O and active tools. Durable transcripts must not restore failed, cancelled, or interrupted turns as successful context.

## Decision

Use the existing bounded transient model retry policy for Native provider requests. Each retry attempt is part of one logical turn and may retry only before an observable tool side effect. The adapter marks the attempt as unsafe before executing a tool and publishes a structured retry event for observers.

The provider client classifies network failures, retryable HTTP statuses, permanent HTTP failures, and malformed responses. Streaming requests must receive a complete `[DONE]` response and complete tool-call fields. Cancellation is propagated as an abort and is never converted into a retryable provider failure.

Transcript checkpoints remain running during retryable attempts and become terminal only when the logical turn succeeds or cannot be safely retried. The Native runtime does not resume or mutate Codex provider threads.

## Consequences

- Provider failures have bounded, observable recovery with the same backoff and cancellation semantics as the Codex adapter.
- Side-effect fencing prevents duplicate command, patch, and dispatch execution.
- Malformed responses fail at the provider boundary instead of producing partial success.
- A retry does not create multiple durable logical turns.
- Permanent authentication, policy, endpoint, and invalid-request failures remain terminal.
