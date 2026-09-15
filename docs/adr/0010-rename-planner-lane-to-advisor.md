# ADR 0010: Rename Planner Lane to Advisor with Legacy Compatibility

Status: Accepted

## Context

The product lane was renamed to Advisor in the UI, but the identifier `planner` remained throughout the codebase as TypeScript identifiers, the WebSocket lane id (`ads-chat` subprotocol value), history/session key segments, localStorage key segments, environment variables (`ADS_PLANNER_CODEX_MODEL`, `ADS_PLANNER_SANDBOX_MODE`), and the `server/web/server/planner/` module directory. Because the lane id string is simultaneously a type value, a wire-protocol value, and a storage key segment, an uncoordinated rename would orphan persisted state and break old clients during the deployment window (home-screen PWAs cache the previous bundle).

## Decision

Adopt `advisor` as the canonical lane id everywhere, and concentrate all legacy handling in normalization layers instead of migrating data:

- **Wire boundary**: `resolveWebSocketChatSessionId` maps the legacy id `planner` to `advisor` at the single entry point where the `ads-chat` subprotocol value enters the server; `resolveLaneRequest` normalizes the sync-REST `chatSessionId` parameter the same way. All downstream code (history keys, lane resources, sync namespace, reset barriers) sees only `advisor`.
- **History storage**: `HistoryStore.get` falls back from an `...::advisor[:generation:N]` key to its `...::planner...` legacy variant when the primary lookup is empty. Writes always go to the primary key (read-old / write-new); no data migration.
- **Client storage**: localStorage preference and outbox reads (model id, reasoning effort, mobile workspace tab, outbox) fall back to the legacy `planner` key segment when the `advisor` key has no value. Writes always use `advisor`.
- **Storage namespaces**: the SQLite storage namespace values `web-planner` / `web-worker` are persisted rows in `state.db` and are NOT renamed; only the exported constant identifier is renamed (`WEB_ADVISOR_NAMESPACE`) with a comment pinning the legacy value.
- **Configuration**: `ADS_ADVISOR_CODEX_MODEL` / `ADS_ADVISOR_SANDBOX_MODE` are the canonical names; the legacy `ADS_PLANNER_*` names remain accepted as fallbacks with a deprecation warning.
- **Module directory**: `server/web/server/planner/` moves to `server/web/server/advisor/` (imports updated in the same change).

Non-goals: renaming the Worker lane; migrating historical rows in `state.db`; renaming content inside `docs/adr/` archives.

## Consequences

New code has a single source of truth for the lane id (constants on both client and server). Old clients, old persisted history, and old environment configurations keep working for the compatibility window. The legacy aliases (`planner` lane id, `ADS_PLANNER_*` variables, `web-planner` namespace value) can be retired in a follow-up release after the compat window closes; until then, `rg -i planner` matches are limited to those intentional aliases and ADR archives.
