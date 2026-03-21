## 2025-03-21 - [Leaking Error Stack Traces in Prompt Handlers]
**Vulnerability:** The application was logging the error stack trace (`error.stack`) to the `sessionLogger` in `server/web/server/ws/handlePrompt.ts` and `server/telegram/adapters/codex.ts`. This exposed internal implementation details, dependency versions, and file paths.
**Learning:** This existed because the error handling logic was trying to be too helpful for debugging purposes, but inadvertently exposed sensitive stack trace data in production or user-facing logs.
**Prevention:** Always fall back to `error.message` for logging user-facing or session-facing errors. Never expose `error.stack` outside of strictly controlled, internal server logs.
