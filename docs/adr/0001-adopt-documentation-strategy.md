# 0001. Adopt ADS Documentation Strategy

## Context
As the project grows, context window limits and agent hallucinations regarding system state become a bottleneck. We need a structured way to separate specification (What), decision history (Why), and current state (Is).

## Decision
Adopt the "Plan A: Strict Mode" documentation strategy as defined in `docs/DOCUMENTATION_STRATEGY.md`.
This involves:
1. Maintaining ADRs for all non-trivial decisions.
2. Maintaining a single `project_state.md` for current system facts.
3. Enforcing a "Finalization Gate" for all agent tasks.

## Alternatives Considered
*   **Option A: README-only**: Too cluttered, hard to find specific history.
*   **Option B: Code Comments**: Brittle, easily outdated, doesn't capture "Why".
*   **Option C: Lightweight documentation**: High risk of "Context Drift" where the agent forgets system rules.

## Consequences
*   **Positive**: Near-perfect memory of system invariants; faster onboarding for new agents.
*   **Negative**: Slight overhead in updating docs during implementation.

## Links
*   `docs/DOCUMENTATION_STRATEGY.md`
