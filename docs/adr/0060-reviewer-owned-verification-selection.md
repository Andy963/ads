# ADR 0060: Reviewer-Owned Verification Selection

## Status

Accepted

## Context

Actions previously ran one command selected by the queue before the Reviewer started. The choice was derived from process configuration or package-presence heuristics. In mixed repositories this could report a successful but unrelated suite as evidence for the reviewed diff.

## Decision

- The Reviewer selects verification commands after inspecting the pinned diff and repository snapshot. ADS does not infer a command from language markers, package manifests, or a process-wide command override.
- Verification is requested through a dedicated argv-based Reviewer tool. Each command runs in a disposable writable copy materialized from the exact reviewed Git blobs, not in the mutable project checkout.
- Commands run as the ADS service user with a cleared environment, offline package-manager hints, 30-minute timeout, and per-process CPU-time (1,800 seconds), address-space (4 GiB), process-count (512), and file-size (1 GiB) limits. The runner is not an OS sandbox: commands can access files and network available to the service user. The Reviewer must choose relevant non-destructive checks and return INCOMPLETE if they cannot be run safely.
- Verification commands have bounded count, 512 MiB tracked-source size, 1,024-character command size, and 6,000-character captured output. The report records each selected command, whether its executable started, exit code, summary, and output, and persists the evidence with the Actions review job.
- A PASS requires at least one trustworthy verification command to exit successfully. Non-zero checks remain available for review but cannot be the sole basis of PASS. If no relevant command can be selected or safely executed, the Reviewer returns INCOMPLETE rather than substituting unrelated results.

## Consequences

- Rust, TypeScript, Go, Python, and mixed repositories can select checks based on their actual changes without server configuration.
- The Reviewer has more responsibility: it must explain command relevance and judge failing checks against the diff.
- Commands that need network access, submodules, unsupported repository paths, or unavailable toolchains/dependencies cannot provide verification evidence; the safe outcome is INCOMPLETE. A dependency cache can accelerate a run but cannot replace the lockfile or source in the pinned snapshot.
- The mutable project checkout is not used as the command working tree. Generated files remain confined to the disposable reviewed snapshot.
