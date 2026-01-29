# ADR-0004: Order Task Prompt and Placeholder Messages

- Status: Accepted
- Date: 2026-01-29

## Context

Task chat 的目标是让用户在 Web 端看到“任务正在发生什么”，因此消息的**顺序**非常关键。

我们观察到两个容易误导用户的问题：

1. `task:started` 与任务的 `message(role=user)` 广播顺序不稳定时，UI 可能先看到“任务已开始”，再看到用户 prompt，造成上下文断裂。
2. 当任务在 `pending/planning/running` 期间只产生命令/step 输出而最终 `result` 很短甚至为空时，UI 的“thinking placeholder”容易卡住，或与 user 消息顺序混乱。

因此需要一个明确、可复用的规则来稳定排序，同时避免重复与占位符残留。

## Decision

1. 后端在广播 task start 时，先发送 `task:started`，再发送该 task 的 `message(role=user)`。
2. 前端在收到 task 的 `message(role=user)` 时：
   - 去重：如果同样的 user 文本已经存在，则忽略该条消息；
   - 若该 task 状态为 `pending/planning/running`，并且当前没有空的 streaming assistant 占位符，则在 user 消息之后插入一个空的 streaming assistant 占位符。
3. 当任务完成并携带 `task.result` 时：
   - 若 UI 已经在最近一次 user 消息之后展示过 assistant 文本，则不再重复追加 `task.result`。

## Consequences

- 正向：
  - user prompt 与 placeholder 的顺序稳定，阅读更符合直觉；
  - 避免 task start/消息广播顺序导致的“看起来像倒序”；
  - 避免 `task.result` 重复展示。

- 负向/风险：
  - “去重”逻辑基于文本内容，如果未来支持同一 prompt 多次重放，可能需要引入更强的 message id 或 sequence。

## Implementation Notes

- 后端：`src/web/taskStartBroadcast.ts`
- 前端：`web/src/App.vue` (`onTaskEvent`)

