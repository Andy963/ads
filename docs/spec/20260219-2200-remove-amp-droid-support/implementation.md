# Remove Amp/Droid Agent Support - Implementation

## Steps
1. Remove `AmpCliAdapter`/`DroidCliAdapter` imports and registration from `SessionManager`.
2. Remove `amp`/`droid` defaults from `CliAgentAvailability`.
3. Remove model-to-agent fallback rules for `amp`/`droid` in task agent selection.
4. Delete source files for removed adapters and stream parsers.
5. Delete tests dedicated to removed implementations.
6. Update docs (`README`, `ADR`) to reflect supported agents.
7. Update residual tests that referenced removed agent IDs.

## Files Touched
- `src/telegram/utils/sessionManager.ts` — remove removed-agent wiring.
- `src/agents/health/agentAvailability.ts` — reduce default probe set.
- `src/tasks/agentSelection.ts` — remove removed-agent model mapping.
- `src/agents/cli/cliRunner.ts` — remove obsolete amp-specific comment.
- `README.md` — remove Droid runtime section.
- `docs/adr/0001-ads-core-architecture.md` — update supported agent list.
- `tests/agents/agentAvailability.test.ts` — replace `amp` assertions with retained agent assertions.
- Deleted: `src/agents/adapters/ampCliAdapter.ts`, `src/agents/adapters/droidCliAdapter.ts`, `src/agents/cli/ampStreamParser.ts`, `src/agents/cli/droidStreamParser.ts`, `tests/agents/ampStreamParser.test.ts`, `tests/agents/droidCliAdapter.test.ts`, `tests/agents/droidStreamParser.test.ts`.

## Tests
- Ensure test suite has no imports from deleted files.
- Ensure availability tests still validate merge/timeout/retry behavior.

## Verification
- `npx tsc --noEmit`
- `npm run lint`
- `npm test`

## Assumptions
- `amp`/`droid` support is intentionally and permanently removed in this repo.
