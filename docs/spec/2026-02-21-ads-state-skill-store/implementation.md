# Implementation

## Code Changes

1. Skill discovery
   - `src/skills/loader.ts`
     - Add `$ADS_STATE_DIR/.agent/skills` and `<ADS_REPO_ROOT>/.agent/skills` as discovery roots.
     - Default to ignoring `workspaceRoot/.agent/skills`; support opt-in via `ADS_ENABLE_WORKSPACE_SKILLS=1`.
2. Registry metadata
   - `src/skills/registryMetadata.ts`
     - Prefer `$ADS_STATE_DIR/.agent/skills/metadata.yaml` over `workspaceRoot`.
     - Only consider `workspaceRoot` metadata when `ADS_ENABLE_WORKSPACE_SKILLS=1`.
3. Autosave skills to central store
   - `src/agents/orchestrator.ts`
     - Persist `<skill_save>` into `$ADS_STATE_DIR/.agent/skills`.
4. Skill commands default to central store
   - `src/web/commandRouter.ts`
     - `/ads.skill.init` uses `$ADS_STATE_DIR` as workspaceRoot.
     - `/ads.skill.validate` (name form) validates `$ADS_STATE_DIR/.agent/skills/<name>`.

## Tests

- Update skill loader tests to build skills under `$ADS_STATE_DIR/.agent/skills` and assert:
  - Central store skills are discovered.
  - Workspace skills are ignored by default.
  - `ADS_ENABLE_WORKSPACE_SKILLS=1` restores legacy discovery.
- Update autosave tests to assert `<skill_save>` writes into `$ADS_STATE_DIR/.agent/skills`.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

