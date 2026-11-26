# ADR 0052: Review Queue Execution Is Leased Per Project

## Status

Accepted — Issue #623

## Context

`LaneDispatchBus` is an in-process coordinator, but its job rows and serialized review queue live in a shared SQLite database. The in-process maps prevent duplicate work only inside one Node process. A second process opening the same `state.db` can claim a different queued review for the same project and run it concurrently. It can also call `failInterruptedReviewJobs` and mark another process's live `verifying` or `reviewing` job as failed because its own local queue is empty.

The per-job claim `UPDATE ... WHERE id = ? AND status = 'queued'` prevents the same row from running twice. It does not establish ownership of the project review queue.

## Decision

Add a `review_queue_leases` table keyed by `project_id`. Each bus instance has a unique worker id. Before processing a project queue, the bus atomically acquires or renews the project lease with a time-to-live. A successful owner renews the lease on a heartbeat while verification or Reviewer execution is running. A second process fails to acquire the lease and returns without claiming or failing any job.

`failInterruptedReviewJobs` runs only after this process owns the lease. It therefore recovers jobs left by a crashed or expired owner without touching a live worker. The lease is released in a `finally` block when the queue exits. An expired lease can be reclaimed by any process.

The lane bus remains in-process within each Node process. The lease is a SQLite coordination layer for the shared project queue, not an external message queue.

## Consequences

Two processes can open the same database without running the same project review queue concurrently or failing each other's live jobs. A crashed process leaves a lease that expires, after which another process can recover interrupted jobs.

Only one worker processes a project's review queue at a time. The lease has a finite TTL, so a process that loses its lease due to a stalled event loop may continue the current Reviewer call until the next ownership check; duplicate execution is bounded by the TTL and by the per-job claim. A future exactly-once design would need a different execution model.
