# ADR 0047: Multiplex Project Lanes over One WebSocket

## Status

Accepted — Issue #593

## Context

Each project page opened one Actions socket and one Acopilot socket. Both connections shared the same authenticated project identity and differed primarily by chat-session lane. This doubled connection use while the server enforced a global physical-client cap. The existing handshake and server metadata bound one lane to each socket, preventing either connection from carrying both streams.

## Decision

- Create one physical WebSocket per project and subscribe it to the project's Actions and Acopilot chat sessions.
- Keep lane state logically independent. Every outbound frame carries `chatSessionId`; inbound frames use the existing `chat_session_id` field (or the equivalent camel-case field) to select a lane. `switch_chat_session` is lane-scoped and continues to rebind only that logical lane without reconnecting the physical socket.
- Send each lane its own `welcome` frame. Include `subscribedChatSessionIds` so clients can confirm the subscriptions established by the connection.
- Preserve per-lane bootstrap cursors and lane generations as query parameters keyed by chat-session ID. The server projects each lane's cursor onto its existing bootstrap path; synchronization history, reset barriers, transcript caches, outboxes and reconnect state remain lane-scoped.
- Count a multiplexed physical socket once against the server's WebSocket client limit. Existing clients that request only one chat session continue to use the existing single-lane path.

## Consequences

A project page consumes one connection slot rather than two without sharing transport across projects. The server still executes lane-specific handlers and retains existing history keys; multiplexing changes the transport boundary, not the persistence identity. Every added lane must have a distinct chat-session ID and every lane-owned frame must preserve that ID so that state cannot leak between transcripts. Closing the physical connection terminates all of its lane subscriptions.

The WebSocket tests cover frame routing and welcome metadata, per-lane bootstrap cursor projection, client-side one-socket construction, outbound lane identity, and isolation of inbound frames. Existing session switching and lane reset behavior remain covered by the web test suite.
