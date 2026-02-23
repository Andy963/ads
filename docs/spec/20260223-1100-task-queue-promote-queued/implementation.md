# Task Queue: Promote queued tasks while running - Implementation

## Steps

1. Add a small guard helper at queued-task creation points:
   - If `queueRunning` and mode is `all`, call `promoteQueuedTasksToPending()`.
2. Update existing route tests to assert the new behavior and protect `single` mode.

## Files Touched

- `src/web/server/api/routes/tasks.ts` — call `promoteQueuedTasksToPending()` after creating queued tasks when queue is already running in `all` mode.
- `src/web/server/api/routes/taskBundleDrafts.ts` — call `promoteQueuedTasksToPending()` after approval when queue is already running in `all` mode (even if `runQueue=false`).
- `tests/web/tasksRoute-create-queued.test.ts` — update/create tests for the promotion trigger.
- `tests/web/tasksRoute-rerun-bootstrap.test.ts` — update stubs for `runController`/`queueRunning` if needed.

## Tests

- Add/adjust tests to cover:
  - Create task while queue running (`all` mode) triggers promotion call.
  - Create task while queue paused does not trigger promotion.
  - (Optional) Create task while `single` mode does not trigger promotion.

## Verification

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`

## Assumptions

- Web `TaskQueueContext` always provides `runController.getMode()` (true for normal server runtime).

