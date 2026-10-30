# ADR 0044: Separate Reviewer Capability from Actions Job Ownership

## Status

Superseded by ADR 0048.

## Context

The clean-room Reviewer is a reusable capability of an authenticated Actions
Developer workspace, but its previous entry point was created only while an
`action_jobs` row was being executed. An interactive Developer therefore could
not review ordinary local changes before preparing a feature branch or pull
request.

The queue job remains the owner of queue status, retry history, and lane
delivery. Those concerns must not become a requirement for a one-shot review
of an interactive feature branch. At the same time, exposing a generic review
operation would allow a model to redirect review or delivery to an arbitrary
workspace, user, branch, Issue, or pull request.

## Decision

- Reviewer evidence capture is implemented as a reusable service accepting an
  immutable Issue/ADR snapshot, verified base/head commits, diff, and test
  report. Queue jobs and interactive sessions use this same capture path.
- The Actions WebSocket lane is the only interactive lane that may receive the
  supervised action tools. `review_action` validates only the authenticated
  project workspace and captures the committed plus working-tree diff with the
  current user request. It does not require an Actions job, Issue branch, clean
  worktree, or GitHub PR.
- A review that resolves a complete PR target may authorize `deliver_action`.
  Delivery still verifies the `codex/issue-<id>` branch, clean tracked
  workspace, `dev` ancestry, matching open PR, exact base/head SHAs, and
  complete GitHub Issue evidence. A local workspace review never grants
  delivery authority.
- Interactive review state is held only by the active parent turn. A delivery
  PASS authorizes the exact reviewed target; re-reading the target before
  delivery invalidates the authorization when any identity or commit changes.
- The interactive HTTP review route is read-only and receives branch/PR hints
  only as claims to validate. It does not create an Actions job or grant
  delivery authority.
- `review_action` and `deliver_action` are ADS built-in tools. Their schemas,
  argument validation, idempotency, and runtime bridges are shared by native
  and Codex app-server sessions; the lane-specific supervised capability is
  only the server-authorized execution context and is not a second tool
  protocol or a queue-job ownership requirement.
- Acopilot, Worker connector sessions, and ordinary non-Actions lanes do not
  receive the privileged tools. The existing queue supervision and failed-job
  review paths remain separate wrappers around the shared Reviewer capability.

## Consequences

Interactive Developers can complete the same independent review and controlled
delivery lifecycle without fabricating a Reviewer subagent or creating a
synthetic queue job. Queue behavior and failed-job recovery retain their
existing audit and lifecycle semantics. The trade-off is that interactive
review performs fresh local Git and GitHub metadata validation on every review
or delivery attempt, and the active WebSocket turn must remain alive while
the Reviewer runs.
