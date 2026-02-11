---
name: spec-to-task
description: "Convert a finalized spec into an executable task (enqueue by default, draft on request or when risk is high)."
---

# Spec To Task

### Overview
Convert a finalized spec/discussion into an actionable task submission.

Default behavior:
- Queue mode: create tasks intended for execution (queued after approval/enqueue).

Optional behavior:
- Draft mode: create a TaskBundle draft only (no enqueue) when the user explicitly asks for draft.

Safety behavior:
- Force Draft mode when risk or uncertainty is high.

### Trigger (chat intent)
Use this skill when the user says:
- "convert to task" / "转换成任务"
- "start execution" / "开始执行"
- "enqueue" / "加入队列"

### Mode Selection
- Queue (default): user requests conversion AND no high-risk flags AND no blocking open questions.
- Draft (explicit): user requests draft (草稿/落草稿/先落草稿/draft).
- Draft (forced): any high-risk or excessive uncertainty.

### High-Risk / Uncertainty Flags (force Draft)
- Destructive actions: deleting data, dropping tables, rewriting history, force push, irreversible migrations.
- Persistent format/protocol changes: public API, storage schema, cross-service contracts.
- Security/privacy sensitive changes: auth/permissions/secrets/logging sensitive data.
- Underspecified requirements / missing acceptance criteria / missing verification plan.

### Idempotency (avoid duplicate drafts)
- Always use a stable `bundle.requestId` for a single logical conversion, and reuse the same `requestId` across retries.
- Output exactly one `ads-tasks` fenced block for a single conversion attempt.
- If the request is ambiguous or high-risk, stop and ask clarifying questions instead of generating multiple competing drafts.

### Output / Submission
- Draft mode: produce the `ads-tasks` block only.
- Queue mode: produce the `ads-tasks` block and explicitly instruct the user to approve/enqueue it in the ADS UI (TaskBundle drafts panel).

### Prompt Structure (English-only)
- Goal
- Spec Reference (SSOT)
- Constraints
- Deliverables
- Acceptance Criteria
- Verification
