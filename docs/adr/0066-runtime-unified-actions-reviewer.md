# ADR 0066: Route Actions Reviewer Through the Active Agent Runtime

## Status

Accepted — 2026-11-25.

## Context

`ads-server` selects its active execution runtime via `ADS_AGENT_RUNTIME` (`codex-app-server` or `native`), but `ReviewQueue` previously ignored that setting and always fell back to a separate bespoke Reviewer loop in `ads-native/src/reviewer/`.

In production, that disconnected loop suffered repeated failures:
1. It bypassed `codex app-server`'s transport, provider injection, streaming, and retry infrastructure even when `ADS_AGENT_RUNTIME=codex-app-server`.
2. It hardcoded `streaming: false` without transient retries, causing reverse proxies and upstream providers to drop long reasoning requests before response headers arrived, while `responses.rs` hid underlying `reqwest::Error` sources.
3. Its isolated verification helper cleared environment variables without adding `$CARGO_HOME/bin` to `PATH`, causing `cargo test` to exit `127` under `systemd`, and discarded the Reviewer's actual `INCOMPLETE` summary.

## Decision

- **Follow the Active Runtime Backend**: `ads-server` wires `ReviewQueueOptions.reviewer` according to `ADS_AGENT_RUNTIME`. Under `CodexAppServer`, Actions Reviewer jobs execute through `ads_codex_app_server::run_codex_review` using a fresh, stateless, clean-room `CodexAppServerAgent` thread and `resolve_codex_model_selection`. Under `Native`, Actions Reviewer uses the native inspection runner.
- **Enforce Review Boundaries in the Runtime**: Introduce `SandboxMode::ReviewVerification` on `CodexAppServerAgent`. Both `ReadOnly` and `ReviewVerification` omit `review_action` from `dynamicTools`, decline `item/fileChange/requestApproval`, and reject mutating `git`/`gh`/`cargo fmt` commands in `handle_command_approval`. `ReviewVerification` permits offline workspace-scoped test compilation (`cargo test`, `npm test`) while `ads-actions` continues to verify a clean tracked worktree and exact commit SHAs after review.
- **Bounded Daemon Pooling & Verification Capture**: Pool Reviewer app-server daemons under a per-project `reviewer::<canonical_project_id>` key so processes are reused cleanly without leaking or colliding with Acopilot. Capture completed verification commands (unwrapping shell wrappers such as `bash -lc '...'` and excluding pure inspection commands) into `ReviewVerificationReport`.
- **Harden the Native Reviewer Path**: Switch `ads-native` Reviewer requests to `streaming: true`, add transient upstream retries matching `NativePromptRunner`, preserve the Reviewer's actual `INCOMPLETE` summary, augment `PATH` with `$CARGO_HOME/bin` when present, and format the full `std::error::Error::source()` chain on transport failures.

## Consequences

- Production `codex-app-server` deployments run Actions reviews on the same proven runtime, provider routing, streaming, retry, and tool execution stack as Acopilot, while remaining clean-room and read-only toward tracked repository state.
- Native-runtime deployments gain streaming, transient retries, `$CARGO_HOME/bin` discovery, and actionable `INCOMPLETE` / transport diagnostics.
- Both runtime paths preserve ADR 0060's requirement that `PASS` is backed by at least one started, successful verification command.
