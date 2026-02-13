# Implementation: Telegram Voice Transcription

## Steps

1. Add shared transcription helper
   - Add `src/audio/transcription.ts`
   - Implement provider selection + fallback + timeout + model mapping

2. Refactor Web audio route
   - Update `src/web/server/api/routes/audio.ts` to use the shared helper
   - Keep the existing API contract and status codes
   - Ensure existing tests continue to pass

3. Add Telegram voice handler
   - Update `src/telegram/bot.ts` to handle `message:voice`
   - Pass `voice.file_id` into `handleCodexMessage(...)`

4. Transcribe voice in Telegram adapter
   - Update `src/telegram/adapters/codex.ts`
   - Download voice via `downloadTelegramFile(...)`
   - Call shared helper
   - Merge caption + transcription into the final prompt text
   - Cleanup temporary voice file

5. Tests
   - Add `tests/audio/transcription.test.ts` to validate provider/model selection.
   - Add `tests/telegram/voiceTranscription.test.ts` to validate Telegram voice flow with stubbed download.

## Verification

Run:

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`

If frontend changes are introduced (not expected): also run `npm run build`.

