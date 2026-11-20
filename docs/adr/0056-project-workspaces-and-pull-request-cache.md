# ADR 0056: Project Workspaces and Pull Request Cache Boundaries

## Status

Accepted

## Context

ADS previously treated `Acopilot` and `Actions` as lane tabs and placed the active lane's model selector in the same control strip. A project-level Pull Requests view introduces a different navigation concept. It is not a lane, has no transcript or composer, and must not inherit lane status or execution controls.

Pull request browsing also needs data that behaves differently from chat history. The list is a bounded summary view, while details, checks, diff metadata, and reviews are larger and should only load when selected. Provider credentials must remain server-side.

## Decision

1. The project workspace navigation has three views:
   - `acopilot` and `actions` remain lanes with lane status, transcript, composer, and lane-scoped model preferences.
   - `prs` is a project data view with no lane status dot and no composer.
2. The selected project name and branch remain the shared active-context header across all three views.
3. The model and reasoning-effort selector moves from the lane tab strip to a dedicated composer metadata row. It remains lane-scoped and visible only when a lane composer is rendered.
4. Pull request data is read through ADS server routes. The browser never calls GitHub directly and never receives provider credentials.
5. The server owns short-lived summary and detail caches, in-flight deduplication, cursor pagination, and partial-failure responses.
6. The client persists only the first summary page in IndexedDB, scoped by project and normalized filter identity.
   - Persisted records contain summary rows plus fetch and storage timestamps.
   - Cursors, errors, loading flags, tokens, command output, and unbounded detail payloads are not persisted.
   - Entries are bounded by count, byte size, and age.
   - A cold start renders cached rows first, then refreshes from the server.
   - Offline or partial refresh failures retain readable cached rows and expose an explicit error state.
7. Pull request detail, checks, files, and review metadata are fetched lazily when a row is opened.

## Consequences

- Lane navigation and project data navigation no longer compete for one control surface.
- Mobile lane swiping remains limited to `Acopilot` and `Actions`; selecting `PRs` exits that swipe model.
- Cached PR summaries can improve cold-start readability without creating a second source of truth.
- The server remains the authority for freshness, credentials, pagination, and provider-specific filtering.
- Future project-level data views can follow the `prs` boundary instead of being modeled as lanes.
