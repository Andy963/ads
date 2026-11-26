# ADR 0070: Refresh Model Controls for Explicit Failed-Turn Retries

## Status

Accepted — 2026-11-26. Supersedes the original-payload retry model-control decision in ADR 0034 while preserving its identity, scope, content, attachment, and deduplication decisions.

## Context

ADR 0034 correctly required an explicit failed-turn retry to restore the
server-side payload instead of reconstructing message text or attachments
from a failure card. That decision also required restoring the model controls
saved with the failed request. The latter prevents a user from selecting a
different model or reasoning effort before retrying a failed turn.

An explicit failure-card retry is a distinct user action from reconnect
recovery, an unsent-frame resend, or an automatic upstream retry. The explicit
action should preserve the failed turn's durable identity and original content
while allowing the currently selected lane controls to take effect.

## Decision

- `retryPrompt` keeps the failed turn's `clientMessageId` and requests
  `retry_original` with `replay_incomplete: true`. It does not recreate the
  message identity or rebuild text, images, or attachments from the failure
  card.
- The durable queue loads the failed row's original payload and preserves its
  text, images, attachments, agent, and other immutable fields. It may merge
  only non-empty string `model` and reasoning-effort controls supplied for the
  explicit retry.
- A lane model of `auto` is treated as no explicit override, so the failed
  execution model remains effective. Missing, blank, or non-string retry
  controls do not erase the saved controls. The payload hash is recalculated
  after a valid control merge.
- This override boundary applies only to an explicit retry of a failed turn.
  Reconnect recovery, unsent-frame resend, queued-prompt restoration, and
  automatic upstream retry continue to use the originally prepared wire
  payload without reading changed lane controls.
- Scope validation, terminal-state handling, identity deduplication, and
  completed-payload scrubbing from ADR 0034 remain unchanged.

The governing invariant is: **an explicit failed-turn retry may change only
the execution model controls; it must retain the original durable identity and
request content, while every non-explicit resend path must remain a replay of
the originally prepared payload.**

## Consequences

Users can retry a failed turn with the model and reasoning effort currently
selected for its lane without re-uploading attachments or creating a second
message identity. The retry may intentionally execute under different model
controls than the failed attempt, so model selection must be read from the
explicit retry boundary rather than inferred from historical failure text.

Reconnect and automatic retry behavior remains deterministic because those
paths retain the frozen prepared payload. The durable payload hash changes only
when a valid explicit retry control changes the effective payload, preserving
duplicate detection for all other fields and retry paths.
