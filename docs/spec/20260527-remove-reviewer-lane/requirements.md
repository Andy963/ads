# Requirements: Remove Reviewer Lane

## Goal

ADS must no longer expose or run a dedicated reviewer lane. The web workflow keeps planner and worker lanes only. Task execution remains available, but review queue, reviewer chat continuity, reviewer snapshot binding, and reviewer-driven task gates are removed from the supported product surface.

## Functional Requirements

1. The frontend must not show a reviewer lane tab, reviewer composer, reviewer binding controls, review queue panel, review snapshot modal, or task review configuration controls.
2. The websocket server must not create or route a dedicated `reviewer` lane. Incoming `ads-chat.reviewer` connections must be treated as unsupported or fall back to the worker lane only if the existing chat-session resolver already normalizes unknown lanes that way.
3. The web server must not create reviewer session managers, reviewer history stores, reviewer workspace locks, reviewer broadcast paths, or reviewer snapshot bindings.
4. The task queue must not enqueue or run reviewer pipeline work after task completion.
5. Task create, update, duplicate, and board APIs must not accept review-only request fields as active inputs.
6. Existing database files must not be deleted or overwritten. Existing review tables and columns may remain as inert legacy schema to preserve backward compatibility with existing databases.
7. Bootstrap review gate code under `server/bootstrap/review/` is out of scope unless it is required by the web reviewer lane. Removing the web reviewer lane must not break unrelated bootstrap flows.

## Non-Requirements

1. No database migration is required to drop existing review tables or columns.
2. No data backfill or cleanup is required for existing review artifacts.
3. No replacement review workflow is introduced in this change.

## Acceptance Criteria

1. `npx tsc --noEmit` passes.
2. `npm run lint` passes.
3. Relevant backend and frontend tests pass.
4. `npm run build` passes because frontend code is changed.
5. Searching runtime code for reviewer lane entry points leaves only legacy documentation, database compatibility, or bootstrap-review references that are explicitly out of scope.
