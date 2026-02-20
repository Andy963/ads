# Implementation

## Code Changes

- `src/skills/registryMetadata.ts`
  - Load and parse `metadata.yaml` from `resolveAdsStateDir()/.agent/skills/metadata.yaml`.
  - Provide helpers to query `mode`, `enabled`, `priority`, `provides`.
- `src/agents/orchestrator.ts`
  - Update `inferRequestedSkills()` to apply metadata rules and group-by-`provides` selection.
- `tests/agents/skillAutoloadPriority.test.ts`
  - Add regression tests for same-function dedupe and priority selection (use temp ADS_STATE_DIR).

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

