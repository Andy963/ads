# Untrack Agent Skills - Requirements

## Goal
- Stop tracking all files under `.agent/skills/` in Git.
- Keep local skill files on disk (remove from Git index only).

## Non-goals
- No rewriting Git history.
- No behavior change outside Git tracking/ignore rules.

## Constraints
- Must not delete any local skill files.
- Must not run `git commit`/`git push`.

## Acceptance Criteria
- `git status` no longer shows any tracked changes under `.agent/skills/`.
- Previously tracked `.agent/skills/` files are removed from the Git index.
- `.agent/skills/` is ignored so existing and future skills do not show as untracked.

## Verification
- `git status -sb`
- `git ls-files .agent/skills | wc -l` returns `0`

