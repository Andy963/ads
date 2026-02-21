# Implementation

## Code Changes

- `src/web/server/api/routes/taskBundleDrafts.ts`
  - Remove use of `taskCtx.lock.runExclusive(...)` in the approve handler.
  - Only run queue side effects when this request successfully marks the draft as `approved`.
  - If `approveTaskBundleDraft(...)` returns `null`, re-read the draft:
    - If already `approved`, return 200 success with `approvedTaskIds` and do not re-run side effects.
    - Otherwise return a clear conflict error.
- `tests/web/taskBundleDraftsRoute.test.ts`
  - Add a test ensuring approval does not call the workspace lock.
  - Add a test covering the `approveTaskBundleDraft(...) === null` race path (already-approved draft returns 200, no side effects).

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

