---
name: scheduler-compile
description: "Compile a natural-language scheduled job into a deterministic ScheduleSpec JSON for compile-on-create scheduling. Use when user asks 定时任务/cron/schedule/提醒/每天几点做什么."
---

# Scheduler Compile
## Overview
This skill compiles a natural-language scheduling instruction into a deterministic, reviewable `ScheduleSpec` JSON artifact.
It is designed for "compile on create": compile once when a schedule is created/edited; persist the compiled artifact; execute the compiled artifact on every trigger without re-interpreting the original instruction.

## Non-Goals
- Do not implement the scheduler runtime.
- Do not execute the job.
- Do not guess environment-specific paths, secrets, or external connectivity.

## Inputs
A single natural-language instruction (any language) that describes:
- What to do (job intent)
- When to run (cron/weekday/interval)
Optional:
- Timezone
- Delivery channels (web/telegram)
- Safety requirements (read-only vs write; network allow/deny)

## Output Contract (STRICT)
Return exactly ONE fenced `json` code block, and nothing else.

The JSON must follow the exact top-level field order below:
1. version
2. name
3. enabled
4. schedule
5. instruction
6. delivery
7. policy
8. compiledTask
9. questions

## ScheduleSpec Schema (v1)
```json
{
  "version": 1,
  "name": "kebab-case-stable-name",
  "enabled": true,
  "schedule": {
    "type": "cron",
    "cron": "0 9 * * *",
    "timezone": "Asia/Shanghai"
  },
  "instruction": "verbatim original instruction",
  "delivery": {
    "channels": ["web"],
    "web": { "audience": "owner" },
    "telegram": { "chatId": null }
  },
  "policy": {
    "workspaceWrite": false,
    "network": "deny",
    "maxDurationMs": 600000,
    "maxRetries": 0,
    "concurrencyKey": "schedule:{scheduleId}",
    "idempotencyKeyTemplate": "sch:{scheduleId}:{runAtIso}"
  },
  "compiledTask": {
    "title": "Imperative English title",
    "prompt": "English-only deterministic prompt...\n",
    "expectedResultSchema": {
      "type": "object",
      "required": ["status", "summary", "outputs"],
      "properties": {
        "status": { "type": "string", "enum": ["ok", "warning", "error"] },
        "summary": { "type": "string" },
        "outputs": {
          "type": "object",
          "properties": {
            "web": { "type": "object" },
            "telegram": { "type": "object" }
          }
        }
      }
    },
    "verification": {
      "commands": []
    }
  },
  "questions": []
}
```

## Determinism Rules
- Never include current date/time, relative words (today/tomorrow), or execution environment guesses.
- Convert relative schedules into explicit cron/interval. If ambiguous, set `enabled=false` and add questions.
- `name` must be stable and derived from the intent, not the time.
- `instruction` must be the verbatim original user instruction, unchanged.
- Keep `compiledTask.title` and `compiledTask.prompt` in English-only.

## Schedule Normalization Rules
1) Prefer `schedule.type = "cron"` whenever the intent fits.
2) Use 5-field cron: "min hour dom mon dow".
3) If the instruction specifies:
- Daily at HH:MM -> "MM HH * * *"
- Weekdays at HH:MM -> "MM HH * * 1-5"
- Weekly on Mon at HH:MM -> "MM HH * * 1"
- Every N minutes -> use cron only when N is a divisor of 60; otherwise set `enabled=false` with a question, or require an interval-capable runtime.
4) Timezone:
- If explicitly provided, use it.
- If not provided, set `enabled=false` and ask which timezone to use.

## Delivery Rules
- `delivery.channels` must be explicit.
- If the instruction mentions telegram/tg, include "telegram" in channels and require `telegram.chatId` unless an "owner default" mechanism exists.
- If delivery is not mentioned, default to `["web"]` and keep telegram disabled.

## Safety / Policy Rules
Default to conservative:
- `policy.workspaceWrite = false`
- `policy.network = "deny"`
- `policy.maxRetries = 0`
Only relax if the instruction explicitly requires it AND it is low-risk.
If the instruction implies irreversible side effects (deletion, payments, production writes):
- Force `enabled = false`
- Keep conservative policy
- Add questions to request confirmation and exact scope.

## compiledTask.prompt Requirements (English-only)
The prompt MUST include:
1) Idempotency:
- Mention `policy.idempotencyKeyTemplate` and require idempotent behavior for the same key.
2) Allowed actions:
- State allowed/denied: workspace write, network.
3) Inputs available:
- Declare what context is available (e.g., logs paths) only if explicitly provided; otherwise instruct to ask or fail gracefully.
4) Output format:
- Require a single JSON result matching `compiledTask.expectedResultSchema`.
5) Delivery shaping:
- Instruct how to produce `outputs.web` and/or `outputs.telegram` payloads (content-only), leaving the actual sending to the scheduler/notification system.

Recommended prompt skeleton:
- Title line
- "Constraints" section (idempotency, no writes, no network)
- "Steps" section (deterministic steps)
- "Output" section (JSON schema)

## Questions Handling
If required info is missing:
- Still output a best-effort `ScheduleSpec`
- Set `enabled = false`
- Populate `questions` with 1-3 concrete questions

Common missing info:
- Exact time / cadence
- Timezone
- Telegram chatId binding or delivery preference

## Example Output
```json
{
  "version": 1,
  "name": "daily-error-report",
  "enabled": false,
  "schedule": { "type": "cron", "cron": "0 9 * * *", "timezone": "UTC" },
  "instruction": "Every day at 09:00, summarize yesterday's error logs and post to TG.",
  "delivery": { "channels": ["telegram"], "web": { "audience": "owner" }, "telegram": { "chatId": null } },
  "policy": {
    "workspaceWrite": false,
    "network": "deny",
    "maxDurationMs": 600000,
    "maxRetries": 0,
    "concurrencyKey": "schedule:{scheduleId}",
    "idempotencyKeyTemplate": "sch:{scheduleId}:{runAtIso}"
  },
  "compiledTask": {
    "title": "Summarize error logs and produce a telegram-ready report",
    "prompt": "You are executing a scheduled job.\n\nConstraints:\n- Idempotency key: sch:{scheduleId}:{runAtIso}. Do not perform duplicate side effects for the same key.\n- Workspace writes: forbidden.\n- Network: forbidden.\n- If required inputs (log locations) are not available, return status=error with a clear summary.\n\nSteps:\n1) Locate error logs only if an explicit path is provided in context; otherwise do not guess paths.\n2) Summarize key error patterns and counts.\n3) Produce a concise report.\n\nOutput:\nReturn a single JSON object with fields: status, summary, outputs.\n- outputs.telegram: include {\"text\": \"...\"}.\n",
    "expectedResultSchema": {
      "type": "object",
      "required": ["status", "summary", "outputs"],
      "properties": {
        "status": { "type": "string", "enum": ["ok", "warning", "error"] },
        "summary": { "type": "string" },
        "outputs": { "type": "object", "properties": { "telegram": { "type": "object" }, "web": { "type": "object" } } }
      }
    },
    "verification": { "commands": [] }
  },
  "questions": ["Which timezone should be used?", "What telegram chatId should receive the report?", "Where are the error logs located (exact path/pattern)?"]
}
```
