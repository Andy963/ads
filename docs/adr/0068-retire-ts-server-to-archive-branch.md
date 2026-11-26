# ADR 0068: Retire Legacy TypeScript Server to Archive Branch

## Status

Accepted — 2026-11-25. Supersedes the `ts-server/` retention portions of ADR 0055 and ADR 0057.

## Context

`rust-server` now covers all active ADS backend capabilities in production, including HTTP/WebSocket APIs, authentication, prompt queues, scheduler, Actions Reviewer runtime unification (ADR 0066), Web Push notifications (ADR 0067), and the Rust Telegram connector (`ads-telegram`). Maintaining the retired `ts-server/` package on `dev` kept CI release workflows, shared client imports, and legacy cross-compatibility scripts tied to a backend that is no longer updated or deployed.

## Decision

- **Archive Branch**: Preserve the final frozen snapshot of `ts-server/` with an explicit `ts-server/DEPRECATED.md` notice on the dedicated branch `archive/ts-server-deprecated`.
- **Rust-Server-Only `dev` Branch**: Remove `ts-server/`, legacy TS-vs-Rust cross-compatibility tests/scripts (`*_ts_cross_compat.rs`, `rust-server/scripts/`), and `ts-server/dist/`-coupled browser harnesses from `dev`, while keeping `rust-server/contracts/` embedded by `ads-state`.
- **Self-Contained `client/` Package**: Move the five shared TypeScript contract modules from `ts-server/shared/` into `client/src/shared/` and replace the TS-server-spawning command-activity test fixture with a deterministic recorded wire fixture so `client/` lints, tests, and builds independently.
- **CI & Root Documentation Alignment**: Update `.github/workflows/release.yml`, `.github/workflows/pre-release.yml`, `README.md`, `CONTRIBUTING.md`, `.env.example`, `rust-server/README.md`, and active `docs/` guides to build, test, and package `rust-server` (`ads-server`, `ads-telegram`) alongside `client/`.

## Consequences

- `dev` has a single authoritative backend (`rust-server/`) and a fully self-contained frontend (`client/`), eliminating drift between legacy TypeScript code and active Rust releases.
- Historical TypeScript code remains safely accessible on `origin/archive/ts-server-deprecated` for reference without cluttering active development or CI pipelines.
