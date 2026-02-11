---
name: spec-to-task
description: "Convert a finalized spec into an executable task (auto-enqueue by default, draft on request or when risk is high). Use when user says 转换成任务/开始执行/enqueue."
---

# Spec To Task

## Overview

Convert a finalized spec or discussion into a TaskBundle submission.

- **Default**: auto-enqueue (`autoApprove: true`) — task goes directly to the queue, skipping the draft panel.
- **Draft on request**: user explicitly asks for draft → `autoApprove` is omitted.
- **Draft forced**: high-risk or high-uncertainty detected → `autoApprove` is omitted, agent warns the user.

## Trigger

Use this skill when the user says:
- "convert to task" / "转换成任务"
- "start execution" / "开始执行"
- "enqueue" / "加入队列" / "入队执行"

## Mode Selection

| Condition | Mode | `autoApprove` |
|-----------|------|---------------|
| Normal conversion, no high-risk flags | Auto-enqueue | `true` |
| User says 草稿/落草稿/先落草稿/draft | Draft | omitted |
| High-risk or excessive uncertainty detected | Draft (forced) | omitted |

When forcing draft mode, explain to the user **why** it was degraded (e.g., "检测到涉及数据库 migration，已降级为草稿，请确认后手动批准").

## High-Risk / Uncertainty Flags (force Draft)

Scan the spec content and generated prompt for these indicators:
- **Destructive actions**: delete data, drop tables, rewrite git history, force push, irreversible migrations, `rm -rf`
- **Schema/protocol changes**: public API changes, database migration, storage schema, cross-service contracts, breaking changes
- **Security-sensitive**: auth, permissions, secrets, tokens, credentials, password handling, logging sensitive data
- **Underspecified**: spec contains `Open Questions`, `TODO`, `TBD`, `Assumption` markers that are unresolved, missing acceptance criteria, missing verification plan

If ANY flag matches → force draft mode.

## Single Task Rule

- Always produce exactly **one** task per bundle (`tasks` array length must be 1).
- If the implementation requires multiple steps, describe all steps inside that single task's `prompt` field using a numbered list or structured sections.
- Never split a requirement into multiple task objects.

## Spec Reference (SSOT)

- Always include `specRef` in the bundle, pointing to the spec directory (e.g. `docs/spec/20260211-auto-enqueue/`)
- The task prompt must include a `Spec Reference` line pointing to the spec path
- Spec is the single source of truth — the task prompt is a derived execution plan, not a replacement

## Idempotency

- Always use a stable `bundle.requestId` for a single logical conversion
- Output exactly one `ads-tasks` fenced block per conversion attempt
- If the request is ambiguous or high-risk, stop and ask clarifying questions instead of generating competing drafts

## Output Format

Produce exactly one fenced block:

````
```ads-tasks
{
  "version": 1,
  "autoApprove": true,
  "specRef": "docs/spec/yyyymmdd-slug/",
  "insertPosition": "back",
  "tasks": [
    {
      "title": "Short imperative title in English",
      "inheritContext": true,
      "prompt": "Goal:\n- ...\n\nSpec Reference:\n- docs/spec/yyyymmdd-slug/\n\nConstraints:\n- ...\n\nDeliverables:\n- ...\n\nAcceptance Criteria:\n- ...\n\nVerification:\n- npx tsc --noEmit\n- npm run lint\n- npm test"
    }
  ]
}
```
````

- For draft mode: omit `autoApprove` or set it to `false`
- For auto-enqueue mode: set `autoApprove: true`

## Prompt Structure (English-only)

The task prompt must contain these sections:
- **Goal**: what to achieve
- **Spec Reference**: path to spec directory (SSOT)
- **Constraints**: technical/compatibility constraints
- **Deliverables**: concrete outputs
- **Acceptance Criteria**: testable conditions for done
- **Verification**: commands to run (`npx tsc --noEmit`, `npm run lint`, `npm test`, etc.)

## After Output

- Auto-enqueue mode: tell the user "任务已提交，将直接入队执行"
- Draft mode (explicit): tell the user "任务草稿已创建，请在草稿面板中查看并批准"
- Draft mode (forced): tell the user WHY it was degraded and how to proceed
