# ADR 0061: Formalize Durable Agent Handoff Boundaries and Timeline Projections

## Status

Accepted - 2026-11-24. Refines ADR 0054 for the Rust server and Acopilot web client without changing the GitHub Issue verdict artifact contract or the TypeScript server.

## Context

ADR 0054 moved Reviewer-to-Acopilot handoffs out of the browser prompt path and into a durable `agent_messages` table. While that stabilized multi-tab replay and serialization with human turns, three boundary leaks remained in the Rust server and web client:

1. **Command storage mixed with model prompt text**: `enqueue_review_verdict_message` pre-rendered the full natural-language model prompt during enqueue and persisted it in `payload_json.text`. Model instructions, durable transport state, and UI card text were coupled in one string.
2. **Synthetic prompt-queue fabrication**: `AgentMessageService` dispatched turns by building a synthetic `PromptQueueEntry` with a negative ID (`id: -message.id`), and runners persisted that raw model prompt string directly into `history_entries`.
3. **Inbox state leaked into the conversation timeline**: `AgentMessageStore::list_for_lane` returned every row in the current `lane_generation` in descending order—including handoffs superseded before execution ever started (`status = 'superseded', attempts = 0`)—and `enqueue_review_verdict_message` also broadcast rows created directly in `superseded` state. Because those unstarted rows had no anchor in `history_entries`, the web client appended them via `pushMessageBeforeLive`, leaving stale expired cards pinned below newer conversation turns after every reconnect.

## Decision

Formalize four explicit internal boundaries across the Rust server and Acopilot client:

1. **Four-layer ownership**:
   - `ActionJob`: owns Actions review job lifecycle, pinned PR/head/base targets, and supersession.
   - `LaneMessage` / `history_entries`: owns the observable chronological lane timeline.
   - `AgentHandoff` (backed by `agent_messages`): owns durable cross-agent command transport, idempotency, leasing, retry, and supersession.
   - `PromptQueue` / `LaneTurn`: owns Acopilot turn scheduling and runner execution.

2. **Structured `AgentHandoff` payload and deferred prompt rendering**:
   - Persist `ReviewVerdictHandoff` structured metadata (verdict status, Issue/PR/branch/base/head SHAs, job correlation ID, and `ads:review-verdict` comment locator) in `agent_messages` (`schemaVersion: 2`) without pre-rendering `payload_json.text`.
   - Maintain backward-compatible reconstruction (`AgentHandoff::from_record`) for legacy pre-rendered rows already stored in SQLite.
   - Derive two separate projections from `AgentHandoff`:
     - `render_handoff_model_prompt`: rendered strictly at dispatch time immediately before runner execution.
     - `project_handoff_summary`: concise human-readable summary projected into `agent_message` / `agent_message_snapshot` wire frames and persisted as `history_display_text` when a turn actually starts.

3. **Unified `LaneTurn` execution contract**:
   - Introduce `LaneTurn`, `LaneTurnKey` (`PromptQueue(i64)`, `AgentHandoff(String)`, `Scheduler(String)`), and `LaneTurnKind` in `ads-runtime`.
   - `PromptQueueRunner`, `CodexAppServerPromptRunner`, `NativePromptRunner`, and `ActionToolsFactory` operate on `LaneTurn` directly, eliminating negative-ID synthetic `PromptQueueEntry` fabrication.
   - When `LaneTurn::history_display_text` is present, runners persist that clean UI summary into `history_entries` while sending `payload["text"]` (the dispatch-rendered model prompt) to the model.

4. **Projection visibility, ordering, and client Inbox vs Timeline separation**:
   - `AgentMessageStore::list_visible_for_lane` excludes never-executed superseded rows (`status = 'superseded' AND attempts = 0`) and returns the latest visible window in chronological order (`ORDER BY id ASC`).
   - `AgentMessageStore::enqueue` enforces review handoff eligibility at the persistence boundary: the correlated `pull_request_review` job must be terminal (`completed` or `failed`), not superseded (`superseded_at IS NULL`), and marked `agent_handoff_ready = 1` (set only after the authoritative `ads:review-verdict` comment is published or verified).
   - Never-executed `superseded` handoffs (`attempts = 0`) are never written to `sync_events` or broadcast as `agent_message` events—both when created directly in `superseded` state and when an unstarted `pending` handoff is later superseded across enqueue, reconciliation, worker polling, or stale-generation dispatch. When an active unstarted `pending` handoff is superseded, the server broadcasts a live unsequenced `agent_message_snapshot` so open clients clear it from their pending inbox without emitting dead `superseded` events.
   - In the Acopilot web client, unstarted `pending` handoffs live in a dedicated composer inbox slot (`pendingAgentHandoffs`) above the input rather than appending to the transcript. A handoff enters `rt.messages` only when execution begins (`running` / `delivered` / `failed`, or already anchored in `history`).
   - Unstarted `superseded` handoffs are removed from the pending inbox and never appended to `rt.messages`. Any unmatched non-superseded snapshot entry is inserted chronologically by timestamp rather than blindly appended below newer turns.

## Consequences

- `agent_messages` table compatibility and existing WebSocket event names (`agent_message`, `agent_message_snapshot`) are preserved.
- Prompt template updates automatically apply to pending or retried handoffs at dispatch time without mutating stored rows or leaking model instructions into chat history.
- Never-executed superseded handoffs can no longer pin stale expired cards below newer Acopilot conversations on live updates or reconnects.
- The TypeScript server remains untouched; all Rust-side execution and projection invariants are covered by `ads-state`, `ads-runtime`, `ads-http`, `ads-actions`, `ads-native`, and `client` unit tests.
