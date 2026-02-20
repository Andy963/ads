---
name: tg-task-status
description: "Get current running/planning/queued tasks for the current workspace and format a Telegram-friendly status report."
---

# TG Task Status
## Overview
This skill provides a deterministic way to inspect task execution status from a Telegram chat context.
It reports:
- Running / planning tasks (currently executing)
- Queued / pending tasks (waiting)
- Optional recent failures

It prefers the Web API when available, and falls back to querying the local SQLite database (`ads.db`) in the workspace.

## Preconditions
- You have access to the workspace filesystem (read-only is sufficient).
- Optionally, the ADS web server is running on `http://127.0.0.1:8787` (preferred path).

## Inputs
- Optional: `workspaceRoot` (absolute path). If omitted, use `AD_WORKSPACE` (if set), otherwise use the current working directory.
- Optional: `limit` (default 10; max 50).

## Decision Flow
1) Prefer Web API (fast, canonical):
- Base URL: `http://127.0.0.1:8787`
- Probe availability by requesting (no auth assumed):
  - `GET /api/tasks?status=running&limit=1`
- If the probe returns HTTP 200 and a JSON array, use the API for all sections:
  - `GET /api/tasks?status=running`
  - `GET /api/tasks?status=planning`
  - `GET /api/tasks?status=queued`
  - `GET /api/tasks?status=pending`
  - Optional failures: `GET /api/tasks?status=failed`
- If `workspaceRoot` is provided and you need a non-default workspace, include `workspace=<absolutePath>` as a query parameter (URL-encoded).

2) Fallback to SQLite (when API is unavailable or returns non-JSON / non-200):
- Locate `ads.db` deterministically (first match wins):
  1. `ADS_DATABASE_PATH` or `DATABASE_URL` (strip leading `sqlite://`).
  2. `<workspaceRoot>/ads.db`
  3. `<workspaceRoot>/.ads/ads.db` (legacy layout)
  4. If `ADS_STATE_DIR` is set: search `"$ADS_STATE_DIR"/workspaces/*/ads.db` and use it only if exactly one match exists.
  5. If `<workspaceRoot>/.ads/workspaces/*/ads.db` exists: use it only if exactly one match exists.
- If no unambiguous DB path is found, stop and ask the user for the exact DB path.
- Query `tasks` with `archived_at IS NULL` only.

## Output (STRICT)
Return a short Telegram-friendly report in plain text with these sections (omit empty sections):
- `Active (<n>)` (running + planning)
- `Waiting (<n>)` (queued + pending)
- `Recent failures (<n>)` (optional; failed only)

If all sections would be empty, return exactly:
- `No active or waiting tasks.`

For `<n>`, use the total count for that section before truncation.
Each task line MUST use this format (single line per task):
- `- <status> <id8> <title>`

Rules:
- `id8` = first 8 characters of `task.id`.
- `title` = `task.title` trimmed and collapsed whitespace; if empty, use `(no title)`.
- Sorting:
  - Active: `running` first, then `planning`; within each status: `startedAt DESC`, then `createdAt DESC`, then `id ASC`.
  - Waiting: `queued` first, then `pending`; within each status: `queuedAt ASC`, then `createdAt ASC`, then `id ASC`.
  - Recent failures: `failed` only; order by `completedAt DESC`, then `createdAt DESC`, then `id ASC`.
- Truncation:
  - Show at most `limit` tasks per section (cap `limit` at 50).
  - If a section has more than `limit`, append a final line: `... (+<n> more)`.

Do NOT include raw JSON dumps unless explicitly requested.

Example output:
```
Active (1)
- running 1a2b3c4d Fix scheduler lease

Waiting (2)
- queued 9f8e7d6c Add docs for tg-task-status
- pending 0a1b2c3d Investigate flaky test
```

## Suggested Commands (implementation hints for an agent)
Web API (probe):
- `curl -fsS --max-time 2 'http://127.0.0.1:8787/api/tasks?status=running&limit=1' >/dev/null`

SQLite (read-only via Node + better-sqlite3; replace `DB_PATH`):
```bash
node --input-type=module - <<'NODE'
import Database from "better-sqlite3";
const db = new Database(process.env.DB_PATH, { readonly: true, fileMustExist: true });
const rows = db.prepare(
  "SELECT id, title, status, queued_at, started_at, completed_at, created_at, archived_at, error FROM tasks WHERE archived_at IS NULL AND status IN ('running','planning','queued','pending','failed')"
).all();
console.log(rows.length);
NODE
```

## Error Handling
- If neither Web API nor `ads.db` is accessible, ask:
  1) Is the web server running?
  2) What is the workspace root?
  3) What is the exact `ads.db` path (or set `ADS_DATABASE_PATH`)?

## Notes
- Keep this skill read-only: never call mutating APIs and never write to the database.
