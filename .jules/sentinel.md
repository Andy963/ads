## 2026-02-16 - Raw Error Message Leak
**Vulnerability:** The HTTP server (`src/web/server/httpServer.ts`) was catching API errors and sending the raw `error.message` to the client in a 500 response. This could leak sensitive internal details (stack traces, SQL errors, file paths) to attackers.
**Learning:** The error handling was too simplistic, prioritizing debugging convenience over security. It assumed `error.message` was safe for public consumption.
**Prevention:** Always sanitize error messages sent to the client. Log the full error server-side, but return a generic "Internal Server Error" message to the user.
