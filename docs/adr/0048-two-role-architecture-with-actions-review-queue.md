# ADR 0048: Acopilot Implementation with an Actions Reviewer Queue

## Status

Accepted — 2026-10-31. This decision supersedes ADR 0040, ADR 0044, and ADR 0045, and replaces the in-session review retirement described by the previous draft of ADR 0048.

## Context

The two-role refactor correctly moved implementation ownership to Acopilot and kept Reviewer as a read-only role in the Actions lane, but it removed the Actions job queue and called the Reviewer runner directly from Acopilot. A Reviewer profile alone does not establish that review work runs through the Actions lane or appears in its queue and conversation.

Acopilot must retain ownership of Issue authoring, implementation, PR preparation, and rework. The Actions lane needs a durable, serialized entry point that runs only the Reviewer role and returns its exact-target result to both the Actions conversation and Acopilot.

## Decision

- Keep two lanes (`acopilot`, `actions`) and two active roles (`acopilot`, `reviewer`). Acopilot owns investigation, Issue authoring, implementation, verification, and PR preparation. The Actions lane owns queued PR review only; it must never run an implementation Developer.
- After preparing an Issue-backed PR, Acopilot calls `review_action`. The server captures the authenticated project, PR number and URL, Issue criteria, relevant ADRs, exact base/head commits, and selected Reviewer profile, then persists a `pull_request_review` job.
- Review jobs run serially per project. The Actions lane records job progress and verdicts in its queue and conversation. `review_action` waits for the queued result and returns the structured PASS/REJECT verdict to Acopilot so it can handle valid REJECT findings.
- The job runs the configured verification command before invoking the read-only Reviewer. The verification report, Issue/ADR snapshot, and exact base/head commits are stored with the job.
- The executor revalidates the PR target before and after verification and Reviewer execution. Target drift, incomplete evidence, verification failure, or Reviewer protocol errors produce an operational failure without an authoritative verdict. A verdict from one head/base never approves a later target.
- Reviewer inspection remains read-only and cannot change source files, branches, commits, Issues, or PRs. The verification command is a separate server-owned check, not a Reviewer tool.
- Acopilot handles REJECT findings, updates the PR, and dispatches a new review job. PASS does not authorize merging; delivery requires explicit user authorization.
- Preserve legacy action job history. The migration cancels unfinished legacy implementation jobs, extends the job kind for Reviewer work, and stores the verification report without deleting unrelated prompt or history records.

## Consequences

Acopilot keeps implementation context while review execution belongs to the Actions lane. Review status and evidence survive refreshes and are visible in the Actions queue and conversation; the initiating Acopilot call also receives the structured verdict. The queue is serialized per project, and a stale or incomplete job must be redispatched rather than treated as approval.
