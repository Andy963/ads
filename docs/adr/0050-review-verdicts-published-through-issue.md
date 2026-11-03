# ADR 0050: Review Verdicts Are Published Through the Issue, Not Through the Tool Call

## Status

Accepted — Issue #613

## Context

`review_action` used to await the entire review queue inside the Acopilot tool call. A single dispatcher call therefore occupied the Acopilot turn for verification plus Reviewer execution, up to about sixty minutes with the default timeouts. Every failure inside that window wrote `status = 'failed'` with an empty verdict, so Acopilot could not distinguish a code defect from a timed-out command, a drifted PR head, or a Reviewer protocol error.

The verdict also existed only in the transient tool result and in the Actions lane log. Neither is a reliable place for Acopilot to read later, and neither survives a reconnect bootstrap as a decision record.

`docs/acopilot-actions-spec.md` §2.5 and §5 already place job progress in the Actions lane and require operational failures not to masquerade as code defects. The implementation contradicted both.

## Decision

- `review_action` is an enqueue acknowledgement. It pins nothing at call time, returns `{ ok: true, jobId, status: "queued" }`, and returns control to the Acopilot turn immediately.
- The queue resolves the pinned target when the job reaches the front of the queue, runs verification as Reviewer evidence rather than as a gate, then runs the read-only Reviewer.
- Every terminal outcome is published as one structured comment on the backing GitHub Issue, tagged with `<!-- ads:review-verdict -->` and carrying the job id, PR number, base/head SHAs, status, summary, and findings. The service publishes it with the authenticated `gh` identity of the review workspace, so the Issue carries the same author as the rest of the Actions traffic.
- The Issue comment is the authoritative, durable verdict record. The Actions lane log stays a human-readable progress log and is not a decision record.
- Statuses are `PASS`, `REJECT`, `INCOMPLETE`, and `ERROR`. `ReviewerIncompleteError` (target drift, unpinned evidence, changed Issue or ADR snapshot) maps to `INCOMPLETE`. Genuine infrastructure crashes map to `ERROR`. Only a valid Reviewer REJECT means "fix the code".
- A durable sync event `review_verdict_ready` is appended to the Acopilot lane after the comment is published. It carries `{ issueId, prNumber, status, jobId, headSha }` and no verdict body. Losing the signal delays the follow-up turn; it never loses the verdict, because the comment is already on the Issue.
- The frontend treats the signal as a prompt source. An idle Acopilot lane enqueues the follow-up turn immediately; a busy lane queues it behind the running turn and shows a notice, so a review result never interrupts an in-progress conversation.
- Recoverable preconditions in `resolveInteractiveTarget` (head/base drift, missing acceptance criteria, unpublished PR) raise `ReviewerIncompleteError` with the concrete difference. Only unrecoverable failures keep raising plain errors.

## Consequences

The Acopilot loop becomes asynchronous end to end: dispatch, review, verdict, wake, rework. A slow or hanging verification command can no longer strand the Acopilot conversation, and every outcome leaves a permanent, quotable record on the Issue.

The cost is one extra GitHub write per review and a wake path that the frontend must handle idempotently. Duplicate signals for the same job are discarded by job id at both ends, and a replayed signal for an older head is rejected because the wake payload carries the head SHA it was published for.

The spec's earlier statement that the queue "returns the result to the issuing Acopilot call" is superseded; `docs/acopilot-actions-spec.md` is updated to describe the Issue comment plus wake event instead.
