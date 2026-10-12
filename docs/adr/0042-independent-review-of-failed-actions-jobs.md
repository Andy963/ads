# ADR 0042: Allow Independent Review of Failed Actions Jobs

## Status

Accepted — Issue #537

## Context

ADR 0040 keeps review and delivery tools within an active Developer execution so
that a review verdict cannot outlive the exact delivery authorization. A job
that ends in `failed` after operator dismissal has no active Developer turn,
but operators still need a way to inspect the committed result. Re-entering the
Developer workflow would retry work and could change the repository or job
lifecycle merely to obtain a read-only review.

## Decision

- Expose an authenticated, project-scoped operation for the selected `failed`
  job only. The existing Actions card supplies the selected job identifier;
  there is no manual identifier entry or standalone persistent control.
- Capture the persisted Issue and ADR snapshots, the job's recorded base commit,
  current head commit, diff, and any verification report already associated
  with that job. Reject incomplete evidence without returning an authoritative
  verdict.
- Invoke the configured enabled Reviewer role profile through the existing
  detached Reviewer execution primitive, without opening a Developer turn or
  using `actionTools`.
- Keep the operation read-only: do not change job status or review ledger,
  execute verification, start or retry Developer work, schedule rework, restart
  the queue, merge, or deploy.
- Persist and broadcast only the existing user-facing review summary, status,
  and defect details. Keep structured Reviewer protocol data and model reasoning
  internal.

## Consequences

Operators can request an independent assessment after dismissing a failed job
without reviving its execution. The review is informational and does not grant
delivery authority; a `PASS` cannot merge or transition the failed job. A later
Developer run, if desired, remains a separate explicit workflow.
