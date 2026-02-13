# Design: Telegram Voice Transcription

## Overview

We add a Telegram-only feature to transcribe `message:voice` payloads and feed the resulting text into the existing Codex session flow.

The key constraint is model/provider parity with Web. To avoid drift, we extract the Web audio transcription core into a shared helper that both Web and Telegram call.

## Architecture

### Shared helper

Create `src/audio/transcription.ts`:

- Input: `{ audio: Buffer, contentType?: string, logger }`
- Output: `{ ok: true, text, provider }` or `{ ok: false, error, timedOut }`
- Provider selection:
  - `ADS_AUDIO_TRANSCRIPTION_PROVIDER` in `{together, openai}` (default `together`)
  - Both providers are attempted in order with fallback to the other.
- Models:
  - Together: `openai/whisper-large-v3`
  - OpenAI-compatible: `whisper-1`
- Credentials and base URL:
  - Together: `TOGETHER_API_KEY`
  - OpenAI: `OPENAI_API_KEY || CODEX_API_KEY || CCHAT_OPENAI_API_KEY`
  - Base URL: `OPENAI_BASE_URL || OPENAI_API_BASE || CODEX_BASE_URL || https://api.openai.com/v1`
- Timeout:
  - `ADS_TOGETHER_AUDIO_TIMEOUT_MS` (applies to both attempts), minimum 1000ms.

### Web route

Refactor `src/web/server/api/routes/audio.ts` to call the shared helper and translate result to the existing HTTP status codes:

- Empty audio: `400`
- Timeout: `504`
- Upstream/other failure: `502`
- Success: `200 { ok: true, text }`

### Telegram integration

In `src/telegram/bot.ts`:

- Add handler for `message:voice`.
- Pass the voice file id to the Codex adapter.

In `src/telegram/adapters/codex.ts`:

- Accept an optional `voiceFileId`.
- If present:
  - Download via existing `downloadTelegramFile(...)` (already handles proxy + timeout + size checks).
  - Read file into `Buffer`.
  - Call shared transcription helper.
  - Compose final text:
    - If caption exists: `caption + "\\n\\n" + transcription`
    - Else: `transcription`
  - Ensure temporary voice file is cleaned up.

## Risks / Mitigations

- **Duplicate logic drift**: mitigated by shared helper used by both Web and Telegram.
- **Telegram download failures**: use existing download helper and show a clear error to user.
- **Large audio**: keep the existing 20MB download cap and reject early.

