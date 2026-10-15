# ADR 0044: Separate Reviewer Capability from Actions Job Ownership

## Status

Accepted — Issue #578

## Context

The clean-room Reviewer is a capability of the Actions Developer lifecycle, but
its previous entry point was created only while an `action_jobs` row was being
executed. An authenticated Developer working directly in the Actions WebSocket
lane therefore could not receive `review_action` or `deliver_action`, even when
the Developer had prepared a feature branch and pull request.

The queue job remains the owner of queue status, retry history, and lane
delivery. Those concerns must not become a requirement for a one-shot review
of an interactive feature branch. At the same time, exposing a generic review
operation would allow a model to redirect review or delivery to an arbitrary
workspace, user, branch, Issue, or pull request.

## Decision

- Reviewer evidence capture is implemented as a reusable service accepting an
  immutable Issue/ADR snapshot, verified base/head commits, diff, and test
  report. Queue jobs and interactive sessions use this same capture path.
- The Actions WebSocket lane may receive supervised action tools only after the
  server verifies the authenticated project mapping, `codex/issue-<id>` branch,
  clean tracked workspace, `dev` ancestry, matching open pull request, exact
  base/head SHAs, and complete GitHub Issue evidence.
- Interactive review state is held only by the active parent turn. A PASS
  authorizes delivery for that exact target; re-reading the target before
  delivery invalidates the authorization when any identity or commit changes.
- The interactive HTTP review route is read-only and receives branch/PR hints
  only as claims to validate. It does not create an Actions job or grant
  delivery authority.
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
