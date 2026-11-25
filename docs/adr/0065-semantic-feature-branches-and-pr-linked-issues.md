# ADR 0065: Allow Semantic Feature Branches and Resolve Backing Issues from PR Bodies

## Status

Accepted — 2026-11-25.

## Context

Early ADS automation (ADR 0014 and ADR 0044) required every reviewed feature branch to follow the tool-namespaced format `codex/issue-<id>`. The Actions review resolver enforced `codex/issue-` as a hard prerequisite and extracted the GitHub Issue ID strictly from the branch name before validating the pull request.

In practice, this coupling creates two problems:
1. **Tool Leakage & Low Readability**: ADS supports multiple model providers and runtimes rather than Codex alone. Prefixing repository branches with `codex/` exposes implementation tooling in Git history and gives less immediate context than standard semantic prefixes such as `feat/`, `fix/`, `refactor/`, `docs/`, or `chore/`.
2. **Redundant Source of Truth**: The review target resolver already fetches the open pull request via `gh pr list --head <branch>` and verifies that its body links the backing Issue (`Closes #<id>`). Requiring the Issue ID to be encoded in a rigid branch prefix duplicates state that already belongs authoritatively on the pull request.

## Decision

- **Decouple Review Target Validation from Branch Prefixes**: `rust-server` (`ads-actions`) accepts any checked-out, non-protected feature branch for pull-request review. Detached HEAD and protected branches (`dev`, `main`, `master`) remain rejected. The retired `ts-server` implementation is intentionally left untouched.
- **PR Body as Authoritative Issue Source**: The review target resolver extracts unique closing Issue references (`Closes`, `Fixes`, `Resolves` with `#<id>`, case-insensitive, optional colon) from the pull request body. Exactly one distinct linked Issue is required; zero or multiple distinct linked Issues fail closed with an `INCOMPLETE` outcome. Repeated references to the same Issue are deduplicated.
- **Recommended Semantic Branch Convention**: Feature branches should use `<type>/<issue-id>-<short-slug>` (for example `fix/681-turn-timeout`, `feat/700-ws-reconnect`, `refactor/701-semantic-branches`), while branches without an embedded Issue ID or with an unrelated numeric token remain valid because the PR body is authoritative.
- **Best-Effort Enqueue Hint & Legacy Compatibility**: `issue_id_from_branch` remains an optional enqueue-time hint supporting both semantic branches (`<type>/<id>-<slug>`, `<type>/issue-<id>`) and legacy `codex/issue-<id>` branches. Target pinning always overwrites the job's `issue_id` with the PR-body-verified Issue ID.

## Consequences

- Contributors and Acopilot sessions can use readable, tool-agnostic semantic branch names without breaking `review_action`, while existing `codex/issue-<id>` branches and historical action job records continue to work unchanged.
- Single-Issue-per-PR enforcement moves to the authoritative GitHub pull request link (`Closes #<id>`), preventing ambiguous multi-Issue PRs and eliminating false rejections when a branch name omits or differs from an Issue number.
- Operational errors occurring before target pinning still retain best-effort Issue comment routing when the branch follows the `<type>/<id>-<slug>` or legacy `codex/issue-<id>` convention; branches without an embedded ID log the unpinned status in the Actions lane instead of guessing.
