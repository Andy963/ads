# ADR 0058: Implement Pull Request Workspace Routes in Rust HTTP Server

## Status

Accepted

## Context

ADR 0055 established the Rust server implementation (`rust-server/`) as the primary runtime backend, while preserving the TypeScript server (`ts-server/`) as a reference baseline.
ADR 0056 introduced the Pull Requests workspace in the Web client, fetching summaries and details through server routes `/api/pull-requests` and `/api/pull-requests/:number`.

However, the pull request routes were initially only implemented in `ts-server`. In environments running the Rust server (`ads-server`), requests to `/api/pull-requests` were intercepted by the static file fallback handler, returning HTTP 404 `Not Found` and producing an error banner in the client workspace.

## Decision

1. Implement `/api/pull-requests` and `/api/pull-requests/{number}` in `rust-server/crates/ads-http`:
   - `GET /api/pull-requests`:
     - Requires an authenticated user session.
     - Resolves the project workspace root from `default_workspace_root` (when `projectId == "default"`) or by querying `web_projects` in `StateDb`.
     - Validates and parses state, involvement, checks, labels, author, pagination cursor, and refresh flags.
     - Interacts with GitHub via `gh pr list --json ...` asynchronously.
     - Implements in-memory TTL caching (30s) and in-flight request deduplication per query key, with `refresh=1` cache invalidation.
   - `GET /api/pull-requests/{number}`:
     - Validates positive PR number and authenticated user project.
     - Interacts with GitHub via `gh pr view <number> --json ...`.
     - Implements in-memory TTL caching (60s) and returns detail metadata.
2. Mirror data contracts in `rust-server/crates/ads-contract/src/pull_requests.rs`.
3. Provide an injectable `GhRunner` trait in `RouterConfig` and `AppState` allowing hermetic, deterministic testing without live GitHub network dependencies.

## Consequences

- The Rust backend achieves full feature parity with the TypeScript backend for pull request workspace browsing.
- The Web client's PRs workspace works seamlessly regardless of whether `rust-server` or `ts-server` is deployed.
- Testing remains deterministic via `GhRunner` mocks.
