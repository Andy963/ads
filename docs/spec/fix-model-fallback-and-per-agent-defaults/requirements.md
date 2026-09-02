# Worker Requirements: Fix Model Fallback and Support Per-Agent Default Models

## 1. Goal
Eliminate aggressive fallback overwrites that mutate active/stored session models on reload, and refactor the model configuration system so each agent CLI (`codex`, `claude`, `droid`) can have its own independent default model.

## 2. Scope of Changes

### Backend / Store:
1. `server/state/globalModelConfigStore.ts`:
   - Refactor `is_default` behavior: allow at most one default model per agent (based on `allowedAgents` / provider mapping) rather than one default globally across all agents.
   - Update statement to only clear existing defaults within the same target agent scope when a new default is assigned.
2. `server/tasks/storeStatements.ts` & `server/tasks/storeImpl/modelConfigOps.ts`:
   - Align the same per-agent default scoping logic in the task store statements.

### Frontend:
1. `client/src/app/tasks.ts`:
   - In `ensureRuntimeModelId` and `alignRuntimeModelForAgent`:
     - Strictly preserve the existing `rt.modelId.value` or `storedModelId`.
     - Never overwrite the active session model with a default model simply because of list reload or unrecognized custom model ID.
     - Default models should only serve as the initial model for a freshly created, unconfigured session.
2. `client/src/components/ModelManager.vue`:
   - Allow setting one default model per CLI group accordion.
   - Update footer text from "默认模型全局只有一个" to "每个 CLI 拥有各自独立的默认模型".
3. `client/src/components/MainChatComposerPanel.vue`:
   - Ensure model picker options strictly respect the active agent and do not mutate `activeAgentId`.

## 3. Verification & Testing

1. `npm run test:web`
2. `npm test`
3. Verify clean worktree and standalone branch: create dedicated worktree `ads-issue-model-fallback` with branch `issue-model-fallback`.
4. Run lint and build: `npm run lint` && `npm run build:web`.
