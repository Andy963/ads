# ADR 0017: 退役 Live-Step 进度消息通道

## Status

Accepted

## Context

ADS 曾把 Codex reasoning summary、Native Runtime 工具叙述和 Actions 工作流状态统一映射为 `live-step` 文本。这个通道混合了模型内部推理、工具执行旁白和任务状态三类不同语义，导致不同 Provider 的可见行为不一致，并与结构化 command、file-change 和 job-status 消息重复。

ADR 0002 定义的流式阶段边界仍然有效，但其中“单卡片 live-step 进度块”的部分已不再符合当前产品契约。新一轮可见内容应只包含用户消息、可选的结构化执行活动和最终 assistant 回复。

## Decision

1. Codex App Server 不再把 `item/reasoning/summaryTextDelta` 转换为 `AgentEvent.liveStep`。
2. Native Runtime 不再为 read、search、patch、command 或 Actions dispatch 合成 live-step 文本；结构化 command 和 file-change 事件保持不变。
3. Actions lane 不再广播 `type: "step"`，验证、审查和执行状态继续通过 job-status、command、message 与持久化历史提供。
4. WebSocket handler 不再生成新的 `source: "step"` delta，客户端收到 legacy `type: "step"` 或 `source: "step"` 帧时必须忽略，不创建或更新 live-step card。
5. 协议类型继续容忍 `AgentEvent.liveStep`、`type: "step"` 和 `source: "step"`，以便旧会话数据可被安全解码。
6. 已持久化的 `id: "live-step"` 历史保留只读渲染兼容；新的 turn 不得创建、重新插入或覆盖该卡片。

## Consequences

- Provider 差异不再影响可见聊天契约。
- reasoning、plan、todo 和内部工具调用继续保持内部状态，不进入 assistant 文本。
- command、file-change、最终 assistant streaming、持久化与重连路径保持原能力。
- 客户端状态管理减少一类临时消息；legacy ID 和 wire union 仍需在迁移期保留。
