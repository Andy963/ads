# ADR 0016: Bind Actions Events to Authenticated Project Lanes

## Status

Accepted

## Context

Action jobs are persisted by project, while WebSocket lanes are identified by an authenticated user, project session, and chat session. The Actions bus previously used a fixed `admin` identity, so live broadcasts and history bootstrap could diverge from the browser's actual lane. A project workspace can also be mapped to more than one authenticated user, making project id alone insufficient for isolation.

## Decision

Persist the authenticated owner and project chat session on each action job when it is dispatched. Resolve the browser lane through one canonical identity resolver, and reuse the persisted identity for every subsequent job event, including rework, verification, review, delivery, and status updates. Queue reads and manual mutations are owner-scoped. When a project mapping is ambiguous, identity resolution fails closed; legacy jobs without owner metadata use an isolated internal Actions identity rather than borrowing another user's browser lane.

The owner and chat-session fields remain internal and are omitted from the existing action-job API response.

## Consequences

Action history and live events now share the browser's exact history key and survive reconnects. User and project isolation is enforced even when multiple users map the same workspace. The job schema gains two nullable columns for legacy compatibility, and all dispatch callers that need browser visibility must provide or resolve an authenticated project mapping.
