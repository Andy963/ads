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

### Performance

- Avoid repeated SKILL.md reads on hot paths (e.g. skill discovery); cache by `mtimeMs/size` with invalidation on change (DONE: `src/skills/loader.ts`).
- Prefer streaming where possible for large payloads (attachments/logs) instead of buffering whole files.

## Not Yet Reviewed (high-level only)

### Backend (src/)

- `src/agents/*`
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
- `src/tasks/*`
- `src/telegram/*` (except `botSetup.ts`)
- `src/types/*`
- `src/utils/*` (except any files touched by refactors)
- `src/web/*` (except `server/startWebServer.ts`)
- `src/workflow/*`
- `src/workspace/*`

### Frontend (web/)

- `web/*`
