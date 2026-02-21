# Implementation

## Code Changes

- `src/telegram/bot.ts`
  - Add `/draft` command to create a persisted draft and reply with a preview + inline buttons.
  - Add callback handlers for `td:confirm:<draftId>` / `td:cancel:<draftId>`.
- `src/telegram/utils/taskDrafts.ts`
  - Implement create/confirm/cancel helpers:
    - Persist draft using existing draft store (`namespace="telegram"`).
    - Confirm enqueues queued tasks using `draft.workspaceRoot` only (idempotent).
    - Cancel marks draft deleted (draft-only).
- `tests/telegram/taskDrafts.test.ts`
  - Verify: confirm enqueues once; confirm uses draft workspace (not current); cancel prevents confirm; repeated confirm idempotent.
- `README.md`
  - Document the new `/draft` command in Telegram Bot commands table.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

