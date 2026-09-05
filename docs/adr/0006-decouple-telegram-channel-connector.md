# ADR 0006: Decouple Telegram Channel Connector from ADS Core

## Status

Accepted

## Context

Historically, the Telegram Bot was deeply coupled within ADS Core (`server/telegram/`):
- **Role Inversion**: Telegram is an external communication channel adapter, yet core session management, directory isolation, and thread storage were located under `server/telegram/utils/`, causing Web and scheduler components to depend backwards on Telegram internal modules.
- **Bundle Pollution**: IM-specific dependencies (`grammy`, `telegramify-markdown`, `ffmpeg-static`) were included in the core bundle and root `package.json`.
- **Bypassed Middleware**: ADS maintains a structured `MiddlewarePipeline` for memory recall (`cfMemMiddleware`) and command safety guardrails (`globalRulesMiddleware`), but Telegram turns bypassed this pipeline by calling agent sessions directly in-process.
- **Scattered Notifiers**: Long-running task and scheduler completions relied on ad-hoc notifier functions scattered across business logic instead of standard lifecycle hooks.

## Decision

1. **Extract Standalone Connector**: Decouple the Telegram bot into an independent package located at `connectors/telegram/` with its own `package.json`, binary (`ads-telegram`), and runtime lifecycle. The connector communicates with ADS Core strictly via documented, supported REST and WebSocket APIs.
2. **Extract Core Session Primitives**: Move session and directory state primitives (`SessionManager`, `DirectoryManager`, `ThreadStorage`, `sessionState`, `sessionRuntimeRegistry`) into `server/sessions/`.
3. **Purge Core Dependencies and CLI Aliases**: Remove `grammy`, `telegramify-markdown`, and `ffmpeg-static` from root `package.json`. Remove the top-level `telegram` command and `ads-telegram` alias from `server/cli.ts`.
4. **Middleware-Driven Channel Propagation**: All turns originating from Telegram specify `channel: "telegram"` in prompt payloads and pass through `MiddlewarePipeline`, uniformly executing semantic memory recall (`cfMemMiddleware`) and command execution safety guardrails (`globalRulesMiddleware`).
5. **Hook-Based Task Notifications**: Replace ad-hoc notification calls in task/scheduler business logic with a transport-neutral `dispatchTaskTerminalEvent` dispatcher. Core broadcasts generic `task_terminal` events to authenticated WebSocket clients; the connector owns Telegram formatting and delivery.
6. **Decoupled Service Operation**: ADS Core runs independently via `ads-web.service`. The Telegram connector runs as an optional unit (`ads-telegram.service`). Core startup and runtime require zero Telegram environment variables or connector presence.

## Consequences

- ADS Core builds and runs without any Telegram packages or private channel imports.
- If the Telegram connector is absent or stopped, ADS Web and core scheduling remain 100% functional.
- All channels benefit from centralized security guardrails and memory pipelines without duplicated logic.
- Standalone connector dependencies and tests are isolated in `connectors/telegram/`.

## Verification

- Core builds with zero Telegram dependencies: `npm run lint`, `npm run build`, `npm test`, `npm run test:web` pass.
- Connector test suite (`connectors/telegram/tests/`) validates client WebSocket communication, MarkdownV2 rendering, chunking, and configuration.
- Middleware tests (`tests/middleware/`) prove channel propagation, memory injection, security blocking, and output/error delivery hooks.
- Absence tests (`tests/connectors/absence.test.ts`) verify that core boots and runs turns with zero Telegram configuration.
