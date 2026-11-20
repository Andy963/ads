# ADR 0055: Split the Client and Server Implementations

## Status

Accepted - 2026-11-20.

## Context

The repository now contains a Rust backend as the primary runtime, but its
workspace is still rooted at the generic path `rust/`. The TypeScript backend
is a maintained behavioral baseline, yet its source was removed from the
current tree and only its build output remained. The Telegram connector was
also kept at the repository root, separate from the server implementation it
belongs to.

This layout does not express the actual product boundary: one shared Web
client talks to one of two interchangeable server implementations, and each
server owns its native connector runtime.

## Decision

- Keep `client/` as the single shared Web client.
- Rename the Rust workspace from `rust/` to `rust-server/`.
- Restore the TypeScript server under `ts-server/`.
- Keep TypeScript shared contracts under `ts-server/shared/` because they are
  the type baseline for the TypeScript server and are consumed by the client.
- Keep the Rust Telegram connector as the Cargo crate
  `rust-server/crates/ads-telegram/`.
- Move the TypeScript Telegram connector to
  `ts-server/connectors/telegram/`.
- Remove the top-level `connectors/`, `server/`, and `shared/` directories.
- Keep repository-level documentation, CI, and release assets at the root.

## Consequences

The repository topology now matches the deployment choice between two server
implementations without duplicating the client. Connector ownership is
unambiguous, and the TypeScript behavioral baseline can be built and tested
again from source.

Build, test, CI, and documentation paths must use the new server prefixes.
Cross-server compatibility tests must resolve the TypeScript implementation
from `ts-server/`. The Rust connector remains a Cargo crate rather than a
second connector directory format.
