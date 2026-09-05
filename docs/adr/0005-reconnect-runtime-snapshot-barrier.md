# ADR 0005: Reconnect Runtime Snapshots and Ordering Barriers

## Status

Accepted

## Context

The Web client receives live assistant deltas and command events over a WebSocket while reconnect catch-up reads a cursor-based HTTP event log. A reconnect can therefore observe the same turn through three paths: live frames, persisted events, and bootstrap history. Command execution previews are runtime state rather than durable conversation history, while an active command can continue after the original socket disappears.

Without an explicit barrier, an unsequenced live delta can be applied before the HTTP catch-up command that logically precedes it, or a bootstrap history payload can overwrite a newer live block. Without a runtime snapshot, history replay cannot restore an active command.

## Decision

1. Keep one sync runtime per logical lane on the server. It owns the assistant delta and command snapshot coalescers and is reused by sibling connections.
2. Persist active command snapshots as coalesced `command_snapshot` rows. Each command identity has absolute output offsets, revisions, and a stable event identity. Snapshots remain available through command completion and are removed only after the enclosing result or error.
3. Persist assistant text as phase-scoped `delta_snapshot` rows. A command or phase-complete event seals the current assistant phase before its own sequence is allocated.
4. Add `afterSeq` to live delta frames. The client sequencer holds barriered frames until the cursor reaches the barrier and holds unbarriered frames until catch-up completes. Bootstrap runtime snapshots are applied after the baseline history and catch-up events.
5. Use a visible-block whitelist: user messages, assistant text, execute blocks, and terminal/error/divider messages are renderable. Thought, plan, and patch records remain accepted as internal or supplementary inputs; patches may be folded into an assistant explanation but never create a standalone chat block.

## Consequences

- Reconnects can restore active command output without treating transient execution UI as durable chat history.
- Duplicate or overlapping delivery is reconciled by sequence, command identity, revision, and output offsets.
- Sealed assistant phases remain replayable, which preserves command/explanation ordering across reconnect.
- Runtime rows require normal sync-event retention and must be scoped to the logical lane; lane reset and turn completion clear them.

## Verification

The server command snapshot tests cover duplicate output, absolute offsets, reused command IDs, reconnect hydration, and terminal cleanup. Client tests cover catch-up barriers, active command restoration, distinct post-reconnect execute blocks, duplicate delivery, and the visible-block whitelist.
