# Implementation

## Plan

1. Stop persisting terminal agent commands as replayable chat history.
2. Change frontend turn completion so transient agent execute previews are cleared instead of finalized.
3. Keep explicit user command results replayable.
4. Update regression tests and run project checks.

## Code Changes

- `server/web/server/ws/workerPromptHandler.ts`
  - Keep live `command` events.
  - Remove `historyStore.add(... kind: "execute")` for terminal agent commands.

- `client/src/app/chatExecute.ts`
  - Replace finalize-on-result behavior for transient execute previews with cleanup-on-result behavior.

- `client/src/app/projectsWs/wsMessage.ts`
  - Continue to call the cleanup behavior when a normal model result arrives.
  - Keep explicit `result.kind === "execute"` handling for user command results.

- `tests/web/workerPromptHandler.test.ts`
  - Assert agent command events are not persisted as replayable `execute` history.

- `client/src/__tests__/command-ui-lifecycle.test.ts`
  - Assert live previews appear during a turn and disappear after final result.

## Verification

Run narrow tests first, then full project checks:

```bash
npx vitest run client/src/__tests__/command-ui-lifecycle.test.ts client/src/__tests__/ws-workspace-project-sync.test.ts
node --import tsx --test tests/web/workerPromptHandler.test.ts tests/web/bootstrapDelivery.test.ts tests/web/contextResume.test.ts
npx tsc --noEmit
npm run lint
npm test
npm run build
```
