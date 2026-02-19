# Remove Amp/Droid Agent Support - Design

## Approach
- Remove `amp`/`droid` from all runtime wiring points instead of hiding them in UI.
- Delete implementation files for removed adapters/parsers to prevent accidental reuse.
- Keep agent identifier typing open (`AgentIdentifier = "codex" | string`) to avoid broad refactors.
- Preserve existing orchestration and delegation flow for `codex` supervisor with `claude`/`gemini` collaborators.

## Key Decisions
- Perform hard deletion over feature flags for removed agents.
- Keep Web client rendering generic (`agents` snapshot driven) and only change server-side sources.
- Update availability tests to validate behavior with retained agents only.

## Risks
- Stale imports may survive in less-covered paths and break compile.
- Historical documentation/specs may still mention removed agents as archived context.

## Compatibility
- Existing sessions still default to `codex`.
- `/agent` command behavior is unchanged for valid remaining agent IDs.
- Unknown agent IDs continue to be rejected by orchestrator/session switching.

## Open Questions
- Whether to narrow `AgentIdentifier` into a strict union is deferred.
