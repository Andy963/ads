# ADR 0051: Review Jobs Are Superseded When Their Pinned Head Is Replaced

## Status

Accepted — Issue #623

## Context

`dispatchReviewJob` cannot know a pull request's base and head at enqueue time. It creates a queued row and `executeQueuedReview` pins the exact target later. As a result, `action_jobs` can accumulate completed and failed review jobs for several historical heads of the same pull request. The rows have no explicit invalidated state.

The current Actions queue only renders active statuses, so older terminal jobs are not visible there today. Any audit view or verdict resolver that reads `getActionJobs` still sees them. More importantly, an older job that is still running when a newer head is pinned can publish a stale verdict comment and wake Acopilot after the newer review has already started.

## Decision

Add nullable `superseded_at` and `superseded_by_job_id` columns to `action_jobs`. When `executeQueuedReview` resolves and pins a target, it supersedes other non-cancelled review jobs for the same PR, or for the same branch when no PR number is available, whose pinned head differs from the new head. Jobs with no pinned head are also superseded because they cannot prove which commit they belong to. Jobs for the same head are left unchanged so retries remain auditable.

Supersession is a separate lifecycle dimension, not a new `status` value. Terminal old jobs keep their status and gain the supersession marker. Active old jobs become `cancelled` and receive the marker. The new job id is stored in `superseded_by_job_id`.

Superseded jobs are excluded from queue selection, atomic claim, and interrupted-job recovery. A review that is superseded while running checks the marker before publishing its verdict; it records a superseded message in the Actions lane but writes no Issue comment and emits no `review_verdict_ready` event.

## Consequences

Historical review rows remain available for audit while currentness is explicit. A new head cannot inherit an old verdict through the job table. Same-head retries still produce multiple rows and remain distinguishable by job id and timestamps.

The check is based on the pinned head, not on a mutable local branch. That is the only head that can be compared with the review target. Wake events carry the pinned head sha so the Acopilot prompt can compare a verdict with the current PR head. This ADR does not add a programmatic verdict-consumption gate; the Issue comment remains the authoritative record.
