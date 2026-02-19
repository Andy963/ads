# Remove Amp/Droid Agent Support - Requirements

## Goal
- Keep only `codex`, `claude`, and `gemini` as supported runtime agents.
- Remove `amp` and `droid` from adapter registration and availability probing.
- Ensure Web/Telegram agent snapshots never expose `amp`/`droid`.

## Non-goals
- No database schema changes.
- No change to Codex/Claude/Gemini adapter behavior.
- No migration for historical chat/task records.

## Constraints
- Hard remove source code and tests for `amp`/`droid` adapters/parsers.
- Keep `/agent` flow working for remaining agents.
- Update docs to match runtime behavior.

## Acceptance Criteria
- `SessionManager` no longer imports or registers `AmpCliAdapter` / `DroidCliAdapter`.
- `CliAgentAvailability` default probe set excludes `amp` and `droid`.
- Model-based agent selection no longer maps to `amp` or `droid`.
- Deleted files are not referenced by any source/test import.
- README/ADR do not claim `amp` or `droid` runtime support.

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
