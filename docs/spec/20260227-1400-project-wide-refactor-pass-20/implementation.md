# Implementation

## Changes

1. Task notification helper consolidation
   - `src/web/taskNotifications/store.ts`
   - Added shared normalize/parse helpers for timestamps/integers/text.
   - Added shared terminal status source (`TERMINAL_TASK_STATUSES`) and exported `isTaskTerminalStatus()`.
   - Reused shared constants/helpers in due-list and send-lease queries.

2. Telegram notifier dedupe and formatter cache
   - `src/web/taskNotifications/telegramNotifier.ts`
   - Reused `isTaskTerminalStatus()` for terminal state guard.
   - Added timezone-keyed `Intl.DateTimeFormat` cache to avoid rebuilding formatter on each notification render.

3. Live activity helper extraction
   - `web/src/lib/live_activity.ts`
   - Replaced category switch with mapping constant.
   - Added helper functions for max-step normalization, pending-command consumption, and latest-step lookup.
   - Kept markdown rendering and command pairing semantics unchanged.

4. Regression tests
   - `tests/web/taskTerminalTelegramNotifications.test.ts`
   - Added terminal status predicate coverage (case-insensitive + invalid values).
   - `web/src/lib/live_activity.test.ts`
   - Added fallback max-step, latest pending command, and unknown category normalization coverage.

5. Tracker/spec sync
   - `docs/spec/20260227-1400-project-wide-refactor-pass-20/*`
   - `docs/REFACTOR.md`

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
npm run build
```
