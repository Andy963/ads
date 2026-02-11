---
name: planner-add-task
description: "Planner helper: when user says 把这添加成一个任务, summarize recent chat into a single TaskBundle draft (prefer MCP tool; human-readable summary)."
---

# Planner Add Task

## 触发方式

当用户在 `planner` 对话里说「把这添加成一个任务」或类似表达时，执行本 skill。

## 目标

把“近期对话的最新上下文”为主的关键信息整理成 **一个**可执行任务，写入 TaskBundle 草稿（TaskBundle draft），并向用户返回 **可读的格式化摘要**（而不是直接返回难读的 JSON）。

- **优先**使用 MCP 工具：`ads_task_bundle_draft_upsert`
- **仅当工具不可用**时，才退回输出 `ads-tasks` / `ads-task-bundle` fenced code block（TaskBundle JSON）

## 关键规则

1. **上下文选择**
   - 以最近 3–6 个 turns 为主（尤其是用户最后两条消息）。
   - 若新消息与旧消息冲突，**以最新约束为准**，不要沿用过时假设。
   - 不要做无依据的推断（例如回退/多用户/复杂系统设计），除非用户明确要求。

2. **草稿写入方式**
   - 若 MCP 工具可用：调用 `ads_task_bundle_draft_upsert`，传入 `bundle`（TaskBundle JSON，`version=1` 且 `tasks[]` 至少 1 个，每个 task 至少有 `prompt`）。
   - 若 MCP 工具不可用：输出 **一个且仅一个** `ads-tasks` 或 `ads-task-bundle` code block（避免生成多个 draft），内容为 TaskBundle JSON。

3. **语言约束（很重要）**
   - TaskBundle 的 `title` / `prompt` 默认用 **English**（便于执行）。
   - 若退回到 `ads-tasks` code block：其中 JSON（包括 `title` / `prompt` 字符串）必须 **English-only**，不要出现中文字符。

4. **用户可读输出（必须）**
   - 无论是否使用工具，都要在最终回复中给出 **可读的格式化摘要**（中文），包含：
     - 总结：创建/更新了几个任务草稿；
     - 每个任务：标题（如有）+ prompt（按 Markdown 原样展示）。
   - 若同时需要输出 `ads-tasks` code block：把 JSON 放在回复末尾，摘要放在前面。

5. **任务 prompt 结构**
   - `prompt` 用 English，建议包含以下小节（可用 markdown bullets）：
     - `Goal`
     - `Context (recent)`
     - `Constraints`
     - `Deliverables`
     - `Acceptance Criteria`
     - `Verification (commands/tests)`
   - 若用户没有给出验证方式，至少给出与改动相关的最小验证命令（例如 `npm test` / `npx tsc --noEmit` / `npm run lint`）。

## 输出模板（示例）

```ads-tasks
{
  "version": 1,
  "insertPosition": "back",
  "tasks": [
    {
      "title": "TODO: Short imperative title",
      "inheritContext": true,
      "prompt": "Goal:\\n- TODO\\n\\nContext (recent):\\n- TODO\\n\\nConstraints:\\n- TODO\\n\\nDeliverables:\\n- TODO\\n\\nAcceptance Criteria:\\n- TODO\\n\\nVerification:\\n- TODO"
    }
  ]
}
```
