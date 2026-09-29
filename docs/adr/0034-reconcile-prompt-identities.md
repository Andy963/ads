# ADR 0034: Reconcile Prompt Identities Against Durable Server State

## Status
Accepted

## Context
The browser outbox can survive longer than a WebSocket connection and may be restored by another tab or device. A client that missed the original running or completion event cannot infer that an old prompt was consumed from the active queue snapshot, because completed rows are not advertised there. Local dismissal and consumption caches also cannot serve as the cross-device authority.

Offline cancellation has the inverse race: a client may still hold a prompt after requesting cancellation, and replaying that prompt before the server records the cancellation can make it eligible again. Queue execution and cancellation therefore need one durable, scoped identity decision that clients can reconcile before restoring or dispatching old outbox entries.

## Decision
On WebSocket connection, the client sends the prompt identities held in its outbox, plus outstanding cancellation intents. The server resolves them using the authenticated connection's owner, session, chat session, logical lane, and lane generation. It returns only identity dispositions, not prompt text:

- `pending`: the current-generation row has not been claimed and remains eligible.
- `consumed`: the row was claimed or reached a terminal execution state.
- `cancelled`: a durable cancellation tombstone exists.
- `obsolete`: the identity belongs to an older lane generation and cannot be replayed in this generation.
- `unknown`: the server has no record in this scope; the client may preserve it as genuinely unsent work.

The browser does not restore or dispatch held outbox entries until this response arrives. `pending` is not a terminal decision: its outbox record and prompt text remain available for recovery. When a consumed decision arrives before the matching history frame, the client keeps the locally recovered user message until history catches up. Consumed, cancelled, and obsolete decisions are monotonic across browser storage and tabs. Cancellation intents are reconciled before any old prompt identity can be replayed.

The durable queue row is the source of consumed identity history; completed payloads remain scrubbed. Cancellation tombstones are retained independently of queue rows. Queue claim and cancellation remain mutually exclusive: cancellation may retire unclaimed work, while a running/claimed prompt is consumed and cannot be stopped through the queue-delete action. A deliberate retry after consumption uses a fresh request identity. `replay_incomplete: true` only permits retrying an unclaimed identity and never overrides a consumed or cancelled decision.

Terminal identity history has no time- or count-based eviction. Any future compaction must preserve equivalent durable deduplication and cancellation guarantees before old rows or tombstones can be removed.

## Consequences
Reconnects take one server round trip before old outbox cards become visible or eligible for dispatch. Truly unsent work remains recoverable, while consumed and cancelled work cannot be resurrected by stale tabs, snapshots, or ACKs. Scope checks prevent one authenticated user or lane from learning another lane's identity disposition.

Durable terminal records grow over time. Completed prompt payloads are already scrubbed, and cancellation tombstones contain identity and scope metadata only; storage reduction requires a separately designed compact terminal ledger rather than a retention cutoff.
