# Implementation plan

## Storage + types

1. `src/storage/migrations.ts`
   - Add migration version for `schedules` + `schedule_runs`.
2. `src/scheduler/scheduleSpec.ts`
   - Define `ScheduleSpec` zod schema + TypeScript types.
3. `src/scheduler/cron.ts`
   - Parse supported cron subset and compute `next_run_at` with timezone.
4. `src/scheduler/store.ts`
   - CRUD for schedules/runs + due selection + lease claim + reconcile.

## Compiler (compile-on-create)

1. `src/scheduler/compiler.ts`
   - Invoke agent with `$scheduler-compile`.
   - Extract exactly one fenced `json` block; parse + validate (zod).
   - Bounded retries on parse/validation failure.
   - Normalize: enforce `instruction` verbatim, downgrade unsupported cron to `enabled=false` + `questions`.

## Runtime scheduler

1. `src/scheduler/runtime.ts`
   - Interval tick loop; per workspace:
     - reconcile non-terminal runs via `tasks` table
     - trigger due schedules with lease + `external_id` idempotency
     - enqueue tasks using `compiledTask.prompt` only
     - advance `next_run_at`
2. `src/web/server/startWebServer.ts`
   - Instantiate and start `SchedulerRuntime`.
   - Pass compiler + scheduler into API deps.

## API

1. `src/web/server/api/handler.ts`
   - Wire schedule routes.
2. `src/web/server/api/routes/schedules.ts`
   - Implement endpoints:
     - `POST /api/schedules`
     - `PATCH /api/schedules/:id`
     - `POST /api/schedules/:id/enable`
     - `POST /api/schedules/:id/disable`
     - `GET /api/schedules`
     - `GET /api/schedules/:id/runs`

## Tests

- `tests/scheduler/schedulerStore.test.ts`:
  - create schedule, compute `next_run_at`, insert run idempotency (`external_id` uniqueness).
- `tests/web/schedulesRoute.test.ts`:
  - create/list/enable/disable + list runs (compiler stubbed).

## Verification commands

```bash
npx tsc --noEmit
npm run lint
npm test
```

