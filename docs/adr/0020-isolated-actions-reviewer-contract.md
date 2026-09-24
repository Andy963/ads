# ADR 0020: Isolate Actions Reviewer Context and Persist Review Contracts

## Status

Accepted

## Context

The Actions queue previously assigned every detached Reviewer turn the same numeric
runtime identity. A Reviewer could therefore reuse a provider session, and the
Reviewer payload contained only the Issue title, a diff summary, and a short
verification message. Rework reviews could not prove that they were evaluating the
original Issue contract or the exact committed range. Large diffs were truncated
before the model saw them, but a normal `PASS` could still be returned.

The Reviewer is an internal protocol processor. Its raw JSON verdict must not be
broadcast as a user-facing Actions message, and every job must release its runtime
and provider context on success, failure, cancellation, and timeout.

## Decision

1. Every Reviewer invocation receives a fresh numeric runtime identity, uses
   `resumeThread: false`, and has no Developer transcript or history injection. The
   session is disposed after the verdict attempt, including abort and timeout paths.
2. `action_jobs` stores an immutable Issue snapshot at dispatch time. The snapshot
   contains the title, complete description, acceptance criteria, and any explicitly
   selected ADRs. Local prompt jobs use their complete prompt as the equivalent
   description. Rework reviews read this snapshot instead of reconstructing it from
   mutable Issue state.
3. Review payloads include the exact base/head refs, commit range, and verification
   command output. ADRs remain optional and are passed only when explicitly selected.
4. Diff filtering remains bounded for context safety, but an incomplete filtered diff
   produces a deterministic `REJECT` verdict before the model is called. A truncated
   diff cannot produce an authoritative `PASS`.
5. Reviewer responding deltas and raw protocol JSON remain internal. Only the existing
   structured verdict summary is rendered through the Actions lane.

## Consequences

- Reviewer jobs are isolated from one another and from Developer sessions, at the cost
  of one provider session setup per review attempt.
- The action job schema gains an immutable snapshot column and Reviewer payloads carry
  more explicit provenance for auditability.
- Very large diffs require a future chunked-review implementation or a human split;
  they are safely rejected instead of being partially approved.
- Existing queued jobs created before migration fall back to their title as a minimal
  contract, while newly dispatched jobs receive complete snapshots.
