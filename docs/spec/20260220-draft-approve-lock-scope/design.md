# Design

## Root cause

Draft approve handler currently uses `taskCtx.lock.runExclusive(...)`. Task execution holds the same workspace lock for the full duration of `orchestrator.invokeAgent(...)`, so approval requests can block behind long-running executions.

## Approach

- Remove `taskCtx.lock.runExclusive(...)` from the approve handler so draft approval is decoupled from the executor lock.
- Keep the critical write path synchronous (no new `await`) to avoid interleaving partial state while tasks are being created and the draft is being marked approved.

## Idempotency & concurrency

- Task ids are derived deterministically from the draft (`draftId` + task index/externalId) via existing `normalizeCreateTaskInput(...)`, so repeated approvals converge to the same task ids.
- Draft approval uses a compare-and-swap update (`WHERE status='draft'`) in `approveTaskBundleDraft(...)`.

Flow:

1) Read draft:
   - If `status === "approved"`: return 200 with `approvedTaskIds` and do not trigger queue side effects.
2) Create queued tasks (create-or-get on duplicate id).
3) Mark draft approved:
   - If `approveTaskBundleDraft(...)` succeeds: this request owns the approval; if `runQueue=true`, trigger queue side effects.
   - If it returns `null`: re-read via `getTaskBundleDraft(...)`.
     - If draft is already `approved`: return 200 with `approvedTaskIds` and do not trigger queue side effects.
     - Otherwise: return a conflict error with the current status.

## Error handling

- Failures during task creation / attachment binding should continue to record `last_error` on the draft for UI visibility.
- Race conflicts should be reported clearly via HTTP response without retrying side effects.

