# Implementation

## Code Changes

- `src/telegram/utils/pendingTranscriptions.ts`
  - Add in-memory pending transcription store (TTL=5min, idempotent consume/discard).
- `src/telegram/bot.ts`
  - Change `message:voice` handler: transcribe → send preview message with inline keyboard → store pending item; do not call model.
  - Add `callbackQuery` handlers for `vt:submit` / `vt:discard`:
    - `Submit` calls existing `handleCodexMessage()` with stored text.
    - `Discard` removes pending item.
    - TTL/expired + idempotent behaviors.
- `tests/telegram/pendingTranscriptions.test.ts`
  - Cover TTL expiry and idempotent consume/discard semantics.

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

