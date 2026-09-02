# Issue: Prompt 执行失败或限流时用户消息气泡被回滚清空 (User Message Loss on Prompt Error)

## 1. 现象描述 (Symptom)

在 Web / PWA 界面中，当用户向 Worker 或其他 Agent 发送 prompt 时，如果后端执行失败（例如模型调用触发 `[rate_limit] API 请求频率过高，请稍后重试`、网络连接中断或 Agent 进程异常）：
- 用户的发送气泡在界面上瞬间消失；
- 界面只在顶部或者横幅弹出错误提示；
- 刷新或重新进入应用后，由于前端本地状态曾被回滚，用户无法在当前会话中看到自己刚才发送的具体指令。

## 2. 根因分析 (Root Cause)

在 `client/src/app/chat.ts` 的 `flushQueuedPrompts` 方法中：

```ts
// client/src/app/chat.ts:648
try {
  // ... 发送 prompt，先插入用户消息气泡
} catch {
  state.messages.value = messagesBeforeFlush; // 💥 关键错误：发生异常时，直接将消息视图回滚到了发送前
  state.busy.value = busyBeforeFlush;
  state.turnInFlight = turnInFlightBeforeFlush;
  state.turnHasPatch = turnHasPatchBeforeFlush;
  state.pendingAckClientMessageId = pendingAckBeforeFlush;
  // ...
}
```

- 前端在捕获到发送或执行失败后，简单粗暴地将 `state.messages.value` 还原为 `messagesBeforeFlush`；
- 这导致用户已经输入并发送的消息卡片被直接剔除；
- 虽然数据库持久化可能已经记录了该用户 prompt，但在客户端视图层面造成了“消息丢失”的严重负面体验。

## 3. 期望行为与决策 (Decisions & Expected Behavior)

1. **禁止回滚用户消息气泡**：
   - 发生错误时不重置 `state.messages.value = messagesBeforeFlush`；
   - 保留用户输入卡片在聊天列表中的位置。
2. **挂载错误与重试状态**：
   - 将错误信息与对应的消息卡片关联（或挂载在紧随其后的助手占位卡片上）；
   - 提供“重试（Retry）”操作，方便用户重新提交刚才失败的 prompt。

## 4. 约束与验收标准 (Acceptance Criteria)

- 当 WebSocket 报错、超时、后端返回 `ok: false` 或捕获到 rate-limit 错误时，发送的消息气泡依然稳定停留在消息流中。
- 刷新页面后重新拉取历史记录时，该条用户消息依然可见。
- 新增/更新前端测试，覆盖 prompt 发送失败时消息列表不被回滚的场景。
