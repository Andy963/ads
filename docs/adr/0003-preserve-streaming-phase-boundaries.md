# ADR 0003: Preserve Streaming Phase Boundaries Across Reconnects

## Status
Accepted

## Context

The Web Console receives assistant text as cumulative streaming updates while the
Codex app-server interleaves agent messages, tool work, and multiple turns. The
previous protocol had no durable boundary for a completed assistant item and used
one coalesced snapshot per lane. A reconnect could therefore restore unrelated
assistant phases as one message, overwrite earlier snapshots from a later turn, or
render assistant results without the user prompts that caused them.

## Decision

1. The worker WebSocket adapter emits `phase_complete` when an assistant
   `agent_message` item completes or a distinct assistant item begins. The client
   seals the active assistant card at this boundary, and the next phase starts a
   new card even when no command card is present.
2. The sync log stores each active assistant phase as a separately coalesced
   `delta_snapshot`. Snapshot event IDs include an instance-unique stream ID and
   phase index. Terminal events retire only the active unsealed snapshot; sealed
   intermediate phases remain available for replay.
3. Prompt preflight records a durable `user` sync event after history persistence.
   If that event cannot be recorded, only the newly inserted prompt entry is
   rolled back so the client can retry without creating a history duplicate.
4. History reconciliation uses bidirectional LCS alignment to backfill missing
   server entries while preserving persisted timestamps and execution metadata.

## Consequences

### Positive

- Reconnect replay preserves the visible conversation topology and phase order.
- Multiple turns cannot overwrite each other's in-flight snapshots.
- User prompts and assistant results remain aligned in incremental sync.
- Replaying a snapshot is idempotent because it replaces the active text.

### Trade-offs

- The sync log retains sealed intermediate snapshots until normal lane retention
  removes them, increasing durable event volume during long-running turns.
- Legacy producers that omit item IDs receive conservative boundary behavior and
  cannot provide perfect phase attribution.
