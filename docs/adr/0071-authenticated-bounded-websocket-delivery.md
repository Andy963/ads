# ADR 0071: Authenticate WebSockets Before Upgrade and Bound Outbound Delivery

## Status

Accepted

## Context

The Rust `/ws` route was registered outside the JSON API authentication middleware. It performed authentication and browser-origin checks inside the post-upgrade callback, so invalid requests first received HTTP 101 and were rejected only with an application close code.

Each WebSocket connection also used unbounded control and lane-forwarding channels. A stalled socket could therefore accumulate outbound frames without a memory bound while the connection loop was blocked on a WebSocket write.

## Decision

Authenticate the request and enforce the non-connector Origin policy in the HTTP handler before calling `WebSocketUpgrade::on_upgrade`. Return HTTP 401 for invalid credentials and HTTP 403 for a disallowed browser origin.

Use one bounded `tokio::sync::mpsc` queue per physical WebSocket connection. Store the queue sender and lane index in the hub registration, and dispatch broadcasts with non-blocking `try_send` after releasing the connection registry lock. When the queue is full, increment saturation metrics, signal the connection, and close it with code 4429 (`outbound queue overflow`). The queue capacity is configurable through `ADS_WEB_WS_OUTBOUND_QUEUE_CAPACITY` and defaults to 256.

## Consequences

Invalid browser requests are rejected at the HTTP boundary and cannot consume an upgraded socket. Slow consumers have a deterministic memory bound and are disconnected instead of applying unbounded producer-side buffering. Broadcasts no longer perform channel sends while holding the connection registry mutex.

The overflow policy intentionally disconnects slow clients; clients must reconnect and use the existing bootstrap/replay behavior. Queue saturation and slow-client disconnects are exposed through atomic WebSocket metrics for operational monitoring.
