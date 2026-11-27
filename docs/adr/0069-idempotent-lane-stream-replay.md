# ADR 0069: Make Lane Stream Replay Idempotent by Turn and Assistant Item Identity

## Status

Accepted — 2026-11-26.

## Context

ADS delivers assistant output through live WebSocket deltas, persisted
`delta_snapshot` events, terminal result frames, and lane history. A single
turn can contain several assistant phases separated by commands. Before this
change, some producers omitted `clientMessageId`, persisted snapshots could
share one coalescer across assistant phases, and replay could therefore create
anonymous duplicate assistant bubbles. The Actions lane also stored the full
review verdict in both its completion status and result entries.

## Decision

- Carry the owning turn's `clientMessageId` on live assistant, result, and
  error frames, and persist it with each assistant snapshot. Preserve the
  provider `assistantItemId` between streamed phases and terminal results.
- Rotate the delta coalescer when a known assistant item changes, and seal the
  previous phase before starting the next one. Keep sealed phases replayable.
- Treat a snapshot whose stream end offset has already been rendered as
  idempotently consumed even when no prior snapshot revision exists. When
  identity is unavailable for legacy frames, use the existing stream offset and
  exact phase-text fallback rather than creating a new bubble.
- Publish one authoritative formatted review verdict in the Actions result
  entry. The completion status entry is only a concise milestone.

## Consequences

- Reconnects and cursor replay converge on one assistant bubble per
  `(clientMessageId, assistantItemId)` while preserving multi-phase ordering.
- Older producers without turn identity retain conservative offset-based
  deduplication, but cannot provide the same item-level guarantees.
- The sync log contains explicit sealed phase rows and the Actions history no
  longer duplicates the full verdict body across two terminal roles.
- Producers and clients must retain the identity fields when adapting or
  projecting lane events; dropping them reintroduces the legacy fallback path.
