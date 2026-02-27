# Implementation

## Changes

1. Backend command validation dedupe
   - `src/utils/commandRunner.ts`
     - Added `isGitPushCommand()` and `assertCommandAllowed()`.
     - Reused `assertCommandAllowed()` in `runCommand()` to keep allowlist/git-push checks centralized.
   - `src/bootstrap/commandRunner.ts`
     - Removed duplicated allowlist/git-push helpers.
     - Reused `assertCommandAllowed()` before sandbox wrapping.

2. Backend regression test update
   - `tests/utils/commandRunner.test.ts`
   - Added coverage to ensure `assertCommandAllowed("git", ["push"], ["git"])` is rejected.

3. Frontend task bundle draft actions refactor
   - `web/src/app/taskBundleDrafts.ts`
   - Added `withDraftRequest()` and `fetchTaskBundleDrafts()` to dedupe request lifecycle handling.

4. Frontend project normalization refactor
   - `web/src/app/projectsWs/projectActions.ts`
   - Added shared normalization helpers for stored/remote project tabs.

5. Frontend task event payload parsing refactor
   - `web/src/app/tasks/events.ts`
   - Added parsing helpers and switched event branches to consume normalized payload objects.

6. Tracker update
   - `docs/REFACTOR.md`
   - Recorded reviewed modules and pass-19 documentation entry.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
