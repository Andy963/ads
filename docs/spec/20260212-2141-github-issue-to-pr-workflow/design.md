# GitHub Issue-to-PR Workflow - Design

## Approach
- Add a `github` integration module that wraps `gh` CLI for issue/PR operations.
- Split operations into `read` vs `write` capability classes; `write` requires explicit confirmation.
- Use a two-phase workflow:
  - Phase 1: `plan` (collect issue context, propose branch name, propose patch set, propose commands)
  - Phase 2: `apply` (execute only after confirmation token is provided)
- Derive default repo from workspace git config (`remote.origin.url`) with a robust parser.

## Key Decisions
- Prefer `gh` CLI over direct REST calls to reuse existing user auth (`gh auth status`).
- Implement a confirmation token (short-lived) to bind `apply` to a previously generated `plan`.
- Keep `git push` gated; if the repo currently hard-blocks push, either:
  - (A) keep push blocked and output exact manual commands, or
  - (B) allow push only when `user_explicit_request=true` and confirmation token is valid.

## Risks
- Accidental writes: mitigated by capability split + token + explicit request checks.
- Repo detection edge cases (SSH/HTTPS URLs, enterprise hostnames).
- `git push` hard-blocks in current code paths may require careful refactor to keep safety invariants.

## Compatibility
- No DB schema changes required.
- Default behavior remains unchanged unless user invokes GitHub workflow explicitly.

## Open Questions
- What is the default “issue query” behavior when user says “default” (assigned-to-me vs open issues vs label-filter)?
- Should PR creation include templates (title/body) derived from issue content, and how customizable should it be?
- Background mode (“idle”) should be:
  - off by default and only run when explicitly enabled, or
  - always-on but read-only.
