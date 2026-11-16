# ADR 0053: Review Verdicts Hand Off Through Durable Agent Messages

## Status

Accepted - 2026-11-16. Partially supersedes ADR 0050's `review_verdict_ready` prompt-source decision. ADR 0050's Issue-comment artifact and exact-target verdict decisions remain accepted.

## Context

ADR 0050 decoupled `review_action` from the Reviewer execution window by publishing the terminal verdict to the backing Issue and sending a browser-handled wake event. The frontend converted that event into natural-language input, assigned a random client message id, and placed it in `prompt_queue`.

That representation conflates three different concepts:

1. the Review task and its authoritative verdict artifact;
2. a message from the Reviewer agent in the Actions lane to the Acopilot agent;
3. an Acopilot model turn.

Because the handoff used the user prompt path, it competed with human input, looked like user retry work when it failed, depended on a browser to create the follow-up turn, and could be re-enqueued by another tab or replay. Marking the prompt as `origin=system` hid the symptom without representing the interaction.

The Agent2Agent task model, durable workflow message passing, and actor mailboxes converge on the same separation: tasks own state and artifacts, agents exchange typed messages, and a consumer turn is a consequence of a message rather than the message itself.

## Decision

- Keep the structured Issue comment as the authoritative Reviewer artifact and retain the exact PR, base, head, Issue, and job correlation fields.
- Persist every cross-lane handoff in `agent_messages`, independently of `prompt_queue`. Each row identifies source/destination lanes and roles, kind, correlation id, Issue/PR target, payload, lifecycle status, attempts, and lease metadata.
- Use a deterministic message id derived from the review job. Database uniqueness and an idempotent consumer make replay and multi-tab delivery converge on one effective handoff.
- Insert the Reviewer handoff on the server after the review reaches a terminal outcome. Browser clients no longer turn review events into prompts and no review handoff creates a `prompt_queue` row.
- Run an Acopilot handoff as a typed agent-message turn. The model receives the handoff text and metadata, while the UI renders a visible Reviewer-to-Acopilot handoff card instead of a user bubble or an invisible system artifact.
- Serialize user turns and agent-message turns through the same per-lane execution reservation. A message may wait while user work is active, and a user prompt may wait while an agent-message turn is active, but neither can start a concurrent model turn for the lane.
- Lifecycle states are `pending`, `running`, `delivered`, `failed`, and `superseded`. Claimed messages use a renewable lease. A failed handoff can be explicitly returned to `pending` by the Acopilot lane retry action; it is never converted into a user-message retry card.
 - Durable agent messages have no age-based expiry. The lease only claims execution rights: an expired `running` claim makes the same message eligible for takeover after a crash, without deleting the row, its payload, or its lifecycle history. Reconnecting to an existing Web conversation does not expire a handoff.
- Supersession uses the originating review job's monotonic creation time, not delivery order. A newer Review handoff for the same Issue and PR supersedes older pending or failed handoffs, while a delayed older job is itself recorded as superseded and cannot replace the newer target. A handoff bound to an obsolete lane generation is superseded rather than executed.
- Apply A2A-style Task, Message, and Artifact semantics internally without introducing an HTTP/gRPC protocol, external workflow engine, or graph framework.

## Consequences

The Reviewer-to-Acopilot interaction is now durable, typed, visible, and explicitly serialized with human work. Multiple tabs and sync replay cannot create extra prompts, and an unavailable Acopilot model leaves a failed handoff that can be diagnosed and retried without polluting the user queue.

This introduces a second execution path beside `prompt_queue`. Both paths must honor the same lane reservation and generation rules. The `agent_messages` state machine must retain its claim, renewal, terminal, and supersession invariants.
