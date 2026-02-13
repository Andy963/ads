# Untrack Agent Skills - Design

## Approach
- Add `.agent/skills/` to `.gitignore` to prevent future tracking/untracked noise.
- Remove existing tracked `.agent/skills/` entries from the Git index via `git rm -r --cached`.
- Do not touch working tree files so local skills remain usable.

## Key Decisions
- Prefer ignoring the entire directory over per-skill patterns to avoid drift.
- Use `git rm --cached` (index-only) to satisfy "untrack, not delete".

## Risks
- Large staged diff showing deletions (index removals) can surprise reviewers.
- If any required runtime file lives under `.agent/skills/`, it will no longer be versioned (**Assumption**: skills are local-only artifacts).

## Compatibility
- Existing local workflows relying on `.agent/skills/` continue to work.
- Clean clones will no longer include skills; users must rely on local skill installation.

## Open Questions
- Should we keep a tracked placeholder directory (e.g. `.agent/skills/.gitkeep`)? (**Assumption**: no)

