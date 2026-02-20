# Implementation

## Code Changes

- `src/skills/registryMetadata.ts`
  - Load and parse `metadata.yaml` from `workspaceRoot/.agent/skills/metadata.yaml` (fallback to global and ADS state dir).
  - Provide helpers to query `mode`, `enabled`, `priority`, `provides`.
- `src/agents/orchestrator.ts`
  - Update `inferRequestedSkills()` to apply metadata rules and group-by-`provides` selection.
- `tests/agents/skillAutoloadPriority.test.ts`
  - Add regression tests for same-function dedupe and priority selection (write metadata under temp `workspaceRoot/.agent/skills/metadata.yaml`).

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```
