# Implementation: Workspace Detector Root Normalization

## Change List

### Backend

- `server/workspace/detector.ts`
  - Add a shared helper for explicit workspace root normalization.
  - Route detector public helpers through that shared helper.
  - Keep `initializeWorkspace()` no-argument behavior unchanged while normalizing explicit nested paths.

### Tests

- `tests/workspace/detector.test.ts`
  - Add nested-path regression coverage for initialization, db/rules/spec directories, and template bootstrap.

### Docs

- `docs/REFACTOR.md`
  - Record modules reviewed in this pass, the landed refactor, related test coverage, and remaining backlog.

## Steps

1. Add one internal helper in `server/workspace/detector.ts` for explicit workspace normalization.
2. Update public detector helpers to use the shared helper.
3. Extend detector tests to cover nested child paths inside a git workspace.
4. Update `docs/REFACTOR.md` with this pass.

## Tests

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`

## Notes

- `server/storage/database.ts` was reviewed to verify that it ultimately delegates to `getWorkspaceDbPath()`. No direct code change was required in this pass.
