# Refactor Tracking

> Goal: Incrementally refactor the codebase for structure, extensibility, maintainability, and performance **without changing behavior**.
>
> This file is a living checklist. Each refactor iteration should:
> - Start from a branch synced to `origin/main` (or the latest locally available `origin/main` when offline)
> - Keep changes small and reviewable
> - Run `npx tsc --noEmit`, `npm run lint`, `npm test` (and `npm run build` when frontend changes)

## Status

- Branch: `refactor/*` (work happens in small PRs)
- Last updated: 2026-02-22

## Reviewed Modules (read in detail)

- `src/web/server/startWebServer.ts` (server bootstrap, env flags, process behavior)
- `src/telegram/botSetup.ts` (telegram bot utilities)
- `src/utils/env.ts` (env loading behavior and side effects)
- `src/utils/flags.ts` (env flag parsing helpers)

## Candidates / Opportunities

### Code Structure

- Consolidate duplicated env flag parsing helpers into `src/utils/flags.ts` (DONE: `parseBooleanFlag`).
- Standardize "resolve paths from state dir" helpers into a small set of utilities (avoid ad-hoc joins).

### Extensibility & Maintainability

- Reduce module-local utilities that are used across areas; prefer shared helpers under `src/utils/`.
- Introduce small, well-named types for frequently passed option bags (reduce `Record<string, unknown>`).

### Performance

- Avoid repeated filesystem scans on hot paths (e.g. skill discovery); add caching with explicit invalidation.
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
- `src/skills/*`
- `src/state/*`
- `src/storage/*`
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
