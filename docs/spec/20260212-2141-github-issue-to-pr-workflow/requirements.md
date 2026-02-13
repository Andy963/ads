# GitHub Issue-to-PR Workflow - Requirements

## Goal
- Provide first-class GitHub issue discovery and assisted fixing workflow inside ADS.
- Default to read-only operations; require explicit user confirmation for any write operations.
- Support end-to-end flow: find issue -> plan -> apply -> verify -> optional PR creation.

## Non-goals
- No fully autonomous background code changes or PR creation without explicit user request.
- No storing GitHub tokens/credentials in ADS (reuse `gh auth` by default).
- No automatic closing/labeling/commenting on issues by default.

## Constraints
- Any write action (`git commit`, `git push`, `gh pr create`, issue comment/close/label) must require explicit confirmation.
- Must not add `Co-authored-by` lines.
- Must not delete/overwrite any database files.
- Prefer predictable, auditable behavior (clear logs of what was executed).

## Acceptance Criteria
- Can list/search issues for the default repo (derived from `git remote origin`) and an explicitly provided repo.
- Can fetch a single issue by number and render a concise summary + suggested next actions.
- Can generate a deterministic plan that performs no write operations.
- Can execute the plan only after explicit confirmation, and refuse otherwise.
- Can optionally create a PR via `gh` after verification passes (still gated).

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`
