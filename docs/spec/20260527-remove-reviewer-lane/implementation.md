# Implementation: Remove Reviewer Lane

## Steps

1. Remove reviewer lane from frontend runtime and UI.
2. Remove reviewer websocket routing, bootstrap payloads, snapshot binding, and reviewer prompt handling from web server runtime.
3. Remove review queue and review pipeline integration from task queue runtime.
4. Remove task review fields from active task API, frontend task types, task forms, task board display, and task stage helpers.
5. Delete reviewer-only tests and update shared tests to expect planner and worker lanes only.
6. Run verification commands and fix compile, lint, test, and build failures.

## Verification

Run:

- `npx tsc --noEmit`
- `npm run lint`
- `npm test`
- `npm run build`

Also run targeted searches:

- `rg -n "reviewer|reviewStore|reviewRequired|reviewStatus|reviewSnapshot" client server tests`

Expected result: active reviewer lane code is gone. Remaining matches are either legacy migrations, old spec docs, or bootstrap-review code that is not part of the web reviewer lane.
