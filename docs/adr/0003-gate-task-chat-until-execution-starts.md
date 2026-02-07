# ADR-0003: Gate Task Chat Until Execution Starts

- Status: Accepted
- Date: 2026-01-28

## Context

Web UI 里，“右侧对话框（MainChat）”承载的是 agent/任务执行过程的对话与增量输出，用来反映“正在发生什么”。

但在当前实现中，**创建任务（pending）** 会触发后端广播一条 `task:event: message`（role=user），前端收到后直接写入右侧对话列表，导致：

- 未执行的任务也污染对话记录，用户误以为任务已经开始；
- 当存在 streaming / live step 时，该条消息会被插入到对话列表的非预期位置（看起来像出现在顶部），破坏阅读顺序；
- 同一条内容在“任务创建”和“任务开始”两个阶段重复出现的风险增大。

我们需要一个明确、可维护且跨入口一致的规则：**没有执行时，永远不要把任务写入对话框；只有开始执行时，才允许进入对话列表**。

## Decision

在 Web 前端引入“任务对话门禁（task chat gating）”：

1. **任务创建（pending）阶段**：
   - 任何来自该 task 的 `task:event: message` 且 `role=user` 的事件，不直接写入右侧对话列表；
   - 这些事件会按 taskId 进入一个短期内存缓冲区（FIFO），等待任务进入执行阶段。

2. **任务进入执行阶段的判定**：
   - 一旦观察到该 task 的任意“已开始执行”信号（例如 `task:started` / `task:planned` / `task:running` / `step:*` / `command` / `message:delta` / `task:completed|failed|cancelled`），即认为该 task 的对话可以进入右侧对话列表。

3. **缓冲区回放（flush）**：
   - 任务被标记为 started 后，立即按原始顺序将缓存的事件回放到右侧对话列表（通过既有的 `pushMessageBeforeLive` / `finalizeAssistant` / `upsert*Delta` 等路径），保证顺序一致。

4. **边界约束（硬规则）**：
   - 未开始执行前，不允许把 task 的 prompt/用户消息写入右侧对话列表（避免“看起来在执行”的错觉）。

## Consequences

- 正向：
  - 右侧对话只展示“执行相关”的内容，语义清晰；
  - 避免了 streaming/live step 场景下的插入位置异常；
  - 规则集中在前端一处实现，便于 review 与长期演进。

- 负向/风险：
  - 如果未来引入“在 pending 状态下也允许对 task 发送 chat”的能力，这些 user 消息会被延迟展示；届时需要为该类消息新增显式标记或单独通道。

## Implementation Notes

- 位置：`web/src/app/tasks/events.ts`（`onTaskEvent`）
- 机制：`web/src/app/chat.ts` 为每个 project runtime 维护 `startedTaskIds` 与 `taskChatBufferByTaskId`，并在 `bufferTaskChatEvent` / `markTaskChatStarted` 中做门禁、缓冲与回放。
