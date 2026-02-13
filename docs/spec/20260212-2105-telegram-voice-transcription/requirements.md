# Requirements: Telegram Voice Transcription

## Goal

Allow Telegram users to send a voice message and have the bot:

1. Download the voice file from Telegram Bot API.
2. Transcribe it using the same provider/model selection as the Web audio transcription endpoint.
3. Use the transcription text as the user input for the Codex session (optionally combined with the message caption).

## Non-Goals

- No UI changes on Web.
- No persistent storage of raw audio files beyond temporary download.
- No change to the existing Web audio transcription API contract.

## Functional Requirements

1. **Voice message support**
   - Handle Telegram updates of type `message:voice`.
   - If a caption exists, include it in the final prompt together with the transcription.

2. **Model/provider consistency with Web**
   - Transcription must use the same provider selection and model identifiers as Web:
     - Together: `openai/whisper-large-v3`
     - OpenAI-compatible: `whisper-1`
   - Provider preference must follow `ADS_AUDIO_TRANSCRIPTION_PROVIDER` and fallback behavior must match Web.

3. **Download constraints**
   - Respect Telegram Bot API download limits (existing file download limit is 20MB).
   - Apply a timeout for downloading voice and for transcription, consistent with Web configuration.

4. **Error handling**
   - If download fails: report a user-friendly error in Telegram.
   - If transcription fails or returns empty text: report a user-friendly error in Telegram.

## Acceptance Criteria

- When a user sends a voice message in Telegram, the bot responds as if the user typed the transcribed text.
- Changing `ADS_AUDIO_TRANSCRIPTION_PROVIDER` affects both Web and Telegram transcription behavior.
- Unit tests cover:
  - The shared transcription helper calls the expected upstream URL and model.
  - Telegram voice handling uses the shared helper and produces combined text with caption.

