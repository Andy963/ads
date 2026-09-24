# ADR 0015: Preserve Action Jobs Across Recoverable Failures

## Status

Accepted

## Context

The Actions queue originally treated Developer execution failures, verification failures, Reviewer rejection, pull-request creation failures, and merge failures as terminal outcomes. Terminal failures released the queue slot and allowed the next job to start, even though the failed job had not produced its requested delivery.

Reviewer rejection had a separate bounded retry path, but the retry budget was not persisted and other failure stages could not recover. This made the queue outcome depend on the failure boundary instead of the task outcome. It also allowed a later job to hide an earlier incomplete task from the active-job UI.

## Decision

The Action job state machine uses one recoverable-failure contract for Developer execution, Verification, Reviewer execution or rejection, PR creation, and merge or delivery.

- A recoverable failure returns the same job to Developer rework with the original issue context and feature branch.
- `rework_count` is persisted in `action_jobs` and is shared by all recoverable failure stages.
- Two rework attempts are allowed. A third recoverable failure transitions the job to `blocked` with the failed stage, error context, and rework count visible in Actions history.
- A `blocked` job remains in the serial queue gate. It must be explicitly cancelled or otherwise resolved before another queued job can start.
- Successful rework resumes Verification, Reviewer, and PR delivery from the normal job cycle.
- Cancellation remains an explicit terminal operation and does not consume the rework budget.
- Action events are scoped to the project's configured Actions chat session and history key. Status updates carry the persisted job state so the Web UI can refresh without treating them as chat completion.

The durable schema adds `rework_count` and the `blocked` status while preserving existing queued, running, waiting-merge, completed, failed, and cancelled states.

## Consequences

- A recoverable failure no longer silently skips work or advances the queue.
- The same job and branch remain the unit of ownership through recovery, which simplifies audit history and branch cleanup.
- `blocked` is intentionally not automatically retried. A human must inspect the persisted failure context and decide whether to cancel, fix externally, or create a new job.
- Existing consumers of `action_jobs.status` must handle the additional `blocked` state and should display `rework_count` and `error_message` when present.
- The state migration rebuilds the `action_jobs` table to extend its status constraint; deployments must complete state migration before serving the new Web UI.
