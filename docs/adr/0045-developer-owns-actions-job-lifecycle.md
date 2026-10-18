# ADR 0045: Developer Owns the Complete Actions Job Lifecycle

## Status

Accepted — supersedes ADR 0043

## Context

ADR 0043 let Acopilot automatically take over blocked Actions jobs. That made
the Actions queue depend on a separate lane: a blocked job enqueued an
`action-takeover:<job>` prompt into the user's Acopilot conversation, and the
next Actions job could not start until that prompt finished. A busy or
interrupted Acopilot session therefore stalled Actions, and a single
incomplete Developer turn was enough to leave the Actions lane.

The same controller also reset the Developer provider thread before every
execution attempt. A continuation after a Reviewer rejection or an incomplete
turn could not resume the main-agent session, so the Developer lost the task
context it had already built.

## Decision

- Developer is the only main agent for an Actions job and owns it from queue
  start to a terminal state. Reviewer is a detached, read-only subagent invoked
  by the Developer through `review_action`; it is not a second lane owner.
- One job keeps one Developer provider session across Reviewer rejections and
  continuation turns. A provider thread is reset only when a different job
  starts in the lane or the lane is explicitly reset.
- A Reviewer `REJECT` returns its structured defects to the same Developer
  turn as a tool result. It does not create a new job, reset the Developer
  session, or enqueue a cross-lane prompt.
- An incomplete Developer turn returns control to the same Developer session
  as a bounded continuation. It is not classified as an infrastructure failure
  that blocks on the first attempt.
- Reviewer evidence remains a clean-room payload containing only the immutable
  Issue/ADR contract, the exact base/head diff, the test report, and related
  source context. Developer conversation history and intermediate reasoning are
  never forwarded to the Reviewer.
- Actions failures stay in the Actions lane. The blocked-job takeover path,
  its persistence, its `action-takeover:*` prompt identities, and the Acopilot
  recovery dispatch authority are removed.
- A blocked job remains visible as an Actions card, releases the workspace
  lock, and does not hold the FIFO queue. Dismiss remains the manual
  resolution path. Serial execution still requires the previous job to be
  terminal and the workspace to pass the checkout gate.
- Reviewer rejection and continuation attempts stay bounded. When the budget is
  exhausted the job blocks in the Actions lane with its failure evidence; it
  does not hand the conversation to Acopilot.

## Consequences

Actions progress no longer depends on Acopilot availability, and the Developer
keeps the context needed to repair its own work. Blocked jobs are resolved by
the operator instead of an automatic cross-lane recovery turn. The trade-off is
that a genuinely blocked job needs an explicit Dismiss or a new dispatch, and
continuation turns consume the same bounded rework budget as rejection-driven
rework.
