# Refactor Tracking

> Goal: Incrementally refactor the codebase for structure, extensibility, maintainability, and performance **without changing behavior**.
>
> This file is a living checklist. Each refactor iteration should:
> - Start from a branch synced to `origin/main` (or the latest locally available `origin/main` when offline)
> - Keep changes small and reviewable
> - Run `npx tsc --noEmit`, `npm run lint`, `npm test` (and `npm run build` when frontend changes)

## Status

- Branch: `dev` (keep changes small and reviewable)
- Last updated: 2026-02-23

## Reviewed Modules (read in detail)

- `src/web/server/startWebServer.ts` (server bootstrap, env flags, process behavior)
- `src/telegram/botSetup.ts` (telegram bot utilities)
- `src/telegram/utils/downloadUtils.ts` (shared telegram download helpers)
- `src/telegram/utils/fileHandler.ts` (telegram file download/upload helpers)
- `src/telegram/utils/imageHandler.ts` (telegram image download helper)
- `src/telegram/utils/urlHandler.ts` (URL extraction, safe download, SSRF guard)
- `src/utils/env.ts` (env loading behavior and side effects)
- `src/utils/flags.ts` (env flag parsing helpers)
- `src/utils/activityTracker.ts` (explored tracking, env-driven config)
- `src/agents/orchestrator.ts` (skill/prefs toggles, orchestration behavior)
- `src/agents/hub.ts` (coordinator config, env parsing)
- `src/systemPrompt/manager.ts` (reinjection config, prompt assembly)
- `src/agents/tasks/taskCoordinator/helpers.ts` (task coordinator helpers; env parsing)
- `src/agents/tasks/supervisorPrompt.ts` (supervisor prompt loader; env parsing)
- `src/skills/loader.ts` (skill discovery & loading; caching)
- `src/storage/database.ts` (sqlite open path, busy timeout parsing)
- `src/tasks/storeStatements.ts` (sqlite statements; message/conversation queries)
- `src/tasks/storeImpl/messageOps.ts` (task message persistence & ordering)
- `src/tasks/storeImpl/conversationOps.ts` (conversation message persistence & ordering)
- `src/tasks/executor.ts` (conversation history snippet for prompts)
- `src/web/server/ws/handleTaskResume.ts` (conversation history resume path)
- `web/src/api/types.ts` (web API types; Task shape)

## Candidates / Opportunities

### Code Structure

- Consolidate duplicated env flag parsing helpers into `src/utils/flags.ts` (DONE: `parseBooleanFlag`).
- Consolidate optional boolean env parsing helpers into `src/utils/flags.ts` (DONE: `parseOptionalBooleanFlag`).
- Consolidate positive int env parsing helpers into `src/utils/flags.ts` (DONE: `parsePositiveIntFlag`).
- Consolidate non-negative int env parsing helpers into `src/utils/flags.ts` (DONE: `parseNonNegativeIntFlag`).
- Standardize "resolve paths from state dir" helpers into a small set of utilities (avoid ad-hoc joins).

### Extensibility & Maintainability

- Reduce module-local utilities that are used across areas; prefer shared helpers under `src/utils/`.
- Introduce small, well-named types for frequently passed option bags (reduce `Record<string, unknown>`).
- Deduplicate Telegram download helpers (`createTimeoutSignal`, file naming, size formatting) into a shared module (DONE: `src/telegram/utils/downloadUtils.ts`).

### Performance

- Avoid repeated SKILL.md reads on hot paths (e.g. skill discovery); cache by `mtimeMs/size` with invalidation on change (DONE: `src/skills/loader.ts`).
- Prefer streaming where possible for large payloads (attachments/logs) instead of buffering whole files.
- Avoid `ORDER BY ... DESC LIMIT ...` + in-memory `reverse()` for "most recent N but return ASC" queries; prefer SQL subquery ordering (DONE: `src/tasks/storeStatements.ts`, `src/tasks/storeImpl/messageOps.ts`, `src/tasks/storeImpl/conversationOps.ts`).

## Not Yet Reviewed (high-level only)

### Backend (src/)

- `src/agents/*` (except `src/agents/orchestrator.ts`, `src/agents/hub.ts`, `src/agents/tasks/taskCoordinator/helpers.ts`, `src/agents/tasks/supervisorPrompt.ts`)
- `src/audio/*`
- `src/bootstrap/*`
- `src/codex/*`
- `src/graph/*`
- `src/intake/*`
- `src/memory/*`
- `src/skills/*` (except `loader.ts`)
- `src/state/*`
- `src/storage/*` (except `database.ts`)
- `src/systemPrompt/*`
- `src/tasks/*` (except `src/tasks/storeStatements.ts`, `src/tasks/storeImpl/messageOps.ts`, `src/tasks/storeImpl/conversationOps.ts`, `src/tasks/executor.ts`)
- `src/telegram/*` (except `botSetup.ts`, `utils/downloadUtils.ts`, `utils/fileHandler.ts`, `utils/imageHandler.ts`, `utils/urlHandler.ts`)
- `src/types/*`
- `src/utils/*` (except any files touched by refactors)
- `src/web/*` (except `src/web/server/startWebServer.ts`, `src/web/server/ws/handleTaskResume.ts`)
- `src/workflow/*`
- `src/workspace/*`

### Frontend (web/)

- `web/*` (except `web/src/api/types.ts`)
