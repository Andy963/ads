# ADR 0049: Actions Lane Presents a Human Review Log

## Status

Accepted — Issue #601; amended by Issue #606 and Issue #621

## Context

The Actions lane is the person-facing view of the review pipeline. Two channels had been conflated there.

The Reviewer role's model output is a machine protocol: a standalone PASS/REJECT JSON document that `parseReviewVerdict` consumes for job status and Acopilot rework. The same role profile prompt is also the Actions lane's interactive system prompt, so a prompt typed in that lane produced exactly that document, which the WebSocket handler streamed token by token, persisted, and rendered as an assistant bubble.

The lane also showed almost nothing about how a review was produced. Queued review jobs recorded only milestone lines; verification output and Reviewer inspection steps were discarded after the command completed.

Recording every Reviewer inspection call made the opposite mistake visible. Paginated searches emitted one entry per page with file ranges, offsets, and tool names, while completion messages identified the job by UUID and short commit SHA. Those values describe execution mechanics, but they do not tell a person which Issue or pull request is under review.

## Decision

- The Actions lane is a human log. Reviewer protocol JSON never reaches it as text.
- Interactive Actions-lane turns inspect the whole cumulative assistant item. They stop streaming only when a bare object or fenced block parses as a valid PASS/REJECT verdict. A partial JSON object or JSON-capable fence is held only until it can be classified, so a protocol document cannot leak before it is complete. Ordinary JSON, malformed verdict-shaped JSON, and non-JSON code fences continue unchanged. A valid verdict is rendered as status, summary, and one line per finding; raw protocol text never reaches the client or `historyStore`.
- The rendered text is what `historyStore` persists and what the client receives; the protocol document remains only in the job record (`review_verdicts_json`) for Acopilot and delivery decisions.
- Review execution records only human-level milestones in the lane: review started, one verification outcome, review complete or failed, and the readable verdict. Reviewer tool names, file ranges, pagination offsets, and per-call progress remain internal execution details and are not persisted or broadcast as Actions conversation messages.
- User-facing review messages identify the target by pull request number and stored Issue title. Job UUIDs and commit SHAs remain in `action_jobs`, the structured Issue verdict comment, and server logs; they are not part of the human conversation.
- A completed queued review immediately records a deterministic readable conclusion that identifies the human target, then may append a readable review summary asynchronously. This durable conclusion includes the canonical verdict and findings, so an interrupted narration cannot erase the review result from the Actions history. Interactive turns always use the deterministic renderer because they already occupy the Reviewer conversation.
- A completed queued review resolves the configured Acopilot model but invokes it with a dedicated narration system prompt and no tools. The narration is always followed by the deterministic readable verdict, so every finding remains visible even if the model omits it. The model output never affects the stored PASS or REJECT status. If that model is unavailable, times out, is incomplete, or returns protocol-shaped text, the lane uses only the deterministic readable verdict.
- The Reviewer system prompt is unchanged. `parseReviewVerdict` accepts only a standalone document, so asking the model to add prose would break detached review.

## Consequences

The Actions lane shows review milestones and a readable verdict instead of internal protocol output or tool-call telemetry. A prose preface may stream until the valid protocol boundary, but the protocol itself appears only as a readable conclusion when the turn completes. Non-verdict structured content remains visible.

Verdict formatting and the model narration prompt live in one module, so the fallback and generated explanation remain bound to the same verdict schema. Queue progress is not blocked by the narration request, and its durable completion entry remains available if the process stops before narration returns. Verification output is captured per stream and bounded per review. The full captured report remains available to the Reviewer and in the job record, while the lane shows only its human-readable outcome. Legacy `Reviewer step:` entries are filtered when history is rendered without deleting the stored records.
