# ADR 0060: Reviewer-Owned Verification Selection

## Status

Accepted

## Context

Actions previously ran one command selected by the queue before the Reviewer started. The choice was derived from process configuration or package-presence heuristics. In mixed repositories this could report a successful but unrelated suite as evidence for the reviewed diff.

## Decision

- The Reviewer selects verification commands after inspecting the pinned diff and repository snapshot. ADS does not infer a command from language markers, package manifests, or a process-wide command override.
- Verification is requested through a dedicated argv-based Reviewer tool. Commands run in a fresh writable copy materialized from the exact reviewed Git blobs inside a namespace-isolated sandbox; the source snapshot is mounted read-only.
- The sandbox starts with a cleared environment, no network, a bounded temporary filesystem and writable workspace, and read-only toolchain/dependency caches for Cargo, npm, Go, and pip when present. It never mounts a host `node_modules` tree into the reviewed source.
- Verification commands have bounded count, duration, tracked-source size, writable filesystem size, command length, and captured output. The report distinguishes sandbox startup from executable startup. Sandbox setup failures or reviews without a started check are recorded separately from test failures and make a PASS verdict incomplete.
- Each selected command, exit code, summary, output, and sandbox status is persisted with the Actions review job and presented as review evidence.
- A PASS requires at least one trustworthy verification result. If no relevant command can be selected or safely executed, the Reviewer returns INCOMPLETE rather than substituting unrelated results.

## Consequences

- Rust, TypeScript, Go, Python, and mixed repositories can select checks based on their actual changes without server configuration.
- The Reviewer has more responsibility: it must explain command relevance and judge failing checks against the diff.
- Commands that need network access, submodules, unsupported repository paths, or unavailable toolchains/dependencies cannot provide verification evidence; the safe outcome is INCOMPLETE. A dependency cache can accelerate a run but cannot replace the lockfile or source in the pinned snapshot.
- The mutable project checkout is not used as the command working tree. Generated files remain confined to the disposable reviewed snapshot.
