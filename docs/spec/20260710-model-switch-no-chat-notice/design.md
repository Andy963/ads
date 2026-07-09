# 模型切换不写入聊天记录设计

## 服务端职责

模型切换由 `applySessionOverrides` 处理。该函数继续负责：

1. 解析 prompt payload 中的模型字段。
2. 比较当前用户模型和目标模型。
3. 调用 `sessionManager.setUserModel` 更新模型。
4. 为当前 orchestrator 应用模型配置。
5. 更新 reasoning effort。

该函数不再为模型切换返回 `notice`。调用方仍可从 `sessionManager.getEffectiveState` 得到最终模型，并放入 prompt result 的 `effectiveModel` 字段。

## 历史边界

`handlePromptMessage` 只把 `agentNotice` 合成为 `overrideNotice`。模型切换不参与 `overrideNotice`，因此不会：

1. 出现在 result payload 的 `notice` 字段中。
2. 被写入 `HistoryStore` 的 status entry。
3. 在重连 bootstrap 中作为历史消息回放。

## 保留行为

代理切换提示继续保留，因为它会改变执行主体，不属于本次用户反馈的模型选择器重复展示问题。

## 测试策略

1. 更新 `tests/web/sessionOverrides.test.ts`，确认模型变化时返回值没有 notice，但仍调用 `setUserModel` 和 reasoning effort 更新。
2. 更新 WebSocket prompt 测试，确认模型切换后聊天 result 无 notice，历史记录没有 status entry。
