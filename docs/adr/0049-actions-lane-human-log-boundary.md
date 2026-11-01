# ADR 0049: Actions Lane Presents a Human Review Log

## Status

Accepted — Issue #601

## Context

The Actions lane is the person-facing view of the review pipeline. Two channels had been conflated there.

The Reviewer role's model output is a machine protocol: a standalone PASS/REJECT JSON document that `parseReviewVerdict` consumes for job status and Acopilot rework. The same role profile prompt is also the Actions lane's interactive system prompt, so a prompt typed in that lane produced exactly that document, which the WebSocket handler streamed token by token, persisted, and rendered as an assistant bubble.

The lane also showed almost nothing about how a review was produced. Queued review jobs recorded only milestone lines; verification output and Reviewer inspection steps were discarded after the command completed.

## Decision

- The Actions lane is a human log. Reviewer protocol JSON never reaches it as text.
- Interactive Actions-lane turns withhold assistant frames whose text opens as a protocol document, a bare JSON object or a fenced block. Ordinary prose still streams. When the turn completes, `server/reviewer/verdictPresentation.ts` parses a standalone verdict and renders status, summary, and one line per finding. Anything that is not a verdict is shown unchanged.
- The rendered text is what `historyStore` persists and what the client receives; the protocol document remains only in the job record (`review_verdicts_json`) for Acopilot and delivery decisions.
- Review execution streams into the lane as it happens: verification stdout/stderr lines (bounded, with an explicit truncation line) and one line per Reviewer inspection tool call. These entries go through the same `recordActionMessage` path as job milestones, so they are broadcast and persisted together.
- The queue completion message reuses the same formatter, so both delivery paths read identically.
- The Reviewer system prompt is unchanged. `parseReviewVerdict` accepts only a standalone document, so asking the model to add prose would break detached review.

## Consequences

The Actions lane shows review activity and a readable verdict instead of internal protocol output. Protocol-shaped answers appear when the turn completes rather than streaming word by word; ordinary answers and lane status lines stream as before.

Verdict formatting lives in one module shared by the interactive lane and the review queue, so a future change to the verdict schema updates both. Log streaming is bounded per review so a noisy verification command cannot flood lane history.
