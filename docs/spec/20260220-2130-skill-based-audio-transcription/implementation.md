# Implementation

## Code Changes

- `src/audio/transcription.ts`
  - Remove provider-specific transcription logic.
  - Implement transcription via executing skills (scripts) and reading stdout.
- `src/telegram/utils/voiceTranscription.ts`
  - Allow injecting a transcriber for tests; default to `transcribeAudioBuffer()` (skill-based).
- `src/web/server/api/routes/audio.ts`
  - Allow injecting a transcriber for tests; default to `transcribeAudioBuffer()` (skill-based).
- `.agent/skills/metadata.yaml`
  - Configure `audio.transcribe` priority: Groq > Gemini > OpenRouter.
- `.gitignore`
  - Track `.agent/skills/metadata.yaml` while keeping other `.agent/skills/**` ignored.

## Tests

- `tests/audio/transcription.test.ts`
  - Cover priority selection and fallback behavior via injected executor.
- Update existing tests that previously mocked Together/OpenAI fetch calls:
  - `tests/telegram/voiceTranscription.test.ts`
  - `tests/web/audioTranscriptionsRoute.test.ts`

## Verification

```bash
npx tsc --noEmit
npm run lint
npm test
```

