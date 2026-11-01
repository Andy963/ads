# ADR 0049: Actions Lane Presents a Human Review Log

## Status

Accepted — Issue #601

## Context

The Actions lane is the person-facing view of the review pipeline. Two channels had been conflated there.

The Reviewer role's model output is a machine protocol: a standalone PASS/REJECT JSON document that `parseReviewVerdict` consumes for job status and Acopilot rework. The same role profile prompt is also the Actions lane's interactive system prompt, so a prompt typed in that lane produced exactly that document, which the WebSocket handler streamed token by token, persisted, and rendered as an assistant bubble.

The lane also showed almost nothing about how a review was produced. Queued review jobs recorded only milestone lines; verification output and Reviewer inspection steps were discarded after the command completed.

## Decision

- The Actions lane is a human log. Reviewer protocol JSON never reaches it as text.
- Interactive Actions-lane turns inspect the whole cumulative assistant item. When a bare JSON object or fenced block begins anywhere in the item, the handler stops streaming at that boundary. It keeps any preceding prose, renders a valid verdict as status, summary, and one line per finding, and replaces an invalid protocol candidate with a fixed rendering-error message. It discards the remaining protocol-bearing suffix. Raw protocol text never reaches the client or `historyStore`.
- The rendered text is what `historyStore` persists and what the client receives; the protocol document remains only in the job record (`review_verdicts_json`) for Acopilot and delivery decisions.
- Review execution streams into the lane as it happens: verification stdout/stderr lines (bounded, with an explicit truncation line) and one line per Reviewer inspection tool call. These entries go through the same `recordActionMessage` path as job milestones, so they are broadcast and persisted together.
- The queue completion message uses the Acopilot narration when available and the deterministic readable verdict only as a safe fallback. Interactive turns always use the deterministic renderer because they already occupy the Reviewer conversation.
- A completed queued review invokes the enabled Acopilot role profile's configured model without tools to turn the authoritative verdict into a user-facing explanation. The model output never affects the stored PASS or REJECT status. If that model is unavailable, incomplete, or returns protocol-shaped text, the lane uses the deterministic readable verdict instead.
- The Reviewer system prompt is unchanged. `parseReviewVerdict` accepts only a standalone document, so asking the model to add prose would break detached review.

## Consequences

The Actions lane shows review activity and a readable verdict instead of internal protocol output. A prose preface may stream until the protocol boundary, but the protocol itself appears only as a readable conclusion when the turn completes. Invalid protocol candidates remain hidden.

Verdict formatting and the model narration prompt live in one module, so the fallback and generated explanation remain bound to the same verdict schema. Verification keeps separate stdout and stderr line buffers and is bounded per review, preventing interleaved partial lines or noisy commands from corrupting lane history.
